#!/usr/bin/env node
/**
 * set-premium —— 把《精算口径》的触发概率落到链上，作为各城市的差异化保费
 * ============================================================================
 *
 * 【为什么要有这个脚本】
 *   链上保费如果靠人手填，就没人能说清它从哪来。这个脚本把它变成一条可复算的链路：
 *
 *       10-金融与定价/actuary-output.json     （11 年逐小时实测，B 产出）
 *                    ↓  p = regions[key].windows["72"].p
 *       建议保费 = 上整( p × PAYOUT ÷ 目标赔付率 0.60 )，网格 0.0001 ETH
 *                    ↓  setUnderwriting(regionId, level, premium, reasonHash)
 *       Sepolia 合约 premiumOf(regionId)      （演示页读的就是它）
 *
 *   reasonHash 不是随手一个常量，而是把**这次实际用到的 p、窗口、目标赔付率、
 *   取整网格**拼成稳定串再哈希。任何第三方照着复算，必然得到同一个 hash；
 *   一旦精算数据更新，hash 自己就会变 —— 链上留痕能证明"价格随精算走"。
 *
 * 【口径】
 *   窗口固定 72 小时（与合约 MAX_HOURS 一致，也是提交材料统一引用的口径）；
 *   概率越过 10% 保本线的城市标 RISK_LOADED，其余 RISK_NORMAL。
 *
 * 【用法】必须在 04-脚本 目录下跑（否则读不到 .env）
 *   node set-premium.js            只算不算，打印派生表（默认，安全）
 *   node set-premium.js --apply    真的发交易
 *   node set-premium.js --hours=48 换窗口看看（只影响本次计算，链上仍应保持 72h）
 *
 * 【环境变量】.env：SEPOLIA_RPC / CONTRACT_ADDRESS / PRIVATE_KEY
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { REGIONS } = require("./regions");

const ROOT = path.join(__dirname, "..");
const ABI_FILE = path.join(ROOT, "03-合约", "RainDeliveryInsurance.abi.json");
const ACTUARY_FILE = path.join(ROOT, "10-金融与定价", "actuary-output.json");

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes("--apply");
const HOURS = (ARGV.find((a) => a.startsWith("--hours=")) || "").split("=")[1] || "72";

const TARGET_LOSS_RATIO = 0.6;   // 目标赔付率：收 100 元赔 60 元，留 40 元做费用与风险附加
const TICK = 0.0001;             // 保费取整网格（上整，定价只许往上不许往下）
const LOSS_RED_LINE = 0.1;       // 触发概率红线：越过 10% 必亏（0.001 保费 / 0.01 赔付）

const pct = (x) => (x * 100).toFixed(3) + "%";

/** 上整到 TICK 网格。减去一个极小量，避免浮点让正好落在网格上的值多进一格 */
function ceilTick(raw) {
  return Math.ceil(raw / TICK - 1e-9) * TICK;
}

function plan() {
  if (!fs.existsSync(ACTUARY_FILE)) throw new Error(`缺少精算输出：${ACTUARY_FILE}（先跑 10-金融与定价/actuary.js）`);
  const act = JSON.parse(fs.readFileSync(ACTUARY_FILE, "utf8"));
  const payoutEth = act.meta.payoutEth;

  const rows = REGIONS.map((r) => {
    const info = act.regions[r.key];
    if (!info) throw new Error(`精算输出里没有 ${r.key}`);
    const w = info.windows[HOURS];
    if (!w) throw new Error(`精算输出里没有 ${HOURS} 小时窗口：${r.key}`);
    const p = w.p;
    const need = (p * payoutEth) / TARGET_LOSS_RATIO;        // 打到目标赔付率所需的保费
    const premium = ceilTick(need);
    return {
      id: r.id, key: r.key, name: r.name, p, hits: w.hits, windows: w.windows,
      need, premium,
      premiumEth: premium.toFixed(4),
      // 按最终保费算的真实赔付率：p × 赔付额 ÷ 实收保费
      lossRatio: (p * payoutEth) / premium,
      level: p > LOSS_RED_LINE ? 1 : 0,   // 1 = RISK_LOADED
      // 用旧价 0.001 时的赔付率，用来解释"为什么必须差异化"
      lossRatioFlat: (p * payoutEth) / act.meta.premiumEth,
    };
  });

  const reason = [
    "rainproof/underwriting@1",
    "source=10-金融与定价/actuary-output.json",
    `window=${HOURS}h`,
    `thresholdMm=${act.meta.threshold}`,
    `payout=${payoutEth}`,
    `targetLossRatio=${TARGET_LOSS_RATIO.toFixed(2)}`,
    `tick=${TICK}`,
    "p=" + rows.map((r) => `${r.key}:${r.p}`).join(","),
  ].join("|");

  return { rows, reason, act };
}

(async () => {
  const { rows, reason, act } = plan();
  const reasonHash = ethers.sha256(ethers.toUtf8Bytes(reason));
  const fileHash = ethers.sha256(fs.readFileSync(ACTUARY_FILE));

  console.log(`精算输出 ${ACTUARY_FILE}`);
  console.log(`  数据区间 ${act.meta.start} ~ ${act.meta.end} · 阈值 ${act.meta.threshold}mm · 单笔赔付 ${act.meta.payoutEth} ETH`);
  console.log(`  窗口 ${HOURS}h · 目标赔付率 ${TARGET_LOSS_RATIO.toFixed(2)} · 取整网格 ${TICK} ETH\n`);

  console.log(`${"城市".padEnd(4)}  ${"触发概率".padEnd(10)} ${"应需保费".padEnd(11)} ${"链上保费".padEnd(10)} ${"真实赔付率".padEnd(12)} ${"按旧价0.001".padEnd(12)} 承保动作`);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(6)}${pct(r.p).padEnd(10)} ${r.need.toFixed(6).padEnd(11)} ${r.premiumEth.padEnd(10)} ` +
      `${pct(r.lossRatio).padEnd(12)} ${pct(r.lossRatioFlat).padEnd(12)} ${r.level ? "RISK_LOADED" : "NORMAL"}`
    );
  }

  console.log(`\n定价依据串（第三方照抄即可复算出同一个 hash）：`);
  console.log(`  ${reason}`);
  console.log(`reasonHash  ${reasonHash}`);
  console.log(`精算输出文件 SHA256（存档用，不写链）  ${fileHash}`);

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com");
  const net = await provider.getNetwork();
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, JSON.parse(fs.readFileSync(ABI_FILE, "utf8")), provider);
  console.log(`\n链 chainId=${net.chainId}  合约 ${process.env.CONTRACT_ADDRESS}`);

  const onchain = [];
  for (const r of rows) {
    const cur = await c.premiumOf(r.id);
    const lvl = await c.riskLevel(r.id);
    onchain.push({ ...r, cur, lvl });
    const same = cur === ethers.parseEther(r.premiumEth) && Number(lvl) === r.level;
    console.log(`  #${r.id} ${r.name}  现值 ${ethers.formatEther(cur)} → ${r.premiumEth}（level ${lvl} → ${r.level}）${same ? "  已是目标值" : ""}`);
  }

  if (!APPLY) { console.log("\n[默认] 只算不算。确认无误后加 --apply 真的发交易。"); return; }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const wc = new ethers.Contract(process.env.CONTRACT_ADDRESS, JSON.parse(fs.readFileSync(ABI_FILE, "utf8")), wallet);
  console.log(`\n签名账户 ${wallet.address}  余额 ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`);
  for (const r of onchain) {
    const want = ethers.parseEther(r.premiumEth);
    if (r.cur === want && Number(r.lvl) === r.level) { console.log(`  #${r.id} ${r.name} 已是目标值，跳过`); continue; }
    const tx = await wc.setUnderwriting(r.id, r.level, want, reasonHash);
    const rc = await tx.wait();
    console.log(`  #${r.id} ${r.name}  ${ethers.formatEther(r.cur)} → ${r.premiumEth}  tx ${tx.hash}  区块 ${rc.blockNumber}  gas ${rc.gasUsed}`);
  }

  console.log("\n最终链上状态：");
  for (let id = 1; id <= 5; id++) {
    console.log(`  #${id} premiumOf=${ethers.formatEther(await c.premiumOf(id))}  riskLevel=${await c.riskLevel(id)}`);
  }
})().catch((e) => { console.error("💥", e.shortMessage || e.message); process.exit(1); });
