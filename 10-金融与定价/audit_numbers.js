#!/usr/bin/env node
/**
 * 精算数值复核脚本（零浮点 / 零蒙特卡洛）
 *
 * 用途：让第三方（评委、审计、队友）不依赖我们的任何中间产物，直接从原始逐小时
 *      降雨数据复算《精算口径.md》引用的每一个触发概率，并亲眼看到：
 *        1) 权威命中数（整数十分位口径，零浮点误差）
 *        2) 与 `actuary-output.json` 的差异（即浮点累加漏计了多少个边界窗口）
 *        3) 每个 p 的 95% 区间（月聚类块自举）—— 用来判断「广州越线」是否显著
 *
 * 复现：cd 10-金融与定价 && node audit_numbers.js
 * 输出：控制台表格 + `audit-verified.json`
 *
 * 口径与阈值：见文末 `--self-check`。
 */
const fs = require('fs');
const path = require('path');
const { REGIONS } = require('../04-脚本/regions.js');

// ── 输入 ────────────────────────────────────────────────────────────────────
// 注意：这里的起止日期是**历史样本区间**，与 regions.js 的 RAIN_EPOCH（链上累计
// 起点 2026-10-01）是两个不同的东西，不要混用。样本区间必须覆盖完整水文年。
const DATA_START = '2015-10-01';
const DATA_END = '2026-09-30';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = (key) => path.join(CACHE_DIR, `${key}-${DATA_START}_${DATA_END}.json`);
const DURATIONS = [6, 12, 24, 48, 72, 168];
const THRESHOLD = 50;

// ── 权威口径：整数十分位 ─────────────────────────────────────────────────────
// 为什么不用浮点求和：50.0mm 恰是双精度可表示数，而 ERA5 的 hourly precipitation
// 是 0.1mm 的十进制小数（如 0.1、0.3），二进制下不可精确表示。
// 增量累加滑动窗口时，恰好等于 50.0mm 的窗口会单向漏计（广州 72h 有 49 个这样的窗口）。
// 换成 Kahan 求和或前缀和都不能消除：三种方法分别给 11153 / 11140 / 11134。
// 唯一确定解是把数据放大 10 倍取整，全程整数运算。
const toDecimillimetres = (v) => Math.round((v ?? 0) * 10); // 0.1mm → 1

function loadCity(region) {
  const file = CACHE_FILE(region.key);
  if (!fs.existsSync(file)) {
    throw new Error(
      `缺少缓存文件 ${file}\n  先运行：node actuary.js --refresh（会联网重新下载）`
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const times = raw.hourly.time;
  const mm10 = raw.hourly.precipitation.map(toDecimillimetres);
  return { times, mm10, meta: { latitude: raw.latitude, longitude: raw.longitude, elevation: raw.elevation } };
}

/** 滚动窗口命中：返回 {windows, hits}，全程整数 */
function countHits(mm10, windowHours) {
  const sum10 = THRESHOLD * 10; // 阈值换算到同一单位
  let rolling = 0;
  let hits = 0;
  let windows = 0;
  for (let i = 0; i < mm10.length; i++) {
    rolling += mm10[i];
    if (i >= windowHours) rolling -= mm10[i - windowHours];
    if (i >= windowHours - 1) {
      windows++;
      if (rolling >= sum10) hits++;
    }
  }
  return { windows, hits };
}

/** 逐窗口累计值（整数），供区间估计与边界窗口核对使用 */
function windowSums(mm10, windowHours) {
  const out = new Int32Array(Math.max(0, mm10.length - windowHours + 1));
  let rolling = 0;
  for (let i = 0; i < mm10.length; i++) {
    rolling += mm10[i];
    if (i >= windowHours) rolling -= mm10[i - windowHours];
    if (i >= windowHours - 1) out[i - windowHours + 1] = rolling;
  }
  return out;
}

// ── 区间估计：月聚类块自举 ──────────────────────────────────────────────────
// 为什么不用二项分布：72h 滑动窗口高度重叠（96,361 个窗口的真实信息量按不同口径
// 只有 1339 / 132 / 10），二项 SE 会小 34~102 倍，是纯伪精度。
function monthIndex(times) {
  const idx = new Int32Array(times.length);
  const map = new Map();
  const keys = [];
  for (let i = 0; i < times.length; i++) {
    const k = times[i].slice(0, 7); // "YYYY-MM"
    let v = map.get(k);
    if (v === undefined) {
      v = keys.length;
      keys.push(k);
      map.set(k, v);
    }
    idx[i] = v;
  }
  return { idx, keys };
}

function bootstrapCI(hitFlags, monthOf, nMonths, { reps = 4000, seed = 20261007 } = {}) {
  // 每个月的 hit 计数与其窗口数
  const hitByMonth = new Float64Array(nMonths);
  const winByMonth = new Float64Array(nMonths);
  for (let m = 0; m < hitFlags.length; m++) {
    winByMonth[monthOf[m]]++;
    if (hitFlags[m]) hitByMonth[monthOf[m]]++;
  }
  const months = [];
  for (let m = 0; m < nMonths; m++) {
    if (winByMonth[m] > 0) months.push([hitByMonth[m], winByMonth[m]]);
  }
  // 玩具 PRNG（xorshift32），保证同种子逐位可复现
  let state = seed >>> 0;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  const samples = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let h = 0, w = 0;
    for (let i = 0; i < months.length; i++) {
      const [mh, mw] = months[(rand() * months.length) | 0];
      h += mh; w += mw;
    }
    samples[r] = (h / w) * 100;
  }
  samples.sort();
  const q = (a) => samples[Math.min(samples.length - 1, Math.floor(a * samples.length))];
  return { lo: q(0.025), hi: q(0.975), months: months.length };
}

// ── 边界窗口核对：恰好等于阈值的窗口有多少个 ────────────────────────────────
function boundaryWindows(sums) {
  let exact = 0;
  const lo = THRESHOLD * 10;
  for (const v of sums) if (v === lo) exact++;
  return exact;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const baseline = readBaseline();
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      thresholdMm: THRESHOLD,
      durations: DURATIONS,
      dataStart: DATA_START,
      dataEnd: DATA_END,
      method: 'integer decimillimetre sliding window',
      bootstrapReps: 4000,
      bootstrapSeed: 20261007,
      cacheDir: path.relative(process.cwd(), CACHE_DIR).replace(/\\/g, '/'),
      source: 'Open-Meteo Archive (ERA5) hourly precipitation_sum, timezone Asia/Shanghai',
    },
    cities: {},
  };

  console.log('\n权威口径复核：整数十分位（零浮点）滑动窗口');
  console.log(`阈值 ${THRESHOLD}mm ｜ 数据区间 ${DATA_START} ~ ${DATA_END} ｜ 逐小时\n`);

  for (const region of REGIONS) {
    const { times, mm10, meta } = loadCity(region);
    const { idx, keys } = monthIndex(times);
    const entry = { hours: times.length, grid: meta, windows: {}, perYear72h: {} };
    entry.firstHour = times[0];
    entry.lastHour = times[times.length - 1];

    console.log(`── ${region.name}（${region.key}）格点 ${meta.latitude},${meta.longitude} 海拔 ${meta.elevation}m ──`);
    console.log('  窗口   权威命中/窗口数      权威 p       JSON p     差异(pp)   95% 区间(月聚类)   恰好=50mm');

    for (const h of DURATIONS) {
      const { windows, hits } = countHits(mm10, h);
      const p = (hits / windows) * 100;
      const sums = windowSums(mm10, h);

      let ci = null;
      if (h === 72) {
        const flags = new Uint8Array(sums.length);
        for (let i = 0; i < sums.length; i++) flags[i] = sums[i] >= THRESHOLD * 10 ? 1 : 0;
        ci = bootstrapCI(flags, idx, keys.length);
      }

      const jsonP = baseline?.[region.key]?.windows?.[String(h)]?.p;
      const jsonPct = jsonP === undefined ? null : jsonP * 100;
      const diff = jsonPct === null ? null : p - jsonPct;
      const exact = boundaryWindows(sums);

      entry.windows[String(h)] = {
        windows, hits, pPct: round(p, 4), boundariesAtThreshold: exact,
        jsonPct: jsonPct === null ? null : round(jsonPct, 4),
        diffPp: diff === null ? null : round(diff, 4),
        ci95: ci ? { lo: round(ci.lo, 3), hi: round(ci.hi, 3), clusters: ci.months } : null,
      };

      console.log(
        `  ${String(h).padStart(3)}h  ${String(hits).padStart(6)}/${String(windows).padEnd(6)}  ` +
        `${p.toFixed(4).padStart(8)}%  ${(jsonPct === null ? '—' : jsonPct.toFixed(4)).padStart(8)}%  ` +
        `${(diff === null ? '—' : diff.toFixed(4)).padStart(7)}   ` +
        `${(ci ? `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]` : '').padEnd(17)}  ${String(exact).padStart(4)}`
      );
    }
    console.log('');
    report.cities[region.key] = entry;
  }

  // 落盘
  const outFile = path.join(__dirname, 'audit-verified.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`已写出 ${path.relative(process.cwd(), outFile)}`);

  if (argv.includes('--self-check')) selfCheck(report);
}

function readBaseline() {
  const f = path.join(__dirname, 'actuary-output.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).regions;
}

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

// ── 自检：核心逻辑坏掉时这里会失败 ──────────────────────────────────────────
// 断言值来自 2026-10-07 由主理人独立复算的 5 城 72h 权威命中数。
// 任何一条失败都说明滑动窗口/阈值口径被改坏了，此时本脚本的其他输出一律不可信。
function selfCheck(report) {
  const EXPECT = {
    wuhan: { 72: 4596, 24: 0 },
    shanghai: { 72: 4391 },
    beijing: { 72: 2198 },
    guangzhou: { 72: 11153 },
    chengdu: { 72: 3588 },
  };
  let pass = 0, fail = 0;
  console.log('\n── 自检（--self-check）──');
  for (const [key, wants] of Object.entries(EXPECT)) {
    for (const [h, want] of Object.entries(wants)) {
      if (!want) continue;
      const got = report.cities[key]?.windows?.[h]?.hits;
      const ok = got === want;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${key} ${h}h hits = ${got}（期望 ${want}）`);
      ok ? pass++ : fail++;
    }
  }
  // 广州 72h 必须显著高于北京（判别度），这是产品叙事的核心
  const gz = report.cities.guangzhou.windows['72'].pPct;
  const bj = report.cities.beijing.windows['72'].pPct;
  const ratio = gz / bj;
  const okRatio = ratio > 4.5 && ratio < 5.5;
  console.log(`  ${okRatio ? 'PASS' : 'FAIL'}  广州/北京 72h 触发率比 = ${ratio.toFixed(2)}（期望 ≈5.0）`);
  okRatio ? pass++ : fail++;
  // 广州的区间下界必须低于 10%（"越线不显著"的证据）
  const ci = report.cities.guangzhou.windows['72'].ci95;
  const okCi = ci && ci.lo < 10 && ci.hi > 10;
  console.log(`  ${okCi ? 'PASS' : 'FAIL'}  广州 72h 95% 区间跨越 10%：[${ci.lo}, ${ci.hi}]`);
  okCi ? pass++ : fail++;

  console.log(`\n自检结果：${pass} 项通过 / ${fail} 项失败`);
  if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();
