#!/usr/bin/env node
/**
 * 端到端核验：把 pricing-engine.json 的 payload 灌进参考合约，再逐格读回来比对。
 *
 * 为什么要有这个文件：规格文件里的 Solidity 片段如果没人编译过，它就只是散文。
 * 本脚本做四件事 ——
 *   ① 真编译 `ref/PricingV3.sol`（solc 0.8.37，来自 07-测试工具/node_modules）
 *   ② 在内存 ganache 上部署，用 60 次 setPremiumRow 写入全部零售价 + 批量带
 *   ③ 逐格读回 premiumOf()，与 payload 的 60 个零售值 / 180 个批量值逐个比对
 *   ④ 反证：不可售格必须 revert、非法 (riderTier,channel) 必须 revert、
 *      band 单调性写反必须 revert
 *
 * 用法：cd 10-金融与定价 && node ref/verify_pricing_v3.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TOOLS = path.join(__dirname, '..', '..', '07-测试工具', 'node_modules');
const solc = require(path.join(TOOLS, 'solc'));
const ethers = require(path.join(TOOLS, 'ethers'));
const ganache = require(path.join(TOOLS, 'ganache'));

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'PricingV3.sol');
const PAYLOAD = JSON.parse(fs.readFileSync(path.join(ROOT, '10-金融与定价', 'pricing-engine.json'), 'utf8'));

let total = 0;
const fails = [];
const ok = (name, cond, detail) => { total++; if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`); };

const BATCH_N = PAYLOAD.meta.dimensions.batch;
const RETAIL = PAYLOAD.payload.retail;
const BANDS = PAYLOAD.payload.bands;

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'PricingV3.sol': { content: fs.readFileSync(SRC, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('solc: ' + errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['PricingV3.sol'].PricingV3;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

/** 把 payload 折算成 60 行 setPremiumRow 的入参 */
function buildRows() {
  const rows = [];
  for (const r of RETAIL) {
    const bands = new Array(BATCH_N.length).fill(0n);
    if (r.sellable) {
      const mine = BANDS.filter((b) => b.regionId === r.regionId && b.hours === r.hours && b.segId === r.segId);
      for (let i = 0; i < BATCH_N.length; i++) {
        const hit = mine.find((b) => b.bandIndex === i);
        // 自助投保渠道没有批量行 → 6 档全等于零售价（单调性成立且等价于"无折扣"）
        bands[i] = hit ? BigInt(hit.premiumWei) : BigInt(r.premiumWei);
      }
      bands[0] = BigInt(r.premiumWei); // band0 必须等于零售
    } else {
      // 不卖的格：合约只认 retail==0 作哨兵，band 值填地板即可（读价时先 revert）
      bands.fill(20000000000000n); // 0.00002 ether
    }
    rows.push({ ...r, bands });
  }
  return rows;
}

async function main() {
  const { abi, bytecode } = compile();
  ok('solc 编译通过且产出了 bytecode', bytecode.length > 100);

  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } }));
  const signer = await provider.getSigner(0);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy();
  await c.waitForDeployment();
  ok('合约部署成功', !!(await c.getAddress()));

  // ── ① 写 60 行 ────────────────────────────────────────────────────────────
  const rows = buildRows();
  ok('待写入行数 = 60', rows.length === 60, `${rows.length}`);
  const REASON = ethers.id('rainproof/pricing-v3@1');
  for (const r of rows) {
    await (await c.setPremiumRow(r.regionId, r.hours, r.segId, r.sellable ? BigInt(r.premiumWei) : 0n, r.bands, REASON)).wait();
  }
  ok('60 行全部写入成功', true);

  // ── ② 逐格读回零售价 ──────────────────────────────────────────────────────
  const TIER = { 0: 0, 1: 1, 2: 2 }; // riderTier 直接对应
  const CH = { t2c1: [2, 1], t1c1: [1, 1], t1c0: [1, 0], t0c0: [0, 0] };
  for (const r of rows) {
    const [rt, ch] = CH[r.segKey];
    const tag = `[${r.regionKey} ${r.hours}h ${r.segKey}]`;
    if (r.sellable) {
      const got = await c.premiumOf(r.regionId, r.hours, rt, ch, 1);
      ok(`${tag} 零售价读回 = payload`, got === BigInt(r.premiumWei), `${got} vs ${r.premiumWei}`);
    } else {
      let reverted = false;
      try { await c.premiumOf(r.regionId, r.hours, rt, ch, 1); } catch { reverted = true; }
      ok(`${tag} 不可售格必须 revert（不许回退报价）`, reverted);
    }
  }

  // ── ③ 逐格读回 180 个批量价 ───────────────────────────────────────────────
  let bandChecked = 0;
  for (const r of rows) {
    if (!r.sellable) continue;
    const [rt, ch] = CH[r.segKey];
    const mine = BANDS.filter((b) => b.regionId === r.regionId && b.hours === r.hours && b.segId === r.segId);
    for (const b of mine) {
      const got = await c.premiumOf(r.regionId, r.hours, rt, ch, BigInt(b.nMax));
      ok(`[${r.regionKey} ${r.hours}h ${r.segKey}] N=${b.nMax} 批量价读回`,
        got === BigInt(b.premiumWei), `${got} vs ${b.premiumWei}`);
      bandChecked++;
    }
  }
  ok('批量价核验行数 = 180', bandChecked === 180, `${bandChecked}`);
  ok('payload 里批量行数 = 180', BANDS.length === 180, `${BANDS.length}`);

  // band 单调：份数越多单价不增
  for (const r of rows) {
    if (!r.sellable) continue;
    const [rt, ch] = CH[r.segKey];
    let prev = null;
    for (const n of BATCH_N) {
      const p = await c.premiumOf(r.regionId, r.hours, rt, ch, BigInt(n));
      if (prev !== null) ok(`[${r.regionKey} ${r.hours}h ${r.segKey}] N=${n} 单价不高于上一档`, p <= prev, `${p} > ${prev}`);
      prev = p;
    }
  }

  // ── ④ 反证 ────────────────────────────────────────────────────────────────
  const reverts = async (fn) => { try { await fn(); return false; } catch { return true; } };
  ok('(2,0) 团体·自助 非法', await reverts(() => c.segmentId(2, 0)));
  ok('(0,1) 众包·平台代付 非法', await reverts(() => c.segmentId(0, 1)));
  ok('(2,2) 非法', await reverts(() => c.segmentId(2, 2)));
  ok('(1,2)/(0,2) 预警增保已下线', (await reverts(() => c.segmentId(1, 2))) && (await reverts(() => c.segmentId(0, 2))));
  ok('segmentId(2,1)=0', (await c.segmentId(2, 1)) === 0n);
  ok('segmentId(1,1)=1', (await c.segmentId(1, 1)) === 1n);
  ok('segmentId(1,0)=2', (await c.segmentId(1, 0)) === 2n);
  ok('segmentId(0,0)=3', (await c.segmentId(0, 0)) === 3n);
  ok('bandOf(1)=0 / (10)=1 / (50)=2 / (100)=3 / (500)=4 / (1000)=5',
    (await c.bandOf(1)) === 0n && (await c.bandOf(10)) === 1n && (await c.bandOf(50)) === 2n
    && (await c.bandOf(100)) === 3n && (await c.bandOf(500)) === 4n && (await c.bandOf(1000)) === 5n);
  ok('bandOf 边界：9→0, 49→1, 99→2, 499→3, 999→4',
    (await c.bandOf(9)) === 0n && (await c.bandOf(49)) === 1n && (await c.bandOf(99)) === 2n
    && (await c.bandOf(499)) === 3n && (await c.bandOf(999)) === 4n);

  // MIN_PREMIUM 必须是 0.00002：拿 v3 最低价（北京 24h t2c1 N=1000 = 0.00007）写入，
  // 若还是 v2 的 0.0002 这里就会 revert —— 这正是本次改造的核心原因之一。
  const lowest = rows.filter((r) => r.sellable).map((r) => r.bands[5]).reduce((a, b) => (a < b ? a : b));
  ok('最低批量价 < v2 的 MIN_PREMIUM(0.0002) —— 故 v2 必然拒绝', lowest < 200000000000000n, `${lowest} wei`);

  // 单调性反证：band 必须"份数越多单价不增"。数值必须落在 [MIN_PREMIUM, PAYOUT_MAX)，
  // 否则会先被范围检查 revert，测不到单调性这一条。
  const DEC = 1000000000000n, R0 = 340000000000000n;
  const good = new Array(6).fill(0n).map((_, i) => R0 - BigInt(i) * DEC);       // 递减 → 合法
  ok('合法递减 band 可写入', !(await reverts(() => c.setPremiumRow.staticCall(1, 24, 0, R0, good, REASON))));
  const badInc = new Array(6).fill(0n).map((_, i) => R0 + BigInt(i) * DEC);     // 递增 → 非法
  ok('递增（违反"份数越多单价不增"）必须 revert', await reverts(() => c.setPremiumRow.staticCall(1, 24, 0, R0, badInc, REASON)));
  const belowMin = new Array(6).fill(1000n);                                     // 低于 MIN_PREMIUM → 非法
  ok('低于 MIN_PREMIUM 的 band 必须 revert', await reverts(() => c.setPremiumRow.staticCall(1, 24, 0, 1000n, belowMin, REASON)));
  const aboveMax = new Array(6).fill(20000000000000000n);                        // ≥ PAYOUT_MAX → 非法
  ok('≥ PAYOUT_MAX 的零售价必须 revert', await reverts(() => c.setPremiumRow.staticCall(1, 24, 0, 20000000000000000n, aboveMax, REASON)));
  const band0Mismatch = [R0 + DEC, R0, R0, R0, R0, R0];                           // band0 ≠ 零售 → 非法
  ok('band[0] ≠ 零售价必须 revert', await reverts(() => c.setPremiumRow.staticCall(1, 24, 0, R0, band0Mismatch, REASON)));

  // 不卖的格：读价 revert，但 quoteOrZero 给出 sellable=false（核验台要用）
  const q = await c.quoteOrZero(5, 72, 0, 0, 1);
  ok('成都 72h 众包自助 quoteOrZero → sellable=false', q[1] === false);
  const q2 = await c.quoteOrZero(2, 24, 2, 1, 1);
  ok('上海 24h 平台团体 quoteOrZero → sellable=true', q2[1] === true && q2[0] > 0n);

  console.log(`\n自检结果：${total} 项断言，${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'}`);
  fails.forEach((f) => console.log('  FAIL  ' + f));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
