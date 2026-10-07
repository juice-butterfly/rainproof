#!/usr/bin/env node
/**
 * keeper —— 理赔触发者 + 到期敞口结算
 *
 * 合约里 `claim()` 没有权限修饰符（谁都可能帮骑手把赔款领出来），这是**有意设计**：
 * 理赔不该依赖某一家运营方在线。但"谁都能做"不等于"一定有人做"，
 * 所以补一个诚实的小 keeper：轮询链上状态，发现 claimable 的保单就替骑手领掉。
 *
 * ★ 它**不是**合约里的自动机制 —— 合约没有任何定时器，赔付与结算都由外部交易触发。
 *   对外只能说：「判定与结算由 operator 的两条脚本触发；`claim()` 无权限，任何人都能替骑手把钱领出来。」
 *
 * 用法（必须在 04-脚本 目录下跑，否则读不到 .env）：
 *   node keeper.js --once        扫一遍，赔掉所有 claimable 的保单，然后退出
 *   node keeper.js               常驻，默认每 15 秒扫一遍
 *   node keeper.js --dry-run     只看不动手（扫一遍后退出）
 *   node keeper.js --settle      额外把「已到期未赔」的保单结算掉，回收在保敞口
 *                                （`settleExpired` 是 onlyOperator，必须用 operator 私钥）
 *   node keeper.js --interval=5  改轮询间隔（秒）
 *
 * 环境变量（.env）：SEPOLIA_RPC / CONTRACT_ADDRESS / PRIVATE_KEY；
 * 可选 KEEPER_KEY —— 单独给 keeper 一把钥匙。不给就用 PRIVATE_KEY。
 * keeper 领赔款不需要任何权限，用哪把钥匙都一样；**只有 --settle 需要 operator 那把**。
 *
 * 合约版本：v2（03-合约/RainDeliveryInsuranceV2.abi.json）。
 *   v1 的 payout 是全局常量 `PAYOUT`，v2 按国标档位算，逐单读 `payoutOf(id)`。
 *   v2 新增长期约束：`claim()` 要求 `block.timestamp <= endTime` —— **过期就再也赔不了**，
 *   所以「雨量已达标但还没判定」的保单，必须在到期前补判定，否则只能被 settleExpired 结算掉。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, formatEther } = require("ethers");

// 默认 v2（968 演示基线与 677 用的是 v2）；加 --v3 时读 v3 的 ABI（v3 把阈值/赔付档改成国标两档，
// 但 keeper 只用 nextPolicyId / policyStatus / payoutOf / claim / settleExpired，两版都有）。
const VARIANT = process.argv.includes("--v3") ? "V3" : "V2";
const ABI_FILE = path.join(__dirname, "..", "03-合约", `RainDeliveryInsurance${VARIANT}.abi.json`);
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes("--once");
const DRY = ARGV.includes("--dry-run");
const SETTLE = ARGV.includes("--settle");
const INTERVAL = Number((ARGV.find((a) => a.startsWith("--interval=")) || "").split("=")[1] || 15);

const ts = () => new Date().toTimeString().slice(0, 8);

async function scan(c, provider, dry, doSettle) {
  const n = Number(await c.nextPolicyId());
  if (!n) { console.log(`[${ts()}] 链上还没有任何保单`); return 0; }

  const pool = await provider.getBalance(await c.getAddress());
  const paused = await c.paused();
  if (paused) { console.log(`[${ts()}] ⏸ 合约已暂停，跳过`); return 0; }

  const statuses = [];
  for (let id = 0; id < n; id++) statuses.push(await c.policyStatus(id));

  // ---- 到期未赔 → 结算敞口（A6；只对 block.timestamp > endTime 且未赔未结算的生效）----
  if (doSettle) {
    const expired = statuses.map((st, id) => (st === "expired" ? id : -1)).filter((id) => id >= 0);
    if (!expired.length) {
      console.log(`[${ts()}] 没有到期未赔的保单，无需结算`);
    } else if (dry) {
      console.log(`[${ts()}] [dry-run] 到期未赔 ${expired.length} 张可结算：#${expired.join(" #")}`);
    } else {
      try {
        const tx = await c.settleExpired(expired);
        const rc = await tx.wait();
        console.log(`[${ts()}] 🧾 结算到期保单 ${expired.length} 张（#${expired.join(" #")}）` +
                    ` · 未了结敞口回到 ${formatEther(await c.openExposure())} ETH  tx ${tx.hash}  区块 ${rc.blockNumber}`);
      } catch (e) {
        // 整批里只要有一张不满足条件就整笔 revert —— 退化成逐张，别让一张坏单挡住其余
        console.log(`[${ts()}] ⚠ 批量结算失败（${e.shortMessage || e.message}），改为逐张重试`);
        for (const id of expired) {
          try {
            const tx = await c.settleExpired([id]);
            await tx.wait();
            console.log(`[${ts()}] 🧾 保单 #${id} 已结算  tx ${tx.hash}`);
          } catch (e2) {
            console.log(`[${ts()}] ❌ 保单 #${id} 结算失败：${e2.shortMessage || e2.message}`);
          }
        }
      }
    }
  }

  // ---- 可赔 → 替骑手领（逐单读 payoutOf，v2 不再有全局 PAYOUT）----
  let paid = 0;
  const pending = [];
  for (let id = 0; id < n; id++) {
    const st = statuses[id];
    if (st !== "claimable") { if (st !== "paid") pending.push(`#${id}:${st}`); continue; }
    const amount = await c.payoutOf(id);
    if (pool < amount) {
      console.log(`[${ts()}] 保单 #${id} 可赔，但池子只剩 ${formatEther(pool)} ETH < ${formatEther(amount)} ETH，停手`);
      break;
    }
    if (dry) { console.log(`[${ts()}] [dry-run] 保单 #${id} 可赔 ${formatEther(amount)} ETH —— 真跑的话现在就 claim()`); paid++; continue; }
    try {
      const tx = await c.claim(id);
      const rc = await tx.wait();
      console.log(`[${ts()}] ✅ 保单 #${id} 已赔付 ${formatEther(amount)} ETH  tx ${tx.hash}  区块 ${rc.blockNumber}  gas ${rc.gasUsed}`);
      paid++;
    } catch (e) {
      console.log(`[${ts()}] ❌ 保单 #${id} 赔付失败：${e.shortMessage || e.message}`);
    }
  }
  console.log(`[${ts()}] 扫了 ${n} 张保单，本轮赔付 ${paid} 张${pending.length ? `；未可赔：${pending.join(" ")}` : ""}`);
  return paid;
}

(async () => {
  const rpc = process.env.SEPOLIA_RPC || process.env.RPC_URL;
  const addr = process.env.CONTRACT_ADDRESS;
  const key = process.env.KEEPER_KEY || process.env.PRIVATE_KEY;
  if (!addr) throw new Error("请先在 .env 里填 CONTRACT_ADDRESS");
  if (!key && !DRY) throw new Error("请先在 .env 里填 PRIVATE_KEY（或 KEEPER_KEY）");

  const provider = new JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  const wallet = key ? new Wallet(key, provider) : null;
  const c = new Contract(addr, JSON.parse(fs.readFileSync(ABI_FILE, "utf8")), wallet || provider);

  console.log(`keeper 启动 · chainId ${net.chainId} · 合约 ${addr}`);
  if (wallet) console.log(`  签名账户 ${wallet.address}（余额 ${formatEther(await provider.getBalance(wallet.address))}）`);
  console.log(`  池子 ${formatEther(await provider.getBalance(addr))} ETH · 单笔最高赔付 ${formatEther(await c.PAYOUT_MAX())} ETH`);
  console.log(`  未了结敞口 ${formatEther(await c.openExposure())} ETH · 准备金下限 ${formatEther(await c.reserveOf())} ETH`);
  if (SETTLE) {
    const op = await c.operator();
    if (!wallet || wallet.address.toLowerCase() !== op.toLowerCase()) {
      throw new Error(`--settle 需要 operator 私钥：合约的 operator 是 ${op}，当前签名账户是 ${wallet ? wallet.address : "(只读)"}`);
    }
  }
  console.log("");

  if (ONCE || DRY) { await scan(c, provider, DRY, SETTLE); return; }
  for (;;) {
    try { await scan(c, provider, false, SETTLE); } catch (e) { console.log(`[${ts()}] 扫描出错：${e.shortMessage || e.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
})().catch((e) => { console.error("💥", e.shortMessage || e.message); process.exit(1); });
