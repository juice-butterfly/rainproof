#!/usr/bin/env node
/**
 * keeper —— 无人值守的理赔触发者
 *
 * 合约里 `claim()` 没有权限修饰符（谁都可能帮骑手把赔款领出来），这是**有意设计**：
 * 理赔不该依赖某一家运营方在线。但"谁都能做"不等于"一定有人做"，
 * 所以补一个诚实的小 keeper：轮询链上状态，发现 claimable 的保单就替骑手领掉。
 *
 * 用法（必须在 04-脚本 目录下跑，否则读不到 .env）：
 *   node keeper.js --once        扫一遍，赔掉所有 claimable 的保单，然后退出
 *   node keeper.js               常驻，默认每 15 秒扫一遍
 *   node keeper.js --dry-run     只看不动手（扫一遍后退出）
 *   node keeper.js --interval=5  改轮询间隔（秒）
 *
 * 环境变量（.env）：SEPOLIA_RPC / CONTRACT_ADDRESS / PRIVATE_KEY；
 * 可选 KEEPER_KEY —— 单独给 keeper 一把钥匙。不给就用 PRIVATE_KEY。
 * keeper 不需要任何权限，用哪把钥匙都一样。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, formatEther } = require("ethers");

const ABI_FILE = path.join(__dirname, "..", "03-合约", "RainDeliveryInsurance.abi.json");
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes("--once");
const DRY = ARGV.includes("--dry-run");
const INTERVAL = Number((ARGV.find((a) => a.startsWith("--interval=")) || "").split("=")[1] || 15);

const ts = () => new Date().toTimeString().slice(0, 8);

async function scan(c, provider, dry) {
  const n = Number(await c.nextPolicyId());
  if (!n) { console.log(`[${ts()}] 链上还没有任何保单`); return 0; }

  const pool = await provider.getBalance(await c.getAddress());
  const payout = await c.PAYOUT();
  const paused = await c.paused();
  if (paused) { console.log(`[${ts()}] ⏸ 合约已暂停，跳过`); return 0; }

  let paid = 0;
  const pending = [];
  for (let id = 0; id < n; id++) {
    const st = await c.policyStatus(id);
    if (st !== "claimable") { if (st !== "paid") pending.push(`#${id}:${st}`); continue; }
    if (pool < payout) { console.log(`[${ts()}] 保单 #${id} 可赔，但池子只剩 ${formatEther(pool)} ETH < ${formatEther(payout)} ETH，停手`); break; }
    if (dry) { console.log(`[${ts()}] [dry-run] 保单 #${id} 可赔 —— 真跑的话现在就 claim()`); paid++; continue; }
    try {
      const tx = await c.claim(id);
      const rc = await tx.wait();
      console.log(`[${ts()}] ✅ 保单 #${id} 已赔付 ${formatEther(payout)} ETH  tx ${tx.hash}  区块 ${rc.blockNumber}  gas ${rc.gasUsed}`);
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
  console.log(`  池子 ${formatEther(await provider.getBalance(addr))} ETH · 每笔赔付 ${formatEther(await c.PAYOUT())} ETH\n`);

  if (ONCE || DRY) { await scan(c, provider, DRY); return; }
  for (;;) {
    try { await scan(c, provider, false); } catch (e) { console.log(`[${ts()}] 扫描出错：${e.shortMessage || e.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
})().catch((e) => { console.error("💥", e.shortMessage || e.message); process.exit(1); });
