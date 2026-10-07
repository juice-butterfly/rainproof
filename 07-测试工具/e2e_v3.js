/**
 * v3 本地全流程演练：把 RainDeliveryInsuranceV3 在本地链上真跑一遍。
 *
 * v3 相对 v2 的每一处改动都要在这里有断言，否则「改了」只是我写在文档里的话：
 *   A-5① MIN_PREMIUM 0.0002 → 0.00002
 *   A-5② 五维报价（premiumOf 5 参 + 2 参兼容重载 + 可插拔 pricingModule）
 *   A-5③ 国标两档查表（12h 30/70、24h 50/100；48/72 与第三档取消）
 *   A-5④ 判定快照 rainfallAtJudgement（claim 不再用「申请那一刻」的读数）
 *   A-6   投保人 / 受益人分离（buyFor + payer 单独落库 + 退保退回付款人）
 *   路线图③ 限购只计**未结清**（openPoliciesOf）
 *   路线图④ settleExpired 去权限化（谁都能调，只减敞口、不付款）
 *   路线图⑥ refundPolicy（冷静期内退保）
 *
 * 用法：node e2e_v3.js [合约目录]
 *
 * 覆盖缺口（诚实标注）：`not offered`（模块说不卖）这条路径需要 B 的定价模块真在链上才
 * 走得到，本地没有模块时会走 v2 本地网格回退（永远可售）。真模块的「不卖格」由
 * `10-金融与定价/ref/verify_pricing_v3.js` 与 `07-测试工具/check-v3-prices.js`（读 968）覆盖。
 */
const path = require("path");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const SOL_DIR = process.argv[2] || path.join(__dirname, "..", "03-合约");
const NAME = "RainDeliveryInsuranceV3";
const ABI = JSON.parse(fs.readFileSync(path.join(SOL_DIR, `${NAME}.abi.json`), "utf8"));
const BIN = fs.readFileSync(path.join(SOL_DIR, `${NAME}.bytecode.txt`), "utf8").trim();

const pass = [], fail = [];
const ok = (n, x = "") => { pass.push(n); console.log(`  ✅ ${n}${x ? "  " + x : ""}`); };
const bad = (n, why) => { fail.push(`${n} (${why})`); console.log(`  ❌ ${n}  ← ${why}`); };

async function expectRevert(name, callable, keyword) {
  try {
    const r = await callable();
    if (r && typeof r.wait === "function") await r.wait();
    bad(name, "本该失败，却成功了");
  } catch (e) {
    const msg = [e.shortMessage, e.reason, e.message,
                 e.info && e.info.error && e.info.error.message, e.data]
                .filter(Boolean).join(" | ");
    if (!keyword) return ok(name, `已拒绝（${msg.slice(0, 70)}）`);
    if (msg.includes(keyword)) ok(name, `已拒绝（${keyword}）`);
    else bad(name, `期望含「${keyword}」，实际：${msg.slice(0, 140)}`);
  }
}

const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const eth = (w) => ethers.formatEther(w);

(async () => {
  console.log("=".repeat(78));
  console.log(`本地链全流程演练 · ${NAME}`);
  console.log("=".repeat(78));

  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(chain);

  // ★ ganache 两个坑，与 e2e_v2.js 同源（本地 harness 的，真链不存在）：
  //   ① eth_estimateGas 会拿偏早/偏晚的块时间去模拟，于是"喂价明明新鲜"也会被判 stale feed。
  //   ② eth_estimateGas 偶尔低估，导致上链后 gas 不够、收据里没有 reason。
  //   对策：估算失败或偏低 → 抬到 150 万；真实 require 失败照样在 tx.wait() 抛出。
  const estGas = provider.estimateGas.bind(provider);
  provider.estimateGas = async (tx) => {
    let v = 0n;
    try { v = await estGas(tx); }
    catch (e) { console.log(`     [gas 兜底] 估算失败：${e.shortMessage || e.message}`); }
    return v < 500_000n ? 1_500_000n : v;
  };

  // ★ 余额必须用裸 RPC 读：ethers v6 的 getBalance 有 250ms 缓存，会掩盖到账。
  const rawBal = async (addr) =>
    BigInt(await chain.request({ method: "eth_getBalance", params: [addr, "latest"] }));

  const accts = await chain.request({ method: "eth_accounts" });
  const [opAddr, rA, rB, rC, rD, rE, rF] = accts;
  const operator = await provider.getSigner(opAddr);
  const a = await provider.getSigner(rA);
  const b = await provider.getSigner(rB);
  const cc = await provider.getSigner(rC);
  const d = await provider.getSigner(rD);
  const e = await provider.getSigner(rE);
  const f = await provider.getSigner(rF);   // 不是 owner/operator：用来验「谁都能调」

  // 时间旅行：evm_setTime（绝对时间）而不是 evm_increaseTime —— 后者会让 ganache
  // 用偏早的时间戳模拟，`block.timestamp - lastFeedAt` 甚至下溢成 stale feed。
  const advance = async (secs) => {
    const blk = await chain.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    const target = (Number(blk.timestamp) + secs) * 1000;
    await chain.request({ method: "evm_setTime", params: [target] });
    await chain.request({ method: "evm_mine", params: [] });
    return BigInt((await chain.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).timestamp);
  };

  // ---------- 0 部署 ----------
  console.log("\n[0] 部署 + v3 常量");
  const c = await new ethers.ContractFactory(ABI, BIN, operator).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  ok("部署成功", addr);
  const code = await provider.getCode(addr);
  const wantRuntime = Number(fs.readFileSync(path.join(SOL_DIR, `${NAME}.runtime-size.txt`), "utf8").trim());
  if ((code.length - 2) / 2 === wantRuntime) ok("部署后链上代码长度与编译报告一致", `${wantRuntime} 字节`);
  else bad("链上代码长度", `${(code.length - 2) / 2} ≠ ${wantRuntime}`);

  const MIN_PREMIUM = await c.MIN_PREMIUM();
  const PAYOUT_MAX = await c.PAYOUT_MAX();
  const MAX_EXP = await c.MAX_OPEN_EXPOSURE_PER_RIDER();
  if (MIN_PREMIUM === ethers.parseEther("0.00002")) ok("A-5① MIN_PREMIUM = 0.00002（v2 的 0.0002 降了 10 倍）", eth(MIN_PREMIUM));
  else bad("MIN_PREMIUM", `${eth(MIN_PREMIUM)} ≠ 0.00002`);
  if (await c.MIN_HOURS() === 12n && await c.MAX_HOURS() === 24n) ok("A-5③ 时长区间 = 12~24 小时");
  else bad("MIN/MAX_HOURS", `${await c.MIN_HOURS()}/${await c.MAX_HOURS()}`);
  if (await c.TIER_COUNT() === 2n) ok("A-5③ 档位数 = 2（国标只有暴雨/大暴雨两档）");
  else bad("TIER_COUNT", `${await c.TIER_COUNT()}`);
  if (PAYOUT_MAX === ethers.parseEther("0.01")) ok("PAYOUT_MAX 仍是 0.01（赔付上限口径未动）");
  else bad("PAYOUT_MAX", eth(PAYOUT_MAX));
  if (await c.MAX_FEED_AGE() === 86400n) ok("MAX_FEED_AGE = 24 小时（喂价保鲜规则未动）");
  else bad("MAX_FEED_AGE", `${await c.MAX_FEED_AGE()}`);
  if (await c.MAX_POLICIES_PER_RIDER() === 3n && MAX_EXP === ethers.parseEther("0.02"))
    ok("限购常量：3 笔 / 0.02 ETH 在保敞口（B 的地盘，本轮未动）");
  else bad("限购常量", `${await c.MAX_POLICIES_PER_RIDER()} / ${eth(MAX_EXP)}`);
  if (await c.pricingModule() === ethers.ZeroAddress) ok("A-5② pricingModule 默认未配置（回退 v2 本地网格口径）");
  else bad("pricingModule 默认值", await c.pricingModule());
  await (await c.connect(operator).fundPool({ value: ethers.parseEther("0.05") })).wait();
  ok("准备金注入 0.05 ETH（后续 claim 才有钱可赔）", eth(await c.poolBalance()));

  // 喂价辅助：cumulative 单调不减，自己记着每个区的水位
  const water = {};
  async function feed(region, mm, tag = "") {
    const next = BigInt(Math.max(Number(water[region] || 0n), Number(mm)));
    water[region] = next;
    return c.connect(operator).updateRainfall(region, next, H(`snapshot:${region}:${next}:${tag}`), 90, 3);
  }

  // ---------- 1 A-5③ 国标查表 ----------
  console.log("\n[1] A-5③ 国标两档查表（GB/T 28592—2012 表 1）");
  const T = { none: 255n, t0: 0n, t1: 1n };
  const cases = [
    ["thresholdOf(12, 暴雨) = 30",  await c.thresholdOf(12, 0), 30n],
    ["thresholdOf(12, 大暴雨) = 70", await c.thresholdOf(12, 1), 70n],
    ["thresholdOf(24, 暴雨) = 50",  await c.thresholdOf(24, 0), 50n],
    ["thresholdOf(24, 大暴雨) = 100", await c.thresholdOf(24, 1), 100n],
    ["entryThresholdOf(12) = 30",   await c.entryThresholdOf(12), 30n],
    ["entryThresholdOf(24) = 50",   await c.entryThresholdOf(24), 50n],
    ["29mm/12h 未达档",             await c.tierOf(29, 12), T.none],
    ["30mm/12h = 暴雨档",           await c.tierOf(30, 12), T.t0],
    ["69mm/12h 仍是暴雨档",         await c.tierOf(69, 12), T.t0],
    ["70mm/12h = 大暴雨档",         await c.tierOf(70, 12), T.t1],
    ["999mm/12h 顶在最高档（没有第三档）", await c.tierOf(999, 12), T.t1],
    ["49mm/24h 未达档",             await c.tierOf(49, 24), T.none],
    ["50mm/24h = 暴雨档",           await c.tierOf(50, 24), T.t0],
    ["99mm/24h 仍是暴雨档",         await c.tierOf(99, 24), T.t0],
    ["100mm/24h = 大暴雨档",        await c.tierOf(100, 24), T.t1],
    // ★ 这一条是 v2 的线性外推作废的证据：v2 里 150mm/72h 才算暴雨，v3 根本没有 72h 了
    ["999mm/24h 顶在最高档（没有第三档）", await c.tierOf(999, 24), T.t1],
  ];
  for (const [name, got, want] of cases) {
    if (BigInt(got) === BigInt(want)) ok(name);
    else bad(name, `${got} ≠ ${want}`);
  }
  await expectRevert("48 小时的阈值要拒绝（旧窗口已停售）",
    async () => c.thresholdOf.staticCall(48, 0), "hours must be 12/24");
  await expectRevert("不存在的大暴雨档以上档位要拒绝",
    async () => c.thresholdOf.staticCall(24, 2), "bad tier");
  if (await c.tierBps(0) === 5000n && await c.tierBps(1) === 7500n) ok("两档赔付比例 = 50% / 75%");
  else bad("tierBps", `${await c.tierBps(0)}/${await c.tierBps(1)}`);
  await expectRevert("已删除的 100% 档要拒绝", async () => c.tierBps.staticCall(2), "bad tier");
  if (await c.hoursAllowed(12) && await c.hoursAllowed(24) && !(await c.hoursAllowed(48)) && !(await c.hoursAllowed(36)))
    ok("hoursAllowed：只放 12/24");
  else bad("hoursAllowed", "放行了 48/36 或拦住了 12/24");

  // ---------- 2 A4b 喂价新鲜度 ----------
  console.log("\n[2] A4b 喂价新鲜度（v2 保留项，确认没被 v3 改动碰坏）");
  await expectRevert("没喂过价就投保要拒绝",
    async () => c.connect(a).buyPolicy.staticCall(1, 24, { value: await c["premiumOf(uint8,uint256)"](1, 24) }),
    "stale feed");
  await (await feed(1, 0, "baseline")).wait();
  await (await c.connect(a).buyPolicy(1, 24, { value: await c["premiumOf(uint8,uint256)"](1, 24) })).wait();
  ok("喂价后投保成功", `policy #${(await c.nextPolicyId()) - 1n}`);
  await advance(25 * 3600);
  await expectRevert("喂价超过 24h 后投保要拒绝",
    async () => c.connect(b).buyPolicy.staticCall(1, 24, { value: await c["premiumOf(uint8,uint256)"](1, 24) }),
    "stale feed");
  await (await feed(1, 0, "refresh")).wait();
  await (await c.connect(b).buyPolicy(1, 24, { value: await c["premiumOf(uint8,uint256)"](1, 24) })).wait();
  ok("重新喂价后又可以投保", `policy #${(await c.nextPolicyId()) - 1n}`);

  // ---------- 3 A-6 代付 + 路线图⑥ 退保 ----------
  console.log("\n[3] A-6 投保人/受益人分离 + 路线图⑥ 冷静期内退保");
  const q5 = await c.quoteOf(1, 12, 1, 1, 1);
  const p5 = q5[0];
  console.log(`     平台代付段报价 quoteOf(1,12,骑手认证,平台代付,1) = ${eth(p5)} ETH`);
  const opBefore = await rawBal(opAddr);
  const txBuy = await c.connect(operator).buyFor(rE, 1, 12, 1, 1, 1, { value: p5 });
  await txBuy.wait();
  const idFor = (await c.nextPolicyId()) - 1n;
  const pf = await c.policies(idFor);
  if (pf.rider.toLowerCase() === rE.toLowerCase()) ok("buyFor：受益人 = 被保骑手（保单挂在骑手名下）", pf.rider);
  else bad("buyFor 受益人", `${pf.rider} ≠ ${rE}`);
  if (pf.payer.toLowerCase() === opAddr.toLowerCase()) ok("buyFor：付款人 = 出钱的平台账户（A-6 的关键字段）", pf.payer);
  else bad("buyFor 付款人", `${pf.payer} ≠ ${opAddr}`);
  if (pf.premium === p5) ok("buyFor：保费 = 五维报价（不是写死的默认价）", eth(pf.premium));
  else bad("buyFor 保费", `${eth(pf.premium)} ≠ ${eth(p5)}`);
  if (pf.thresholdMm === 30n && pf.windowHours === 12n) ok("保单入口闸线 = 国标 12h 暴雨线 30mm", `${pf.thresholdMm}mm`);
  else bad("保单 thresholdMm", `${pf.thresholdMm}/${pf.windowHours}`);
  if (await c.openPoliciesOf(rE) === 1n) ok("路线图③ openPoliciesOf[受益人] = 1");
  else bad("openPoliciesOf", `${await c.openPoliciesOf(rE)}`);

  await expectRevert("不是付款人也不是 operator 的退保要拒绝",
    async () => c.connect(e).refundPolicy.staticCall(idFor), "only payer or operator");
  const opBefore2 = await rawBal(opAddr);
  const poolBefore = await c.poolBalance();
  const riderBeforeRefund = await rawBal(rE);
  const rcRefund = await (await c.connect(operator).refundPolicy(idFor)).wait();
  const gasCost = rcRefund.gasUsed * rcRefund.gasPrice;    // operator 自己付的 gas，必须从余额差里剔掉
  const after = await rawBal(opAddr);
  const refunded = await c.policies(idFor);
  if (await c.poolBalance() === poolBefore - p5) ok("退保从池子支出正好一份保费", `-${eth(p5)} ETH`);
  else bad("池子支出", `${eth(poolBefore - await c.poolBalance())} ≠ ${eth(p5)}`);
  if (after - opBefore2 + gasCost === p5)
    ok("退保把保费退给**付款人**（扣掉他自付 gas 后净 +一份保费）", `+${eth(after - opBefore2 + gasCost)} ETH`);
  else bad("退保到账金额", `${eth(after - opBefore2 + gasCost)} ≠ ${eth(p5)}`);
  if (await rawBal(rE) === riderBeforeRefund) ok("受益骑手一分钱没动（退款不经过他）");
  else bad("受益骑手余额变了", `${await rawBal(rE)} ≠ ${riderBeforeRefund}`);
  if (refunded.settled && !refunded.paid) ok("退保后保单已了结、未赔付");
  else bad("退保后保单状态", `settled=${refunded.settled} paid=${refunded.paid}`);
  if (await c.openPoliciesOf(rE) === 0n && await c.riderExposure(rE) === 0n)
    ok("退保后该骑手的未结清计数与在保敞口都归零");
  else bad("退保后账本", `open=${await c.openPoliciesOf(rE)} exp=${eth(await c.riderExposure(rE))}`);
  await expectRevert("同一份保单不能退两次",
    async () => c.connect(operator).refundPolicy.staticCall(idFor), "already settled");
  await expectRevert("退掉的保单不能索赔（这条挡的就是「退保 + 索赔」双拿）",
    async () => c.connect(f).claim.staticCall(idFor), "already settled");

  // ---------- 4 演示口径：冷静期关掉 ----------
  console.log("\n[4] 演示口径：把冷静期改成 0（v2 的既有做法，v3 保留）");
  await (await c.connect(operator).setCoolingPeriod(0)).wait();
  ok("coolingPeriod = 0", `${await c.coolingPeriod()}`);
  await expectRevert("非 operator 改冷静期要拒绝",
    async () => c.connect(a).setCoolingPeriod.staticCall(0), "not operator");
  await (await c.connect(cc).buyPolicy(1, 12, { value: p5 })).wait();
  const idNow = (await c.nextPolicyId()) - 1n;
  ok("冷静期 0 时新保单立刻可赔", await c.policyStatus(idNow));
  await expectRevert("冷静期 0 时退保窗口已经关闭（已是生效态）",
    async () => c.connect(cc).refundPolicy.staticCall(idNow), "already effective");

  // ---------- 5 A-5② 五维报价 ----------
  console.log("\n[5] A-5② 五维报价 + v2 兼容重载");
  const pCompat = await c["premiumOf(uint8,uint256)"](1, 24);
  const pFive = await c["premiumOf(uint8,uint256,uint8,uint8,uint256)"](1, 24, 0, 0, 1);
  if (pCompat === pFive) ok("2 参兼容重载 == 5 参默认段（前端不用改）", `${eth(pCompat)} ETH`);
  else bad("兼容重载", `${eth(pCompat)} ≠ ${eth(pFive)}`);
  if (pCompat >= MIN_PREMIUM && pCompat < PAYOUT_MAX) ok("报价落在 [MIN_PREMIUM, PAYOUT_MAX) 区间内");
  else bad("报价区间", eth(pCompat));
  const q = await c.quoteOf(1, 12, 0, 0, 1);
  if (q[1] === true) ok("quoteOf 返回可售标记（sellable）", `${eth(q[0])} ETH`);
  else bad("quoteOf sellable", `${q[1]}`);
  await expectRevert("不在售的时长报价要拒绝",
    async () => c["premiumOf(uint8,uint256,uint8,uint8,uint256)"].staticCall(1, 48, 0, 0, 1), "hours must be 12/24");
  await expectRevert("链上不支持一次买多份（count 必须 1）",
    async () => c.connect(operator).buyFor.staticCall(rE, 1, 24, 0, 0, 10, { value: pCompat }),
    "count must be 1");
  await expectRevert("低于地板价的网格价要拒绝",
    async () => c.connect(operator).setPremiumGrid.staticCall(1, 24, ethers.parseEther("0.000001"), H("too-low")),
    "premium out of range");
  await expectRevert("48 小时的网格价要拒绝",
    async () => c.connect(operator).setPremiumGrid.staticCall(1, 48, ethers.parseEther("0.001"), H("h48")),
    "hours must be 12/24");

  // ---------- 6 路线图③④：未结清计数 + 谁都能结算 ----------
  console.log("\n[6] 路线图③ 限购只计未结清 + 路线图④ settleExpired 去权限化");
  await (await feed(1, 0, "b-baseline")).wait();
  await (await c.connect(cc).buyPolicy(1, 12, { value: p5 })).wait();
  const idC2 = (await c.nextPolicyId()) - 1n;
  ok("同一骑手第 2 份：在保敞口正好顶到 0.02", `${eth(await c.riderExposure(rC))}`);
  await expectRevert("同一骑手第 3 份要拒绝（敞口闸先于笔数闸生效）",
    async () => c.connect(cc).buyPolicy.staticCall(1, 12, { value: p5 }), "open exposure cap exceeded");
  // 说明：MAX_OPEN_EXPOSURE_PER_RIDER = 0.02、每份占 0.01 ⇒ 同一骑手最多 2 份在保，
  //       MAX_POLICIES_PER_RIDER = 3 的笔数闸被敞口闸盖住（v2 就是这样，不是 v3 引入的）。
  if (await c.openPoliciesOf(rC) === 2n) ok("未结清计数 = 2", `${await c.openPoliciesOf(rC)}`);
  else bad("未结清计数", `${await c.openPoliciesOf(rC)}`);

  // 先买一份**还没到期**的保单（rider d），用来验证「未到期不许结算」
  await (await c.connect(d).buyPolicy(1, 12, { value: p5 })).wait();
  const idFresh = (await c.nextPolicyId()) - 1n;
  ok("新买一份还没到期的保单（试结算闸门用）", `policy #${idFresh}`);
  await expectRevert("还没到期的保单不能被结算",
    async () => c.connect(f).settleExpired.staticCall([idFresh]), "policy not expired yet");
  await advance(12 * 3600 + 60);
  const cBefore = await rawBal(rC);
  await (await c.connect(f).settleExpired([idC2])).wait();     // f 不是 operator
  ok("非 operator 也能结算到期保单（路线图④：只减敞口、不付款）");
  if (await c.openPoliciesOf(rC) === 1n) ok("结算后未结清计数 2 → 1");
  else bad("结算后未结清计数", `${await c.openPoliciesOf(rC)}`);
  if (await rawBal(rC) === cBefore) ok("结算不产生任何转账（只是账本归零）");
  else bad("结算动到了余额", `${await rawBal(rC)} ≠ ${cBefore}`);
  await (await feed(1, 0, "after-settle")).wait();
  await (await c.connect(cc).buyPolicy(1, 12, { value: p5 })).wait();
  ok("结算后同一骑手可以再买（v2 的终身计数已改成只计未结清）", `policy #${(await c.nextPolicyId()) - 1n}`);

  // ---------- 7 A-5④ 判定快照 ----------
  console.log("\n[7] A-5④ 判定快照：claim 用 AI 判定当时的读数，不用申请那一刻的读数");
  await (await feed(1, 300, "base300")).wait();
  await (await c.connect(e).buyPolicy(1, 12, { value: p5 })).wait();
  const idSnap = (await c.nextPolicyId()) - 1n;
  const base = (await c.policies(idSnap)).rainfallAtBuy;
  ok("快照测试用新保单：投保基线 = 链上此刻读数", `${base}mm`);
  await (await feed(1, 500, "storm500")).wait();
  ok("链上累计降雨已推到 500mm（此刻相对基线 = 200mm，够大暴雨档）", `${await c.rainfall(1)}mm`);
  await expectRevert("判定读数低于投保基线要拒绝",
    async () => c.connect(operator).submitJudgement.staticCall(idSnap, await c.DECISION_PAY(), 90, 3,
      base - 1n, H("in-bad"), H("out-bad"), "ai-judge-v1"),
    "judged reading below buy baseline");
  await expectRevert("判定读数超过链上此刻读数要拒绝（不许凭空发明降水）",
    async () => c.connect(operator).submitJudgement.staticCall(idSnap, await c.DECISION_PAY(), 90, 3,
      501n, H("in-bad2"), H("out-bad2"), "ai-judge-v1"),
    "judged reading ahead of chain");
  await expectRevert("非 operator 提交判定要拒绝",
    async () => c.connect(f).submitJudgement.staticCall(idSnap, await c.DECISION_PAY(), 90, 3,
      base + 30n, H("in-x"), H("out-x"), "ai-judge-v1"),
    "not operator");
  // 判定只认 30mm（暴雨档）——比链上 200mm 小得多
  await (await c.connect(operator).submitJudgement(idSnap, await c.DECISION_PAY(), 90, 3,
    base + 30n, H("in-ok"), H("out-ok"), "ai-judge-v1")).wait();
  ok("判定写入成功（快照 = 基线 + 30mm）", `rainfallAtJudgement = ${(await c.judgements(idSnap)).rainfallAtJudgement}mm`);
  if (await c.rainfallDuring(idSnap) === 30n) ok("rainfallDuring 用快照（30mm），而不是链上此刻的 200mm");
  else bad("rainfallDuring", `${await c.rainfallDuring(idSnap)} ≠ 30`);
  if (await c.currentTier(idSnap) === 0n) ok("档位按快照算 = 暴雨档 0（若按 200mm 会是 1）");
  else bad("currentTier", `${await c.currentTier(idSnap)}`);
  if (await c.payoutOf(idSnap) === ethers.parseEther("0.005"))
    ok("可赔金额 = 0.005 ETH（50% 档，不是 200mm 对应的 0.0075）");
  else bad("payoutOf", eth(await c.payoutOf(idSnap)));
  if (await c.shortfall(idSnap) === 0n) ok("shortfall = 0（快照已达标）");
  else bad("shortfall", `${await c.shortfall(idSnap)}`);

  const riderBefore = await rawBal(rE);
  await (await c.connect(f).claim(idSnap)).wait();             // f 触发，钱只去保单里的受益人
  const jr = await c.policies(idSnap);
  if (jr.paid && jr.settled && jr.payout === ethers.parseEther("0.005"))
    ok("索赔按快照赔付 0.005 ETH 并了结", `${eth(jr.payout)} ETH`);
  else bad("索赔结果", `paid=${jr.paid} settled=${jr.settled} payout=${eth(jr.payout)}`);
  if (await rawBal(rE) - riderBefore === ethers.parseEther("0.005"))
    ok("赔款到账 = 受益骑手（gas 由触发者付，受益人净得全款）", `+${eth(await rawBal(rE) - riderBefore)} ETH`);
  else bad("赔款到账", `${eth(await rawBal(rE) - riderBefore)} ≠ 0.005`);
  if (await c.openPoliciesOf(rE) === 0n && await c.riderExposure(rE) === 0n)
    ok("赔付后未结清计数与在保敞口归零（路线图③在 claim 里也生效）");
  else bad("赔付后账本", `open=${await c.openPoliciesOf(rE)} exp=${eth(await c.riderExposure(rE))}`);
  await expectRevert("同一份保单不能判两次",
    async () => c.connect(operator).submitJudgement.staticCall(idSnap, await c.DECISION_PAY(), 90, 3,
      base + 30n, H("in-y"), H("out-y"), "ai-judge-v1"),
    "judgement already submitted");
  await expectRevert("已结清/退过保的保单不能再写判定",
    async () => c.connect(operator).submitJudgement.staticCall(idFor, await c.DECISION_PAY(), 90, 3,
      base + 30n, H("in-z"), H("out-z"), "ai-judge-v1"),
    "already settled");

  // ---------- 8 A-5② 定价模块接线 ----------
  console.log("\n[8] A-5② setPricingModule：接上/更换/摘掉定价模块");
  await expectRevert("非 operator 接定价模块要拒绝",
    async () => c.connect(a).setPricingModule.staticCall(rF), "not operator");
  await (await c.connect(operator).setPricingModule(rF)).wait();
  if ((await c.pricingModule()).toLowerCase() === rF.toLowerCase()) ok("pricingModule 已指向新地址", rF);
  else bad("pricingModule", await c.pricingModule());
  await expectRevert("指向一个非合约地址时报价会失败（证明模块真的被调用，不是摆设）",
    async () => c.quoteOf.staticCall(1, 24, 0, 0, 1));
  await (await c.connect(operator).setPricingModule(ethers.ZeroAddress)).wait();
  const qBack = await c.quoteOf(1, 24, 0, 0, 1);
  if (qBack[1] === true) ok("摘掉模块后回退本地网格口径", `${eth(qBack[0])} ETH`);
  else bad("回退口径", `${qBack[1]}`);

  console.log("\n" + "=".repeat(78));
  console.log(`通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { console.log("失败清单："); fail.forEach((x) => console.log("  - " + x)); }
  console.log("=".repeat(78));
  process.exit(fail.length ? 1 : 0);
})().catch((err) => {
  console.error("\n💥 演练脚本自身异常：", err);
  process.exit(1);
});
