/** 诊断：直接问本地链上的合约，看 riderA 到底持有几张保单、每张什么状态。
 *  用法：NODE_PATH=<workspace>/node_modules node dbg_state.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const INFO = JSON.parse(fs.readFileSync(path.join(__dirname, "_local_chain.json"), "utf8"));
const SOL_DIR = process.argv[2] || path.join(__dirname, "..", "03-合约");
const ABI = JSON.parse(fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.abi.json"), "utf8"));

// 列出 ABI 里的读函数，便于对照
const reads = ABI.filter(x => x.type === "function" && ["view", "pure"].includes(x.stateMutability)).map(x => x.name);
const writes = ABI.filter(x => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map(x => x.name);

(async () => {
  const provider = new ethers.JsonRpcProvider(INFO.rpc);
  const c = new ethers.Contract(INFO.addr, ABI, provider);

  console.log("=".repeat(72));
  console.log("合约读函数 ：", reads.join(", "));
  console.log("合约写函数 ：", writes.join(", "));
  console.log("=".repeat(72));

  const [premium, payout, threshold, regionCount, nextId, pool] = await Promise.all([
    c.PREMIUM(), c.PAYOUT(), c.THRESHOLD(), c.REGION_COUNT(), c.nextPolicyId(), c.poolBalance()
  ]);
  console.log("PREMIUM      :", ethers.formatEther(premium), "ETH");
  console.log("PAYOUT       :", ethers.formatEther(payout), "ETH");
  console.log("THRESHOLD    :", threshold.toString(), "mm");
  console.log("REGION_COUNT :", regionCount.toString());
  console.log("nextPolicyId :", nextId.toString(), "（= 已存在保单数）");
  console.log("poolBalance  :", ethers.formatEther(pool), "ETH");

  console.log("\n--- 降雨看板 ---");
  for (let i = 1; i <= Number(regionCount); i++) {
    const r = await c.rainfall(i);
    let nm = "?";
    try { nm = await c.regionName(i); } catch (e) {}
    console.log(`  #${i} ${nm.padEnd(6)} 累计 ${r.toString().padStart(4)} mm`);
  }

  console.log("\n--- 我的保单 policiesOf(riderA) ---");
  let ids = [];
  try {
    ids = await c.policiesOf(INFO.riderA);
    console.log("  返回类型:", Array.isArray(ids) ? `数组 长度 ${ids.length}` : typeof ids);
    console.log("  原始值  :", JSON.stringify(ids.map(x => x.toString())));
  } catch (e) {
    console.log("  ❌ 调用失败:", e.shortMessage || e.message);
  }

  console.log("\n--- 逐张保单 policyStatus(id) ---");
  for (let i = 0; i < Number(nextId); i++) {
    try {
      const st = await c.policyStatus(i);
      const p = await c.policies(i);
      const shortfall = await c.shortfall(i);
      const during = await c.rainfallDuring(i);
      console.log(`  #${i} owner=${p.rider} region=${p.regionId} paid=${p.paid} exists=${p.exists}`);
      console.log(`      期间增量=${during.toString()}mm 差阈值=${shortfall.toString()}mm  状态码=${st.toString()}`);
    } catch (e) {
      console.log(`  #${i} ❌`, e.shortMessage || e.message);
    }
  }

  console.log("\n--- 用 operator 也查一遍（对照） ---");
  try {
    const ids2 = await c.policiesOf(INFO.opAddr);
    console.log("  policiesOf(operator) =", JSON.stringify(ids2.map(x => x.toString())));
  } catch (e) { console.log("  ❌", e.shortMessage || e.message); }

  // 账户余额对照（裸 RPC，绕开 ethers 的 250ms 缓存）
  console.log("\n--- 余额（裸 RPC） ---");
  for (const [nm, a] of [["operator", INFO.opAddr], ["riderA", INFO.riderA]]) {
    const hex = await provider.send("eth_getBalance", [a, "latest"]);
    console.log(`  ${nm.padEnd(9)} ${ethers.formatEther(BigInt(hex))} ETH`);
  }
})().catch(e => { console.error("💥", e.shortMessage || e.message || e); process.exit(1); });
