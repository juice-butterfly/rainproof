/**
 * 喂价脚本（预言机）—— 把链下的降雨数据写进 RainDeliveryInsurance 合约
 * ============================================================================
 *
 * 【为什么需要它】
 *   合约不能主动访问互联网。链是确定性的：全世界每个节点跑同样的代码必须得到
 *   同样的结果；如果合约能随时去调一个 API，结果就不可能一致。
 *   所以外部数据必须由链下的某个东西「写进去」—— 这个东西就叫预言机（oracle）。
 *   本脚本就是那个预言机。
 *
 * 【数据源】
 *   Open-Meteo（https://open-meteo.com）—— 免费、免 API key、国内可直连（已实测）。
 *   ⚠️ Chainlink 的 Data Feeds 里【没有】降雨量数据，所以「接一个现成的降雨喂价」
 *   这条路走不通，必须自己跑。
 *
 * 【口径：为什么推「累计」而不是「今天的量」】
 *   合约里的判定是【保单期间增量】= 当前累计 − 投保时快照 ≥ 50mm。
 *   所以脚本推的必须是【单调递增的累计降雨量】。这里取「自 RAIN_EPOCH 起逐日累加」，
 *   跨天也不会回退。（如果推「今日降雨」，每天 0 点归零，增量口径立刻失真。）
 *
 * 【用法】
 *   npm run push                    # 真实数据，推全部 5 个区域
 *   npm run push -- 1               # 只推区域 1（武汉）
 *   npm run push -- --status        # 只读，看链上现状（不花 gas）
 *   npm run push -- --demo          # ★ 演示模式：注入一场模拟暴雨，立刻可触发赔付
 *   npm run push -- --watch 10      # 每 10 分钟自动推一次（真实数据）
 *   npm run push -- --demo --watch 5
 *
 * 【⚠️ 演示诚实性】
 *   真实天气不会配合你的演示时间。10 月初的武汉，实测过去一周只累计 37.2mm，
 *   够不到 50mm 阈值 —— 也就是说【用真实数据演示时，赔付根本触发不了】。
 *   所以演示请用 --demo 模式（脚本会明确打印「模拟数据」），并在答辩材料里写清：
 *   「产品在真实气象数据上运行；演示时为可控起见使用脚本注入的模拟强降雨」。
 *   主动说明 = 加分；被评委问出来 = 减分。
 */

// dotenv 是可选依赖：装了就从 .env 读，没装也能直接用环境变量跑
try { require("dotenv").config(); } catch (_) { /* 忽略 */ }
const { JsonRpcProvider, Wallet, Contract, formatEther, parseEther } = require("ethers");

/* ------------------------------------------------------------------ 配置 */

const ABI = [
  "function updateRainfall(uint8 regionId, uint256 cumulativeMm) external",
  "function rainfall(uint8 regionId) external view returns (uint256)",
  "function operator() external view returns (address)",
  "function paused() external view returns (bool)",
  "function poolBalance() external view returns (uint256)",
  "function PAYOUT() external view returns (uint256)",
  "function THRESHOLD() external view returns (uint256)",
  "function regionName(uint8 regionId) external pure returns (string)",
  "function REGION_COUNT() external view returns (uint8)",
];

// 区域表：regionId 与坐标，两边必须和合约里的 regionName 对得上（脚本会自检）
const REGIONS = [
  { id: 1, key: "wuhan",     name: "武汉", lat: 30.5928, lon: 114.3055 },
  { id: 2, key: "shanghai",  name: "上海", lat: 31.2304, lon: 121.4737 },
  { id: 3, key: "beijing",   name: "北京", lat: 39.9042, lon: 116.4074 },
  { id: 4, key: "guangzhou", name: "广州", lat: 23.1291, lon: 113.2644 },
  { id: 5, key: "chengdu",   name: "成都", lat: 30.5728, lon: 104.0668 },
];

// 累计起点：累计降雨从这个日期开始算。2026-10-01 = 赛事周的第一天。
const RAIN_EPOCH = process.env.RAIN_EPOCH || "2026-10-01";

/* ------------------------------------------------------- 命令行参数解析 */

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);

function flagValue(f, def) {
  const i = ARGV.indexOf(f);
  if (i === -1) return def;
  const v = ARGV[i + 1];
  return v === undefined || v.startsWith("--") ? def : v;
}

const DEMO = has("--demo");
const STATUS_ONLY = has("--status");
const WATCH_MIN = flagValue("--watch", null);
// 纯数字参数 = 指定单个区域
const ONLY_REGION = (() => {
  const n = ARGV.find((a) => /^\d+$/.test(a));
  return n ? Number(n) : null;
})();

/* ------------------------------------------------------------- 天气数据源 */

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 从 Open-Meteo 取「自 RAIN_EPOCH 到今天的逐日降雨」，返回累加值（mm，整数）。
 * archive-api 有约 5 天的滞后；如果区间太靠近今天，它可能缺最近几天，
 * 这时用 forecast 接口的 past_days 补齐 —— 两个接口字段格式一致。
 */
async function fetchCumulativeMm(region) {
  const today = new Date();
  const end = ymd(today);
  const start = RAIN_EPOCH;

  const base =
    `latitude=${region.lat}&longitude=${region.lon}` +
    `&daily=precipitation_sum&timezone=Asia%2FShanghai`;

  // 主力：archive（历史实测值）
  const urlArchive =
    `https://archive-api.open-meteo.com/v1/archive?${base}` +
    `&start_date=${start}&end_date=${end}`;

  // 兜底：forecast 往前看 past_days=14（覆盖 archive 的滞后区间）
  const urlForecast =
    `https://api.open-meteo.com/v1/forecast?${base}` +
    `&past_days=14&forecast_days=0`;

  const tryFetch = async (url) => {
    const r = await fetch(url, { headers: { "User-Agent": "rain-insurance-oracle/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const days = j?.daily?.time || [];
    const vals = j?.daily?.precipitation_sum || [];
    const sum = vals.reduce((a, b) => a + (Number(b) || 0), 0);
    return { sum: Math.round(sum * 10) / 10, days: days.length, first: days[0], last: days[days.length - 1] };
  };

  let a = null, b = null, errA = null;
  try { a = await tryFetch(urlArchive); } catch (e) { errA = e.message; }
  try { b = await tryFetch(urlForecast); } catch (e) { /* 两条都失败才报错 */ }

  // 取「更长区间」的那个（覆盖更完整）
  let best = a, src = "archive";
  if (b && (!a || b.days > a.days)) { best = b; src = "forecast(past_days=14)"; }
  if (!best) throw new Error(`两个接口都失败（archive: ${errA}）`);

  return { mm: Math.max(0, Math.round(best.sum)), src, detail: best };
}

/* --------------------------------------------------------------- 工具函数 */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bar(cur, threshold, width = 30) {
  const ratio = Math.min(1, cur / Math.max(1, threshold));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const rpc = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
  const address = (process.env.CONTRACT_ADDRESS || "").trim();

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      "请先在 .env 里填好 CONTRACT_ADDRESS（42 位的 0x… 地址）\n" +
      "  当前值：" + (address || "（空）")
    );
  }

  const provider = new JsonRpcProvider(rpc);
  const readC = new Contract(address, ABI, provider);

  /* ---- 只读模式：只看不写 ---- */
  if (STATUS_ONLY) {
    await printStatus(readC);
    return;
  }

  if (!process.env.PRIVATE_KEY || !process.env.PRIVATE_KEY.startsWith("0x")) {
    throw new Error("请先在 .env 里填好 PRIVATE_KEY（0x 开头）");
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new Contract(address, ABI, wallet);

  /* ---- 前置检查：网络 / 权限 / 池子 ---- */
  const net = await provider.getNetwork();
  if (net.chainId.toString() !== "11155111") {
    throw new Error(`⚠️ 当前 RPC 不是 Sepolia（chainId=${net.chainId}），已中止`);
  }

  const [onchainOperator, paused, pool, payout, threshold, regionCount, balance] = await Promise.all([
    readC.operator(), readC.paused(), readC.poolBalance(),
    readC.PAYOUT(), readC.THRESHOLD(), readC.REGION_COUNT(),
    provider.getBalance(wallet.address),
  ]);

  console.log(C.dim("─".repeat(74)));
  console.log(`${C.b("喂价者")}  ${wallet.address}`);
  console.log(`合约      ${address}   ${C.dim("Sepolia · chainId " + net.chainId)}`);
  console.log(`账户余额  ${formatEther(balance)} SepETH`);
  console.log(`资金池    ${formatEther(pool)} SepETH   ${C.dim(`（每笔赔付 ${formatEther(payout)} ETH，还能赔 ${Number(pool / payout)} 笔）`)}`);
  console.log(`触发阈值  ${threshold} mm   ${C.dim("（保单期间增量口径）")}`);
  console.log(C.dim("─".repeat(74)));

  if (onchainOperator.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `❌ 这个钱包不是合约的 operator，updateRainfall 会被 revert。\n` +
      `   合约里的 operator ：${onchainOperator}\n` +
      `   你 .env 里的钱包  ：${wallet.address}\n` +
      `   解决：用 operator 的那个钱包来喂价，或在链上 transferOperator 转给当前钱包。`
    );
  }
  if (paused) {
    console.log(C.y("⚠️ 合约处于暂停状态（paused=true），updateRainfall 仍可调用，但 claim 会被拒。"));
  }
  if (Number(balance) === 0) {
    throw new Error("❌ 账户余额为 0，付不起 gas。先去水龙头领测试币。");
  }

  /* ---- 自检：区域名与合约是否对得上 ---- */
  for (const r of REGIONS.filter((r) => r.id <= Number(regionCount))) {
    const onchain = String(await readC.regionName(r.id)).toLowerCase();
    if (onchain !== r.key) {
      throw new Error(
        `❌ 区域映射对不上：合约 regionId=${r.id} 叫「${onchain}」，\n` +
        `   脚本里写的是「${r.key}」。请同步两边，否则会把 A 城的雨算到 B 城头上。`
      );
    }
  }

  /* ---- 决定这次推哪些区域 ---- */
  let targets = REGIONS.filter((r) => r.id <= Number(regionCount));
  if (ONLY_REGION !== null) {
    targets = targets.filter((r) => r.id === ONLY_REGION);
    if (!targets.length) throw new Error(`区域 ${ONLY_REGION} 不存在（合约里只有 1~${regionCount}）`);
  }

  /* ---- 逐区域推送 ---- */
  console.log(`\n${DEMO ? C.y("【演示模式】注入模拟强降雨") : "【真实数据】Open-Meteo"}  ·  起点 ${RAIN_EPOCH}  ·  ${targets.length} 个区域\n`);

  const results = [];
  for (const r of targets) {
    const current = Number(await readC.rainfall(r.id));

    let mm, srcNote;
    if (DEMO) {
      // 模拟暴雨：在链上现值基础上加 60~130mm，保证稳稳越过阈值
      const add = 60 + Math.floor(Math.random() * 71);
      mm = current + add;
      srcNote = `模拟 +${add}mm`;
    } else {
      const got = await fetchCumulativeMm(r);
      mm = got.mm;
      srcNote = `${got.detail.first}→${got.detail.last} 逐日累加（${got.src}）`;
    }

    /* ★ 单调性守卫：累计值只能往上走 */
    if (mm < current && !has("--force")) {
      console.log(
        `${C.y("跳过")} #${r.id} ${r.name.padEnd(4)} 链上现值 ${current}mm > 新值 ${mm}mm` +
        `\n      ${C.dim("累计值回退会让已投保的保单「增量」失真，已拒绝写入（要强制写加 --force）。")}`
      );
      results.push({ r, ok: false, reason: "非单调" });
      continue;
    }

    process.stdout.write(`#${r.id} ${r.name.padEnd(4)} ${String(current).padStart(4)}mm → ${String(mm).padStart(4)}mm  ${bar(mm, Number(threshold))} `);

    try {
      const tx = await contract.updateRainfall(r.id, mm);
      const rc = await tx.wait();
      const over = mm - current >= Number(threshold);
      console.log(
        (over ? C.r("⛈ 越过阈值") : C.g("✅ 已上链")) +
        C.dim(`  区块 ${rc.blockNumber} · gas ${rc.gasUsed} · ${tx.hash.slice(0, 18)}…`)
      );
      results.push({ r, ok: true, from: current, to: mm, hash: tx.hash, block: rc.blockNumber, over });
    } catch (e) {
      console.log(C.r("❌ 失败") + "  " + (e.shortMessage || e.message));
      results.push({ r, ok: false, reason: e.shortMessage || e.message });
    }
    await sleep(400);   // 给 RPC 一点喘息，避免公共节点限流
  }

  /* ---- 汇总 ---- */
  const ok = results.filter((x) => x.ok);
  const over = ok.filter((x) => x.over);

  console.log("\n" + C.dim("─".repeat(74)));
  console.log(`推送完成：${ok.length}/${results.length} 成功`);
  if (DEMO) {
    console.log(C.y("⚠️ 本次推送的是【模拟降雨数据】，仅用于演示。答辩材料里请如实说明。"));
  }

  if (over.length) {
    console.log("\n" + C.b("🎯 现在可以去前端点「申请赔付」了："));
    for (const x of over) {
      console.log(`   #${x.r.id} ${x.r.name}  保单期间增量 ${x.to - x.from}mm ≥ ${threshold}mm`);
    }
  }

  if (ok.length) {
    console.log("\n" + C.b("链上核验（不依赖任何在线浏览器）："));
    console.log("   双击桌面  汉客松-链上核验台.html");
    for (const x of ok) console.log(`   ${x.r.name}：${x.hash}`);
    console.log(C.dim("   （不要用 sepolia.otterscan.io —— 它的后端节点 10/4 起挂了，页面永远转圈）"));
  }

  /* ---- watch 模式 ---- */
  if (WATCH_MIN) {
    const min = Math.max(1, Number(WATCH_MIN));
    console.log(`\n${C.c(`⏱  watch 模式：${min} 分钟后自动再推一次。Ctrl+C 停止。`)}`);
    await sleep(min * 60 * 1000);
    return main();
  }
}

/* ------------------------------------------------------------ 只读状态 */

async function printStatus(readC) {
  const [threshold, payout, pool, paused, operator, regionCount] = await Promise.all([
    readC.THRESHOLD(), readC.PAYOUT(), readC.poolBalance(),
    readC.paused(), readC.operator(), readC.REGION_COUNT(),
  ]);
  console.log(C.dim("─".repeat(74)));
  console.log(`合约状态  ${paused ? C.y("已暂停") : C.g("运行中")}   operator ${operator}`);
  console.log(`资金池    ${formatEther(pool)} SepETH   ${C.dim(`（每笔赔付 ${formatEther(payout)} ETH，还能赔 ${Number(pool / payout)} 笔）`)}`);
  console.log(C.dim("─".repeat(74)));
  console.log(`区域降雨累计（阈值 ${threshold}mm，自 ${RAIN_EPOCH} 起算）\n`);
  for (let id = 1; id <= Number(regionCount); id++) {
    const r = REGIONS.find((x) => x.id === id);
    const mm = Number(await readC.rainfall(id));
    const nm = r ? `${r.name}(${r.key})` : `region${id}`;
    console.log(`  #${id} ${nm.padEnd(14)} ${String(mm).padStart(5)}mm  ${bar(mm, Number(threshold))}`);
  }
  console.log("");
}

/* ---------------------------------------------------------------- 入口 */

main().catch((e) => {
  console.error("\n" + C.r("❌ 失败：") + (e.shortMessage || e.message || e));
  process.exit(1);
});
