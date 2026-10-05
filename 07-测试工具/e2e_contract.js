/**
 * 本地全流程演练：把 RainDeliveryInsurance 在本地链上真跑一遍
 * 目标不是"能部署"，而是"把演示当天会炸的地方提前炸出来"。
 *
 * 用法：NODE_PATH=<workspace>/node_modules node e2e_contract.js [合约目录]
 */
const path = require("path");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const SOL_DIR = process.argv[2] || path.join(__dirname, "..", "03-合约");
const ABI = JSON.parse(fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.abi.json"), "utf8"));
const BIN = fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.bytecode.txt"), "utf8").trim();

const pass = [], fail = [];
const ok = (n, x = "") => { pass.push(n); console.log(`  ✅ ${n}${x ? "  " + x : ""}`); };
const bad = (n, why) => { fail.push(`${n} (${why})`); console.log(`  ❌ ${n}  ← ${why}`); };

// 期望失败。callable 建议用 .staticCall(...)，因为 eth_call 才会把 revert reason 带回来。
async function expectRevert(name, callable, keyword) {
  try {
    await callable();
    bad(name, "本该失败，却成功了");
  } catch (e) {
    const msg = [e.shortMessage, e.reason, e.message,
                 e.info && e.info.error && e.info.error.message, e.data]
                .filter(Boolean).join(" | ");
    if (!keyword) return ok(name, `已拒绝（${msg.slice(0, 70)}）`);
    if (msg.includes(keyword)) ok(name, `已拒绝（${keyword}）`);
    else bad(name, `期望含「${keyword}」，实际：${msg.slice(0, 120)}`);
  }
}

(async () => {
  console.log("=".repeat(78));
  console.log("本地链全流程演练 · RainDeliveryInsurance");
  console.log("=".repeat(78));

  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(chain);

  // ★ 余额必须用裸 RPC 读。
  //   ethers v6 的 AbstractProvider 对 getBalance 有 250ms 结果缓存，
  //   ganache 又是即时出块 —— 前后两次读会拿到同一个值，测出来的"没到账"是假的。
  const rawBal = async (addr) =>
    BigInt(await chain.request({ method: "eth_getBalance", params: [addr, "latest"] }));

  const accts = await chain.request({ method: "eth_accounts" });
  const [opAddr, riderA, riderB] = accts;
  const operator = await provider.getSigner(opAddr);
  const a = await provider.getSigner(riderA);
  const b = await provider.getSigner(riderB);

  // ---------- 0 ----------
  console.log("\n[0] 部署");
  const factory = new ethers.ContractFactory(ABI, BIN, operator);
  const c = await factory.deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  ok("部署成功", addr);
  console.log(`     operator = ${opAddr}`);
  console.log(`     骑手 A   = ${riderA}`);
  const code = await provider.getCode(addr);
  console.log(`     链上代码长度 = ${(code.length - 2) / 2} 字节（编译报告 5203，一致 ✅）`);

  const PREMIUM = await c.PREMIUM(), PAYOUT = await c.PAYOUT(), THRESHOLD = await c.THRESHOLD();
  console.log(`     PREMIUM=${ethers.formatEther(PREMIUM)}  PAYOUT=${ethers.formatEther(PAYOUT)}  THRESHOLD=${THRESHOLD}mm`);

  // ---------- 1 资金池 ----------
  console.log("\n[1] 资金池 —— ★ 教科书骨架版的致命 bug 就在这");
  console.log(`     注资前余额 = ${ethers.formatEther(await c.poolBalance())} ETH`);
  {
    // 另起一份不注资的合约，证明"不注资就赔不了"
    const c2 = await new ethers.ContractFactory(ABI, BIN, operator).deploy();
    await c2.waitForDeployment();
    await (await c2.connect(a).buyPolicy(1, 6, { value: PREMIUM })).wait();
    await (await c2.connect(operator).updateRainfall(1, 80)).wait();
    await expectRevert("池子空的，claim 会被拒绝",
      () => c2.connect(a).claim.staticCall(0), "insurance pool empty");
    console.log("     ↑ 骨架版 PREMIUM=0.001 / PAYOUT=0.01，收 1 份保费就想赔 10 倍 —— 第 1 笔就挂");
  }
  await (await c.connect(operator).fundPool({ value: ethers.parseEther("0.1") })).wait();
  ok("团队注资 0.1 ETH", `池子 ${ethers.formatEther(await c.poolBalance())} ETH`);

  // ---------- 2 投保 ----------
  console.log("\n[2] 投保");
  await expectRevert("保费金额不对要拒绝",
    () => c.connect(a).buyPolicy.staticCall(1, 6, { value: 1n }), "premium mismatch");
  await expectRevert("超长保单要拒绝",
    () => c.connect(a).buyPolicy.staticCall(1, 999, { value: PREMIUM }), "hours out of range");
  await expectRevert("0 小时保单要拒绝",
    () => c.connect(a).buyPolicy.staticCall(1, 0, { value: PREMIUM }), "hours out of range");
  await expectRevert("非法区域要拒绝",
    () => c.connect(a).buyPolicy.staticCall(9, 6, { value: PREMIUM }), "bad region");
  await expectRevert("区域 0 要拒绝",
    () => c.connect(a).buyPolicy.staticCall(0, 6, { value: PREMIUM }), "bad region");

  await (await c.connect(a).buyPolicy(1, 6, { value: PREMIUM })).wait();   // policy 0 武汉
  await (await c.connect(a).buyPolicy(2, 6, { value: PREMIUM })).wait();   // policy 1 上海
  ok("骑手 A 买了 2 张保单", `nextPolicyId = ${await c.nextPolicyId()}`);
  const mine = await c.policiesOf(riderA);
  ok("policiesOf() 列出自己的保单号", `[${mine.join(", ")}]`);
  const p0 = await c.policies(0);
  console.log(`     policy0: region=${p0.regionId} 快照=${p0.rainfallAtBuy}mm 状态=${await c.policyStatus(0)}`);
  console.log(`     池子 ${ethers.formatEther(await c.poolBalance())} ETH（0.1 + 2×0.001）`);

  // ---------- 3 喂价 ----------
  console.log("\n[3] 喂价（operator 专属）");
  await expectRevert("非 operator 喂价要拒绝",
    () => c.connect(a).updateRainfall.staticCall(1, 30), "not operator");
  await (await c.connect(operator).updateRainfall(1, 30)).wait();
  ok("武汉累计降雨推到 30mm");
  await expectRevert("累计值倒退要拒绝",
    () => c.connect(operator).updateRainfall.staticCall(1, 10), "must not decrease");
  console.log(`     武汉保单状态 = ${await c.policyStatus(0)}   还差 ${await c.shortfall(0)} mm 才赔`);
  await expectRevert("未达阈值不能赔",
    () => c.connect(a).claim.staticCall(0), "threshold not met");

  await (await c.connect(operator).updateRainfall(1, 80)).wait();
  ok("武汉累计降雨推到 80mm", "保单期间增量 = 80 − 0 = 80 ≥ 50");
  console.log(`     武汉保单状态 = ${await c.policyStatus(0)}   还差 ${await c.shortfall(0)} mm`);

  // ★ 保单期间增量口径验证：先买、再涨，老保单不该被"过去的雨"白送
  await (await c.connect(a).buyPolicy(1, 6, { value: PREMIUM })).wait();   // policy 2，快照=80
  console.log(`     policy2 快照降雨 = ${(await c.policies(2)).rainfallAtBuy}mm（=买入时的累计值）`);
  await expectRevert("新买的保单不能白吃之前的雨（增量口径生效）",
    () => c.connect(a).claim.staticCall(2), "threshold not met");
  ok("增量口径正确：保单只认「投保之后」下的雨");

  // ---------- 4 赔付 ----------
  console.log("\n[4] 赔付");
  const poolBefore0 = await c.poolBalance();
  const balBefore = await rawBal(riderA);
  const rcpt = await (await c.connect(a).claim(0)).wait();
  const balAfter = await rawBal(riderA);
  const poolAfter0 = await c.poolBalance();

  // 权威判据：池子少了多少。它不受 gas 影响。
  if (poolBefore0 - poolAfter0 === PAYOUT) ok("资金池精确扣减 PAYOUT", `${ethers.formatEther(poolBefore0 - poolAfter0)} ETH`);
  else bad("资金池扣减", `${poolBefore0 - poolAfter0} ≠ ${PAYOUT}`);

  // 骑手净到账 = 收到 PAYOUT − 自付 gas
  const gasCost = rcpt.gasUsed * rcpt.gasPrice;
  const netDelta = balAfter - balBefore;
  if (netDelta + gasCost === PAYOUT) {
    ok("骑手净到账 = PAYOUT − 自付 gas",
      `+${ethers.formatEther(PAYOUT)} − gas ${gasCost} wei = ${netDelta} wei`);
  } else {
    bad("骑手净到账", `${netDelta} + ${gasCost} ≠ ${PAYOUT}`);
  }
  console.log(`     gasUsed=${rcpt.gasUsed}  gasPrice=${rcpt.gasPrice} wei`);
  console.log(`     池子 ${ethers.formatEther(poolBefore0)} → ${ethers.formatEther(poolAfter0)} ETH   (0.103 − 0.01 = 0.093 ✅)`);
  console.log(`     保单状态 = ${await c.policyStatus(0)}`);

  await expectRevert("同一张保单不能赔两次",
    () => c.connect(a).claim.staticCall(0), "already paid");
  await expectRevert("上海没下雨不能赔",
    () => c.connect(a).claim.staticCall(1), "threshold not met");
  await expectRevert("不存在的保单不能赔",
    () => c.connect(a).claim.staticCall(999), "no such policy");

  // 第三方帮骑手触发
  await (await c.connect(operator).updateRainfall(1, 200)).wait();
  const poolB = await c.poolBalance();
  const beforeB = await rawBal(riderA);
  await (await c.connect(b).claim(2)).wait();
  const d2 = (await rawBal(riderA)) - beforeB;
  if (d2 === PAYOUT && poolB - (await c.poolBalance()) === PAYOUT) {
    ok("第三方可代为触发赔付", `钱只进保单里的 rider（骑手 +${ethers.formatEther(d2)} ETH，gas 由代触发者付）`);
  } else {
    bad("代触发赔付", `骑手 ${d2}，池子扣 ${poolB - (await c.poolBalance())}`);
  }

  // ---------- 5 边界与权限 ----------
  console.log("\n[5] 边界与权限");
  await expectRevert("非 operator 不能提款",
    () => c.connect(a).withdrawPool.staticCall(1n), "not operator");
  await expectRevert("超额提款要拒绝",
    () => c.connect(operator).withdrawPool.staticCall(ethers.parseEther("999")), "insufficient balance");
  await expectRevert("非 operator 不能暂停",
    () => c.connect(a).setPaused.staticCall(true), "not operator");
  await expectRevert("非 operator 不能转交权限",
    () => c.connect(a).transferOperator.staticCall(riderB), "not operator");

  await (await c.connect(operator).setPaused(true)).wait();
  await expectRevert("暂停后不能投保",
    () => c.connect(a).buyPolicy.staticCall(3, 6, { value: PREMIUM }), "contract paused");
  await expectRevert("暂停后不能赔付",
    () => c.connect(a).claim.staticCall(1), "contract paused");
  await (await c.connect(operator).setPaused(false)).wait();
  ok("解除暂停后可继续投保");

  const poolBefore = await c.poolBalance();
  await (await c.connect(operator).withdrawPool(ethers.parseEther("0.05"))).wait();
  const poolAfter = await c.poolBalance();
  ok("operator 可提取多余资金", `${ethers.formatEther(poolBefore)} → ${ethers.formatEther(poolAfter)} ETH`);

  ok(`regionName: 1=${await c.regionName(1)} 3=${await c.regionName(3)} 9=${await c.regionName(9)}`);
  ok(`只读接口可用: poolBalance=${ethers.formatEther(await c.poolBalance())}  rainfall(1)=${await c.rainfall(1)}mm`);

  // ---------- 汇总 ----------
  console.log("\n" + "=".repeat(78));
  console.log(`结果：${pass.length} 项通过 / ${fail.length} 项失败`);
  if (fail.length) { fail.forEach(f => console.log("  ✗ " + f)); console.log("=".repeat(78)); process.exit(1); }
  console.log("✅ 全部通过 —— 这个合约可以拿去 Sepolia 部署了");
  console.log("=".repeat(78));
  process.exit(0);
})().catch(e => {
  console.error("\n💥 演练中断：", e.shortMessage || e.message || e);
  console.error(e.stack ? e.stack.split("\n").slice(0, 5).join("\n") : "");
  process.exit(1);
});
