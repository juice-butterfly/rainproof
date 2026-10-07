// 检查：降雨看板的「刻度」与「触发线」必须指同一个地方。
//
// 这个检查是为一个真实修过的 bug 立的桩：
//   条子按 0→阈值 画（阈值落在条尾），触发线却写死在 left:50%（=25mm），
//   于是页面上"50 在块的最后、触发线却在中间" —— 视觉上自相矛盾，评委一眼就能看出。
// 结论：错的是公式，不是线（触发线的标签挂在 calc(50% + 6px)，只有在阈值位于条子中间时才成立）。
//   修法：填充比例改成 v / (阈值 × 2)，刻度 0→100mm，触发线正好落在 50%。
//
// 跑法：node 07-测试工具/check-rainboard.js
const fs = require("fs");
const path = require("path");

const F = path.join(__dirname, "..", "05-演示站点", "index.html");
const H = fs.readFileSync(F, "utf8");

let pass = 0, fail = 0;
const ok = (t, c, x = "") => { if (c) { pass++; console.log("  [OK] " + t); } else { fail++; console.log("  [FAIL] " + t + (x ? "  -> " + x : "")); } };

console.log("\n[降雨看板] 刻度与触发线必须指同一个地方");
{
  // 1) 条子的填充公式：刻度必须是 2×阈值
  const m = H.match(/const pct = Math\.min\(100, Math\.round\(v \/ \(thr \* 2\) \* 100\)\);/);
  ok("填充公式是 v / (阈值 × 2) × 100", !!m, m ? "" : "没找到，公式可能又被改回 v/thr（那会让触发线落到中间）");

  // 2) 触发线（.bar::after）必须仍在 50%
  ok("触发线 .bar::after 在 left:50%", /\.bar::after\{[^}]*left:50%/.test(H));

  // 3) 触发线的文字标签在 50% 右边一点
  ok("触发线标签 .bar::before 在 calc(50% + 6px)", /\.bar::before\{[^}]*left:calc\(50% \+ 6px\)/.test(H));
}

// 4) 拿真链上五个区域的实际雨量算一遍：50mm 必须正好压在触发线上
const thr = 50;
const vals = [["武汉", 24], ["上海", 34], ["北京", 0], ["广州", 50], ["成都", 120]];
const pct = v => Math.min(100, Math.round(v / (thr * 2) * 100));
console.log("\n  阈值 50mm，条子满格 = 100mm，触发线在 50%：");
for (const [n, v] of vals) {
  const p = pct(v);
  console.log(`    ${n.padEnd(3)} ${String(v).padStart(3)} mm  → 填 ${String(p).padStart(3)}%   ${p === 50 ? "← 正好压在触发线上" : p > 50 ? "（冲过触发线）" : ""}`);
}
ok("50mm 的填充比例 == 触发线位置 50%", pct(50) === 50);
ok("24mm 明显在触发线左侧", pct(24) < 50, String(pct(24)));
ok("120mm 顶满条子", pct(120) === 100, String(pct(120)));
ok("没有区域被算成负数", vals.every(([, v]) => pct(v) >= 0));

console.log("\n" + "=".repeat(56));
console.log(`结果：${pass} 项通过 / ${fail} 项失败`);
console.log(fail === 0 ? "刻度与触发线已经指同一个地方了" : "还没对齐，别提交");
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
