/**
 * `04-脚本/feed-verify.js` 的断言（默认不打网络）
 * ============================================================================
 * 用法：node 07-测试工具/check-feed-verify.js          只跑判定规则的离线用例
 *       node 07-测试工具/check-feed-verify.js --live   额外真拉一次三个模型（需代理）
 *
 * 为什么不在 `npm test` 的五道门禁里：那五道的断言总数（232）被十份提交材料引用，
 * 加进来要挨个改材料里的数字，收益不成比例。这个脚本和 `check-html-syntax.js`
 * 一样，是「改了对应文件就该跑一次」的附加检查。
 */
const path = require("path");
const { gradeModels, fetchModelSeries, compareOnCommonDates, MODELS } =
  require(path.join(__dirname, "..", "04-脚本", "feed-verify.js"));

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}

/** 造一个模型序列：给 [[id, 累计mm], ...]，拆成两天，_map 供公共日期比对用 */
function mk(pairs) {
  return pairs.map(([id, mm]) => {
    const half = Math.round((mm / 2) * 10) / 10;
    const dates = ["2026-10-01", "2026-10-02"];
    return {
      id, label: id, org: "fixture", dates, dailyMm: [half, mm - half],
      _map: new Map([["2026-10-01", half], ["2026-10-02", mm - half]]), sum: mm,
    };
  });
}

console.log("\nfeed-verify 判定规则（离线用例）");

// 0. 模型清单必须与 ai-collect.js:45-48 一致 —— 喂价闸门与判定层读同一套模型
t("模型 id 顺序 = ecmwf_ifs025 / gfs_seamless / icon_seamless",
  JSON.stringify(MODELS.map((m) => m.id)) ===
  JSON.stringify(["ecmwf_ifs025", "gfs_seamless", "icon_seamless"]));

// 1. 三个都在容差内 → agree，置信 92，sources 3，mm = 中位数
{
  const v = gradeModels(mk([["a", 40], ["b", 42], ["c", 44]]));
  t("三个一致 → agree / 92 / 源 3 / mm=42",
    v.status === "agree" && v.agree === true && v.confidence === 92 &&
    v.sources === 3 && v.mm === 42, JSON.stringify({ s: v.status, c: v.confidence, m: v.mm }));
}

// 2. 一个离群、两个一致 → majority，置信 84，sources 2，列出离群模型
{
  const v = gradeModels(mk([["a", 10], ["b", 10], ["c", 90]]));
  t("一个离群 → majority / 84 / 源 2 / mm=10",
    v.status === "majority" && v.confidence === 84 && v.sources === 2 && v.mm === 10,
    JSON.stringify({ s: v.status, c: v.confidence, m: v.mm }));
  t("离群模型被点名", JSON.stringify(v.outlierModels) === JSON.stringify(["c"]));
}

// 3. 三个各说各话 → diverge，拒收（mm=null / 置信 40）
{
  const v = gradeModels(mk([["a", 0], ["b", 50], ["c", 100]]));
  t("三个都离群 → diverge / 拒收 / mm=null / 置信 40",
    v.status === "diverge" && v.agree === false && v.mm === null && v.confidence === 40,
    JSON.stringify({ s: v.status, m: v.mm, c: v.confidence }));
}

// 4. 只有两个模型可用、且一致 → agree，置信 88，sources 2
{
  const v = gradeModels(mk([["a", 20], ["b", 20.5]]));
  t("两个可用且一致 → agree / 88 / 源 2",
    v.status === "agree" && v.confidence === 88 && v.sources === 2 && v.mm === 20.3,
    JSON.stringify({ s: v.status, c: v.confidence, m: v.mm }));
}

// 5. 可用模型不足两个 → insufficient，拒收
{
  const v = gradeModels(mk([["a", 20]]));
  t("只剩一个模型 → insufficient / 拒收",
    v.status === "insufficient" && v.mm === null && v.confidence === 40);
}

// 6. 模型之间没有公共日期 → no-overlap，拒收
{
  const a = mk([["a", 20]])[0];
  const b = mk([["b", 20]])[0];
  b.dates = ["2026-11-01"];
  b._map = new Map([["2026-11-01", 20]]);
  const v = gradeModels([a, b]);
  t("没有公共日期 → no-overlap / 拒收",
    v.status === "no-overlap" && v.mm === null, JSON.stringify({ s: v.status }));
}

// 7. ★ 回归：36/42/47 这种「极差超容差、但三个都离中位数很近」必须判 agree，
//    不能报 majority 更不能打印空离群列表（这就是当初写错的地方）
{
  const v = gradeModels(mk([["a", 36], ["b", 42], ["c", 47]]));
  t("极差超容差但都在中位数附近 → agree（不是 majority）",
    v.status === "agree" && v.agree === true, JSON.stringify({ s: v.status, sp: v.spreadMm, tol: v.toleranceMm }));
  t("离群列表为空、说明里不出现「离群」",
    v.outlierModels.length === 0 && v.note.indexOf("离群") === -1, v.note);
}

// 8. 容差 1mm 地板：0.2 / 0.4 这种小雨不能被当成分歧
{
  const v = gradeModels(mk([["a", 0.2], ["b", 0.4]]));
  t("小雨 0.2/0.4 → agree（容差地板 1mm）",
    v.status === "agree" && v.agree === true && v.toleranceMm === 1, JSON.stringify({ s: v.status, tol: v.toleranceMm }));
}

// 9. 公共日期求和：只在两个模型都有值的日期上比
{
  const a = mk([["a", 20]])[0];
  const b = mk([["b", 20]])[0];
  a.dates = ["2026-10-01", "2026-10-02"];
  a._map = new Map([["2026-10-01", 5], ["2026-10-02", 5]]);
  b.dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  b._map = new Map([["2026-10-01", 5], ["2026-10-02", 5], ["2026-10-03", 99]]);
  const cmp = compareOnCommonDates([a, b]);
  t("只比公共日期（不把 10-03 的 99mm 算进来）",
    cmp.dates.length === 2 && cmp.perModel[1].mm === 10, JSON.stringify(cmp.perModel));
}

console.log(`\n${fail ? "❌" : "✅"} feed-verify 判定规则：${pass} 项通过 / ${fail} 项失败`);

/* ------------------------------------------------------------ 可选：真拉一次 */
if (process.argv.includes("--live")) {
  (async () => {
    const { REGIONS } = require(path.join(__dirname, "..", "04-脚本", "regions.js"));
    console.log("\n真拉三个模型（需要网络/代理）");
    const r = REGIONS[0];
    const series = await fetchModelSeries(r, null);
    const v = gradeModels(series);
    const okShape = ["agree", "majority", "diverge", "insufficient", "no-overlap"].includes(v.status) &&
      (v.agree === true ? typeof v.mm === "number" : v.mm === null);
    console.log(`  ${okShape ? "✅" : "❌"} ${r.name} 判定 = ${v.status}  ${v.agree ? v.mm + "mm" : "拒收"}`);
    console.log("     " + v.note);
    process.exit(okShape ? 0 : 1);
  })();
} else {
  process.exit(fail ? 1 : 0);
}
