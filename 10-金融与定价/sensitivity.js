/**
 * 敏感性分析：触发概率 p 对「阈值」和「窗口长度」的依赖
 * ============================================================================
 *
 * 用途：回答评委的「为什么是 50mm」「为什么是 72 小时」——
 *       把这两个数从「拍的」变成「在 p–阈值–窗口 曲面上选的一个点」。
 *
 * 读的是 actuary.js 已经缓存的本地原始数据（cache/），不需要联网。
 *
 * 用法：node sensitivity.js
 */

const fs = require("fs");
const path = require("path");
const { REGIONS } = require("../04-脚本/regions.js");

const CACHE_DIR = path.join(__dirname, "cache");
const START = "2015-10-01";
const END = "2026-09-30";

const THRESHOLDS = [20, 30, 40, 50, 60, 80, 100];
const WINDOWS = [24, 48, 72];

const PAYOUT_ETH = 0.01;
const TARGET_LOSS_RATIO = 0.6;
const TICK = 0.0001;

function load(region) {
  const f = path.join(CACHE_DIR, `${region.key}-${START}_${END}.json`);
  if (!fs.existsSync(f)) {
    throw new Error(`缺缓存 ${f} —— 先跑一次 node actuary.js`);
  }
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return j.hourly.precipitation.map((v) => (v == null ? 0 : v));
}

/** 一次扫描同时统计所有阈值的命中数（避免每个阈值重扫一遍） */
function sweep(values, D, thresholds) {
  const n = values.length;
  const m = n - D + 1;
  const hits = thresholds.map(() => 0);
  let sum = 0;
  for (let i = 0; i < D; i++) sum += values[i];
  for (let t = 0; t < m; t++) {
    if (t > 0) sum += values[t + D - 1] - values[t - 1];
    for (let k = 0; k < thresholds.length; k++) {
      if (sum >= thresholds[k]) hits[k]++;
    }
  }
  return { windows: m, hits };
}

const ceilTick = (raw) => Math.ceil(raw / TICK - 1e-9) * TICK;

(async () => {
  console.log("=".repeat(78));
  console.log("敏感性分析：p 随「阈值 × 窗口长度」怎么变");
  console.log("=".repeat(78));
  console.log(`数据：本地缓存（Open-Meteo ERA5 逐小时，${START} ~ ${END}）`);
  console.log(`定价公式：保费 = ceil( p × PAYOUT(${PAYOUT_ETH}) ÷ 目标赔付率(${TARGET_LOSS_RATIO}) , ${TICK} )`);
  console.log("");

  const out = { thresholds: THRESHOLDS, windows: WINDOWS, regions: {} };

  for (const r of REGIONS) {
    const values = load(r);
    out.regions[r.key] = {};
    console.log(`── ${r.name} ─────────────────────────────────────────────`);
    console.log(`  窗口      ` + THRESHOLDS.map((t) => `≥${String(t).padStart(3)}mm`).join("   "));

    for (const D of WINDOWS) {
      const { windows, hits } = sweep(values, D, THRESHOLDS);
      const ps = hits.map((h) => h / windows);
      out.regions[r.key][D] = ps.map((p, i) => ({
        thresholdMm: THRESHOLDS[i],
        p: +p.toFixed(6),
        hits: hits[i],
        windows,
        fairPurePremium: +(p * PAYOUT_ETH).toFixed(6),
        suggestedPremium: +ceilTick((p * PAYOUT_ETH) / TARGET_LOSS_RATIO).toFixed(6),
      }));
      console.log(
        `  ${String(D).padStart(3)}h  ` +
          ps.map((p) => `${(p * 100).toFixed(3).padStart(6)}%`).join("  ")
      );
    }

    // 单独把「24h ≥ 50mm」这一格拎出来讲：它是国标的暴雨线
    const std = out.regions[r.key][24].find((x) => x.thresholdMm === 50);
    const at72 = out.regions[r.key][72].find((x) => x.thresholdMm === 50);
    console.log(
      `  → 国标暴雨线（24h ≥ 50mm）p=${(std.p * 100).toFixed(3)}%　` +
        `而合约现在用的是【任意窗口】≥50mm，72h 时 p=${(at72.p * 100).toFixed(3)}%（${(at72.p / std.p).toFixed(1)} 倍）`
    );
    console.log("");
  }

  // 杠杆：在“统一目标赔付率”下，杠杆不是设计变量而是 p 的倒数函数
  console.log("=".repeat(78));
  console.log("杠杆（PAYOUT ÷ 保费）在「统一 60% 目标赔付率」下是多少");
  console.log("=".repeat(78));
  console.log("  赔付率 = p × 杠杆，令其 = 0.60  ⟹  杠杆 = 0.60 ÷ p");
  console.log("");
  console.log("  城市     p(72h≥50)   实际杠杆    现状 0.001 的赔付率    保本线");
  for (const r of REGIONS) {
    const x = out.regions[r.key][72].find((y) => y.thresholdMm === 50);
    const lev = TARGET_LOSS_RATIO / x.p;
    const lossRatioNow = (x.p * PAYOUT_ETH) / 0.001;
    console.log(
      `  ${r.name.padEnd(6)} ${(x.p * 100).toFixed(3).padStart(8)}%  ${lev.toFixed(1).padStart(9)}x  ` +
        `${(lossRatioNow * 100).toFixed(0).padStart(16)}%  ${(100 / lev).toFixed(1).padStart(8)}%`
    );
  }
  console.log("");
  console.log("  ⇒ 「10 倍杠杆」只在一个城市恰好成立：p ≈ 6% 的那一个。");
  console.log("     固定 0.001 与 0.01 两个数 = 把杠杆写死成 10，等价于对所有城市假设 p<10%。");

  const f = path.join(__dirname, "sensitivity-output.json");
  fs.writeFileSync(f, JSON.stringify(out, null, 2), "utf8");
  console.log("");
  console.log(`明细已写入 ${path.relative(process.cwd(), f)}`);
})();
