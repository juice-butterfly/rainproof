#!/usr/bin/env node
/**
 * hook-watch —— 事件钩子：链上多一份保单，AI 层就自动做一次独立复核
 * ============================================================================
 *
 * 【它解决什么】
 *   合约里 buyPolicy() 只看链上条件，不看天气对不对。那谁来保证「这份保单是在一份
 *   可信的雨量基线上签的」？答案不该是运营方口头保证 —— 所以挂一个钩子：
 *   链上每出现一个 PolicyBought，AI 层就自动重做一遍独立复核，并留下带哈希的记录。
 *
 * 【它刻意不做的事】（诚实边界，答辩可以直接这么说）
 *   · 不改链上状态 —— 钩子没有权限，也不该有；它的产物是一份可复算的复核留痕
 *   · 不阻断投保 —— 保单在链上已经成立，它只回答「这次承保的证据成不成立」
 *   · 不代替判定 —— 「该不该赔」是判定层 `ai-judge.js`（R1–R5）的事，两者分工不同：
 *       本钩子管「承保时的基线可不可信」，判定层管「理赔时的增量够不够」
 *
 * 【三层检查】
 *   1. 承保参数   —— 时长 / 保费 / 阈值 / 赔付额，全部从链上读回，不用页面上的数
 *   2. 喂价新鲜度 —— 这个区域最近一次喂价距今多久（> 24h 标红；v2 合约里它是硬闸门）
 *   3. 三模型共识 —— ECMWF / GFS / ICON 交叉核验（复用 feed-verify.js）
 *                    ＋ 链上累计值与三模型中位数的背离度（阈值 60%，与判定层 R2 同口径）
 *
 * 【留痕为什么带哈希】
 *   reviewHash = keccak256(canonical(review)) —— 第三方拿到这份 JSON 能重算出同一个哈希。
 *   结论可以不同意，但「这份复核是什么时候、基于什么数据做的」无法被事后改写。
 *
 * 用法（必须在 04-脚本 目录下跑，否则读不到 .env）：
 *   node hook-watch.js --once              扫最近 N 个区块里的 PolicyBought，逐个复核后退出
 *   node hook-watch.js --blocks=5000       改扫描深度（默认 10000；publicnode 的 eth_getLogs 上限 50000）
 *   node hook-watch.js --from=11855930     从指定区块开始扫（含）
 *   node hook-watch.js --watch=20          常驻，每 20 秒扫一次，只在新保单出现时干活
 *   node hook-watch.js --dry-run           只打印，不写留痕文件
 *   node hook-watch.js --no-models         跳过三模型取数（离线 / 无代理时用）
 *   node hook-watch.js --force             已复核过的保单也重做
 *   node hook-watch.js --v2                读 v2 的 ABI（BOT Chain 968 上用）
 *
 * 环境变量（.env）：SEPOLIA_RPC / CONTRACT_ADDRESS；可选 AI_OUT_DIR 改留痕目录。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract } = require("ethers");
const { evidenceHashOf } = require("./canonical");
const { REGION_BY_ID } = require("./regions");
const { fetchModelSeries, gradeModels } = require("./feed-verify");

const V1_ABI_FILE = path.join(__dirname, "..", "03-合约", "RainDeliveryInsurance.abi.json");
const V2_ABI_FILE = path.join(__dirname, "..", "03-合约", "RainDeliveryInsuranceV2.abi.json");
const OUT_DIR = process.env.AI_OUT_DIR || path.join(__dirname, "..", "09-AI判定留痕");

const REVIEW_VERSION = "hook-watch@1";
const STALE_FEED_SEC = 24 * 3600;   // 超过这个年纪的喂价 = 基线不可信（v2 合约里是硬闸门）
const DEVIATION_LIMIT_PCT = 60;     // 链上累计值与三模型中位数的允许背离（与判定层 R2 同口径）
const DEFAULT_BLOCKS = 10000;       // 扫描深度：publicnode 的 eth_getLogs 单次上限是 50000

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const arg = (f, d) => { const a = ARGV.find((x) => x.startsWith(f + "=")); return a ? a.split("=")[1] : d; };
const ts = () => new Date().toTimeString().slice(0, 8);
const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
const ymd = (sec) => new Date(Number(sec) * 1000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ 纯判定 */

/**
 * 承保复核判定（纯函数：只吃数据、只吐结论）
 *
 * 故意做成纯函数：① 离线可断言 ② 第三方拿到留痕里的数据能复算出同一结论。
 * 未知（null）不算失败 —— 拿不到数就说拿不到，不能假装查过了。
 *
 * @param {{windowHours:number, rainfallAtBuyMm:number, onchainMm:number,
 *          feedAgeSec:number|null, models:object|null}} x
 */
function reviewPolicy(x) {
  const checks = {};
  const flagged = [];

  /* 合约只允许 24/48/72（v2 有 require，v1 固定 72 小时）——
     读到别的值说明这一层把保单读错了，属于该报警的异常，不是「容错」 */
  checks.windowOk = [24, 48, 72].includes(Number(x.windowHours));
  if (!checks.windowOk) flagged.push("window-out-of-range");

  checks.baselineMonotonic = x.rainfallAtBuyMm <= x.onchainMm;
  if (!checks.baselineMonotonic) flagged.push("baseline-above-onchain");

  checks.feedFresh = x.feedAgeSec === null || x.feedAgeSec === undefined
    ? null
    : x.feedAgeSec <= STALE_FEED_SEC;
  if (checks.feedFresh === false) flagged.push("stale-feed");

  const m = x.models;
  checks.modelsAgree = m ? (m.status === "agree" || m.status === "majority") : null;
  if (checks.modelsAgree === false) flagged.push("models-not-agreeing");

  let deviationPct = null;
  if (m && m.medianMm !== null && m.medianMm !== undefined) {
    const base = Math.max(Math.abs(m.medianMm), 1);   // 1mm 地板：中位数趋 0 时不做无穷放大
    deviationPct = Number(((Math.abs(x.onchainMm - m.medianMm) / base) * 100).toFixed(2));
    checks.baselineWithinModels = deviationPct <= DEVIATION_LIMIT_PCT;
    if (!checks.baselineWithinModels) flagged.push("baseline-deviates-from-models");
  } else {
    checks.baselineWithinModels = null;
  }

  return { checks, flagged, deviationPct, verdict: flagged.length ? "REVIEW_FLAG" : (checks.modelsAgree === null ? "REVIEW_PARTIAL" : "REVIEW_OK") };
}

/* ------------------------------------------------------------------ 读链 */

/** 一份保单的承保面：v1 / v2 的字段不同，这里统一成同一种形状 */
async function surfaceOf(c, id, isV2) {
  const p = await c.policies(id);
  const regionId = Number(p.regionId);
  const region = REGION_BY_ID[regionId] || { id: regionId, key: `unknown${regionId}`, name: `未知区域 ${regionId}` };
  const startTime = Number(p.startTime);
  const endTime = Number(p.endTime);
  const onchainMm = Number(await c.rainfall(regionId));
  const windowHours = isV2 ? Number(p.windowHours) : Math.round((endTime - startTime) / 3600);
  const thresholdMm = isV2 ? Number(await c.thresholdOf(windowHours)) : Number(await c.THRESHOLD());
  const premiumWei = isV2 ? p.premium : await c.premiumOf(regionId);
  const payoutWei = isV2 ? p.payout : await c.PAYOUT();
  return {
    p, regionId, region, startTime, endTime, windowHours, thresholdMm,
    premiumWei: String(premiumWei), payoutWei: String(payoutWei),
    rainfallAtBuyMm: Number(p.rainfallAtBuy),
    onchainMm,
    status: await c.policyStatus(id),
  };
}

/** 喂价新鲜度（一律以「投保所在区块」为观察时刻，所以这份留痕隔天重跑也得到同一个哈希）
 *  v2 直接读链上 lastFeedAt；v1 没有它，用投保区块之前最近一次 RainfallUpdated 的区块时间等价实现 */
async function feedInfo({ c, provider, isV2, regionId, asOfSec, fromBlock, toBlock }) {
  if (isV2) {
    const t = Number(await c.lastFeedAt(regionId));
    if (!t) return { known: false, note: "该区域在 v2 合约里还没有喂过价（lastFeedAt = 0）" };
    return { known: true, source: "lastFeedAt(链上)", time: t, ageSeconds: asOfSec - t, block: null, txHash: null, confidence: null };
  }
  const logs = await c.queryFilter(c.filters.RainfallUpdated(regionId), fromBlock, toBlock);
  if (!logs.length) {
    return { known: false, note: `投保区块之前、最近 ${toBlock - fromBlock + 1} 个区块内没有该区域的喂价事件（v1 没有 lastFeedAt 字段）` };
  }
  const last = logs[logs.length - 1];
  const blk = await provider.getBlock(last.blockNumber);
  return {
    known: true, source: "投保时刻最近的 RainfallUpdated(链上)", time: Number(blk.timestamp),
    ageSeconds: asOfSec - Number(blk.timestamp), block: last.blockNumber, txHash: last.transactionHash,
    confidence: Number(last.args.confidence),
  };
}

/* ------------------------------------------------------------------ 复核一份保单 */

async function buildRecord({ c, provider, isV2, noModels, chainId, addr, log, fromBlock, toBlock }) {
  const id = Number(log.args.policyId);
  const s = await surfaceOf(c, id, isV2);
  const blk = await provider.getBlock(log.blockNumber);
  const asOfSec = Number(blk.timestamp);          // ★ 观察时刻 = 投保交易所在区块的时间（不可变、可复算）

  const feed = await feedInfo({ c, provider, isV2, regionId: s.regionId, asOfSec, fromBlock, toBlock: log.blockNumber });

  let models = null;
  let modelsError = null;
  if (!noModels) {
    try {
      models = gradeModels(await fetchModelSeries(s.region, ymd(asOfSec)));
    } catch (e) {
      modelsError = e.shortMessage || e.message;
    }
  }

  const v = reviewPolicy({
    windowHours: s.windowHours,
    rainfallAtBuyMm: s.rainfallAtBuyMm,
    onchainMm: s.onchainMm,
    feedAgeSec: feed.known ? feed.ageSeconds : null,
    models,
  });

  const review = {
    hook: "PolicyBought",
    policyId: id,
    chainId,
    contract: addr,
    abi: isV2 ? "v2" : "v1",
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    asOf: iso(asOfSec),
    rider: s.p.rider,
    regionId: s.regionId,
    regionKey: s.region.key,
    regionName: s.region.name,
    policyStatus: s.status,
    startTime: s.startTime,
    endTime: s.endTime,
    windowHours: s.windowHours,
    thresholdMm: s.thresholdMm,
    premiumWei: s.premiumWei,
    payoutWei: s.payoutWei,
    rainfallAtBuyMm: s.rainfallAtBuyMm,
    onchainCumulativeMm: s.onchainMm,
    incrementMm: s.onchainMm - s.rainfallAtBuyMm,
    feed: feed.known
      ? { source: feed.source, lastFeedTime: iso(feed.time), ageSeconds: feed.ageSeconds, blockNumber: feed.block, txHash: feed.txHash, confidence: feed.confidence }
      : { source: null, note: feed.note },
    models: models
      ? {
          status: models.status,
          agree: models.agree,
          medianMm: models.medianMm,
          spreadMm: models.spreadMm,
          toleranceMm: models.toleranceMm,
          perModelMm: models.perModelMm,
          usable: models.usableModels,
          missing: models.missingModels,
          outlierModels: models.outlierModels,
          window: models.window,
        }
      : null,
    baselineDeviationPct: v.deviationPct,
    checks: v.checks,
    flagged: v.flagged,
    verdict: v.verdict,
    reviewVersion: REVIEW_VERSION,
  };

  const reviewHash = evidenceHashOf(review);
  const record = {
    schema: "rainproof/underwrite-review@1",
    review,
    reviewHash,
    reviewedAt: new Date().toISOString(),   // ★ 易变字段放 review 之外：重跑不会改变 reviewHash
    ...(modelsError ? { modelsError } : {}),
  };
  return { record, review, reviewHash };
}

/* ------------------------------------------------------------------ 打印 */

function printReview(r, reviewHash, record, modelsError) {
  const tag = r.verdict === "REVIEW_OK" ? "✅ 复核通过"
    : r.verdict === "REVIEW_PARTIAL" ? "◻️ 部分复核（三模型未取数，只查了链上参数与喂价新鲜度）"
    : "⚠️ 复核存疑";
  console.log(`[${ts()}] 🪝 保单 #${r.policyId} · ${r.regionName}(#${r.regionId}) · ${r.windowHours}h · ${r.policyStatus}`);
  console.log(`           链上：投保时 ${r.rainfallAtBuyMm}mm → 现 ${r.onchainCumulativeMm}mm（本轮增量 ${r.incrementMm}mm，阈值 ${r.thresholdMm}mm）`);
  if (r.feed.source) {
    const age = r.feed.ageSeconds < 3600 ? `${Math.round(r.feed.ageSeconds / 60)} 分钟` : `${(r.feed.ageSeconds / 3600).toFixed(1)} 小时`;
    console.log(`           喂价：${r.feed.source} 距投保时刻 ${age}${r.feed.confidence === null ? "" : ` · 置信 ${r.feed.confidence}`}${r.feed.txHash ? ` · ${r.feed.txHash.slice(0, 14)}…` : ""}`);
  } else {
    console.log(`           喂价：未知 —— ${r.feed.note}`);
  }
  if (r.models) {
    const per = r.models.perModelMm.map((m) => `${m.label} ${m.mm}`).join(" / ");
    console.log(`           三模型：${r.models.status} 中位数 ${r.models.medianMm}mm（${per}）· 离散 ${r.models.spreadMm}mm · 容差 ${r.models.toleranceMm}mm`);
  } else {
    console.log(`           三模型：未取数${modelsError ? `（${modelsError}）` : "（--no-models）"}`);
  }
  if (r.baselineDeviationPct !== null) {
    console.log(`           基线背离：链上 ${r.onchainCumulativeMm}mm vs 三模型中位数 ${r.models.medianMm}mm → ${r.baselineDeviationPct}%（阈值 ${DEVIATION_LIMIT_PCT}%）`);
  }
  console.log(`           ${tag}${r.flagged.length ? "：" + r.flagged.join("、") : ""}`);
  if (r.flagged.includes("baseline-deviates-from-models")) {
    console.log(`           ${" ".repeat(11)}（若该区域曾用 --demo 注入过模拟雨量，这个背离是预期的 —— 链上值来自模拟，模型不覆盖模拟数据）`);
  }
  console.log(`           留痕 ${path.relative(path.join(__dirname, ".."), record.file) || "（未写盘）"} · reviewHash ${reviewHash}`);
}

/* ------------------------------------------------------------------ 主流程 */

async function sweep({ c, provider, isV2, noModels, dry, force, chainId, addr, fromBlock, toBlock }) {
  const logs = await c.queryFilter(c.filters.PolicyBought(), fromBlock, toBlock);
  let written = 0, skipped = 0;
  for (const log of logs) {
    const id = Number(log.args.policyId);
    const file = path.join(OUT_DIR, `承保复核-policy${id}.json`);
    if (fs.existsSync(file) && !force) {
      console.log(`[${ts()}] 🪝 保单 #${id} 已经复核过（${path.basename(file)}），跳过（要重做加 --force）`);
      skipped++;
      continue;
    }
    const { record, review, reviewHash } = await buildRecord({ c, provider, isV2, noModels, chainId, addr, log, fromBlock, toBlock });
    record.file = file;
    if (!dry) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      written++;
    }
    printReview(review, reviewHash, record, record.modelsError);
  }
  if (!logs.length) console.log(`[${ts()}] 🪝 区块 ${fromBlock}~${toBlock} 里没有新保单`);
  return { found: logs.length, written, skipped };
}

async function main() {
  const isV2 = has("--v2");
  const addr = arg("--addr", process.env.CONTRACT_ADDRESS);
  if (!addr) throw new Error("请先在 .env 里填 CONTRACT_ADDRESS（或用 --addr=）");
  const noModels = has("--no-models");
  const dry = has("--dry-run");
  const force = has("--force");
  const watchSec = Number(arg("--watch", 0));
  const once = has("--once") || !watchSec;

  const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC || process.env.RPC_URL);
  const net = await provider.getNetwork();
  const c = new Contract(addr, JSON.parse(fs.readFileSync(isV2 ? V2_ABI_FILE : V1_ABI_FILE, "utf8")), provider);
  const head = await provider.getBlockNumber();
  let cursor = arg("--from", null) !== null
    ? Number(arg("--from"))
    : Math.max(0, head - Number(arg("--blocks", DEFAULT_BLOCKS)));

  console.log(`hook-watch 启动 · chainId ${net.chainId} · ${isV2 ? "v2" : "v1"} ABI · 合约 ${addr}`);
  console.log(`  监听 PolicyBought · 从区块 ${cursor} 起${once ? "（扫一遍就退）" : ` · 每 ${watchSec} 秒扫一次`}\n`);

  for (;;) {
    const to = once ? head : await provider.getBlockNumber();
    if (to >= cursor) {
      const r = await sweep({ c, provider, isV2, noModels, dry, force, chainId: Number(net.chainId), addr, fromBlock: cursor, toBlock: to });
      if (r.found) console.log(`[${ts()}] 本轮：发现 ${r.found} 份保单，新写留痕 ${r.written}，已存在跳过 ${r.skipped}\n`);
      cursor = to + 1;   // 只记已处理过的块号，避免重复拉同一段日志
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, Math.max(2, watchSec) * 1000));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("💥", e.shortMessage || e.message); process.exit(1); });
}

module.exports = { reviewPolicy, REVIEW_VERSION, STALE_FEED_SEC, DEVIATION_LIMIT_PCT };
