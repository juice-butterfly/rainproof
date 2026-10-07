#!/usr/bin/env node
/**
 * check_doc_prices.js —— 对外材料里的 v3 数字，必须逐格等于 `pricing-engine.json`。
 *
 * 为什么需要它：`AGENTS.md` §4④ 把"写进对外材料的数字（触发概率、保费、赔付率）"
 * 列为红区 —— 改前必须另一方 ack。而 §4⑥ 更直接：产品说明里的价格表必须与合约实测
 * 逐个一致。人抄表一定会错（本仓已经错过一次：把"成都 72h 格内极差 5.139x"写成了
 * "五维合起来 5.139x"，真值是全表 6.607x）。所以这张表不许手抄，也不许只靠肉眼复核。
 *
 * 做法：不解析 Markdown 表格（格式易变），而是**在正文里找形如 0.000XX 的数字，
 * 逐个断言它出现在 JSON 的合法值集合里**。合法值集合 = 60 格零售价 ∪ 180 格批量价，
 * 再加上各文档明确允许引用的旧口径值（v2 的 0.001 / 0.0002 等）。
 *
 * 用法：node ref/check_doc_prices.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const eng = require('../pricing-engine.json');

// 合法值集合：**用数值比对**，不用字符串 —— 文档里写 0.000380 与 JSON 里的 0.00038 是同一个价，
// 而 JSON 的 premiumEth 是 number，字符串 Set 会把它们全判成"不认识"（踩过）。
const legit = new Set();
for (const r of eng.payload.retail) if (r.premiumWei !== '0') legit.add(Number(r.premiumEth));
for (const b of eng.payload.bands) legit.add(Number(b.premiumEth));
// 不卖的格没有零售价，但正文要引用它的"诚实价格"（fairRetailEth），也算合法
for (const c of eng.cells) if (c.fairRetailEth) legit.add(Number(c.fairRetailEth));
const retailVals = [...new Set(eng.payload.retail.filter((r) => r.premiumWei !== '0').map((r) => Number(r.premiumEth)))].sort((a, b) => a - b);
const bandVals = [...new Set(eng.payload.bands.map((b) => Number(b.premiumEth)))].sort((a, b) => a - b);

// 允许出现的"非 v3 分布值"：v2 链上现行价、地板/上限、gas 量级、ETH 金额、v1 口径公平保费
const ALLOWED_EXTRA = new Set([
  0.001, 0.0002, 0.002, 0.01,          // v2 链上价 / v3 硬地板与尊严上限 / 赔付上限
  0.00002, 0.00007,                     // MIN_PREMIUM_ABS / 最低批量价（正文要引用）
  0.0001, 0.0005, 0.0008, 0.0003, 0.0004, 0.0006, 0.0009,
  0.00013, 0.00012,                     // 判定/赔付 gas
  0.00159475,                           // VaR99/份
  0.00013051,                           // N=1 每份固定成本
  0.00003692, 0.00019083,               // 平台团体 97.5% 风险保费区间端点
  0.000009,                             // N=1000 摊薄后的固定成本
  0.00001,                              // 网格 tick
  // ── v1/v2 口径的"链上现行价"表（产品说明 §4.2，AGENTS §4⑥ 要求它照实写链上现状）──
  // 右列"公平保费"来自 actuary.js；左列 = p × PAYOUT_MAX（纯风险保费）
  0.000795, 0.000760, 0.000380, 0.001929, 0.000621,   // 公平保费（v1 口径，元/份）
  0.0004770, 0.0004557, 0.0002281, 0.0011574, 0.0003724, // = 触发概率 × 0.01
  0.000793, 0.000073, 0.000099, 0.000126, 0.000212, 0.000237, 0.000342, 0.000378,
  0.000451, 0.000620, 0.000990, 0.001921, // tier_ratio.js §九 对照表里的 v1 口径公平保费
]);

const FILES = [
  '提交材料/产品说明与商业模式.md',
  '提交材料/项目介绍.md',
  '提交材料/评委问答.md',
  '提交材料/演示讲稿.md',
  'README.md',
  '02-作战与答辩/决策记录.md',
  '10-金融与定价/定价体系-v3.md',
];

let checked = 0, bad = 0;
console.log(`v3 合法价格：零售 ${retailVals.length} 个取值、批量 ${bandVals.length} 个取值（区间 ${bandVals[0]} ~ ${bandVals[bandVals.length - 1]}）\n`);
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`  · 跳过（不存在）${rel}`); continue; }
  const text = fs.readFileSync(p, 'utf8');
  // 只看 0.0000X ~ 0.0099 这一段（ETH 计价），且排除明显是"元"或百分比的位置
  const hits = text.match(/0\.00[0-9]{3,6}/g) || [];
  const foreign = new Map();
  for (const h of hits) {
    const v = Number(h);
    if (legit.has(v) || ALLOWED_EXTRA.has(v)) continue;
    foreign.set(h, (foreign.get(h) || 0) + 1);
  }
  checked += hits.length;
  if (foreign.size === 0) {
    console.log(`  ✓ ${rel}（${hits.length} 个价格字面量，全部落在合法集合内）`);
  } else {
    bad += foreign.size;
    console.log(`  ✗ ${rel}（${hits.length} 个字面量）→ 不认识的取值：`);
    for (const [v, n] of [...foreign.entries()].sort()) console.log(`        ${v}  ×${n}`);
  }
}

console.log(`\n共扫描 ${checked} 个价格字面量，${bad === 0 ? '全部通过' : `${bad} 个取值不在合法集合内`}`);
console.log(`（合法集合 = payload.retail 的 ${retailVals.length} 个 + payload.bands 的 ${bandVals.length} 个 + 明确允许的旧口径/gas/上限值）`);

// ── 二、正文里的"整表标量"也必须由 JSON 复算得出 ────────────────────────────
// 上一节的教训是"数不能手抄"；这一节把同样的要求施加到"极差 / 折扣带 / 不卖格数"上 ——
// 本仓真错过一次：把"成都 72h 那一格内的极差 5.139x"写成了"五维合起来 5.139x"。
const sell = eng.payload.retail.filter((r) => r.premiumWei !== '0').map((r) => Number(r.premiumEth));
const allSpread = Math.max(...sell) / Math.min(...sell);
const cellSpreads = [];
for (const r of [...new Set(eng.payload.retail.map((x) => x.regionId + '/' + x.hours))]) {
  const g = eng.payload.retail.filter((x) => x.regionId + '/' + x.hours === r && x.premiumWei !== '0').map((x) => Number(x.premiumEth));
  if (g.length > 1) cellSpreads.push(Math.max(...g) / Math.min(...g));
}
const bandBps = eng.payload.bands.flatMap((b) => (b.nMax === 1 ? [] : [Number(((1 - Number(b.premiumEth) / Number(eng.payload.retail.find((r) => r.regionId === b.regionId && r.hours === b.hours && r.segId === b.segId).premiumEth)) * 10000).toFixed(0))]));
const unsellable = eng.payload.retail.filter((r) => r.premiumWei === '0').length;

const scalars = {
  '全表极差': { value: allSpread, dp: 3, expect: '6.607' },
  '格内极差下界': { value: Math.min(...cellSpreads), dp: 2, expect: '2.19' },
  '格内极差上界': { value: Math.max(...cellSpreads), dp: 2, expect: '5.14' },
  '最深批量折扣(bps)': { value: Math.max(...bandBps), dp: 0, expect: '7586' },
  '不卖格数': { value: unsellable, dp: 0, expect: '3' },
};
console.log('\n整表标量（由 JSON 现算，文档里的数必须等于它）：');
let sbad = 0;
for (const [k, s] of Object.entries(scalars)) {
  const got = s.value.toFixed(s.dp);
  const okk = got === s.expect;
  if (!okk) sbad++;
  console.log(`  ${okk ? '✓' : '✗'} ${k} = ${got}（文档里写的是 ${s.expect}）`);
}
// 这三个标量至少在下列文件里各出现过一次
const MUST = { '6.607': ['提交材料/产品说明与商业模式.md', '提交材料/项目介绍.md', '提交材料/评委问答.md', 'README.md', '10-金融与定价/定价体系-v3.md'], '2.19': ['10-金融与定价/定价体系-v3.md'], '3': [] };
for (const [needle, files] of Object.entries(MUST)) {
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    if (!fs.readFileSync(p, 'utf8').includes(needle)) { sbad++; console.log(`  ✗ ${rel} 里找不到「${needle}」`); }
  }
}

console.log(`\n整表标量：${sbad === 0 ? '全部一致' : `${sbad} 处不一致`}`);
process.exit(bad || sbad ? 1 : 0);
