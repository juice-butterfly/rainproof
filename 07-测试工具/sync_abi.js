/**
 * 把 03-合约/*.abi.json 同步进前端 HTML 的内嵌 ABI。
 *
 * 【为什么需要它】
 *   index.html 为了能单文件离线双击打开，把 ABI 内嵌在 `const ABI = [...]` 里。
 *   合约一改（比如改了事件参数、加了函数），ABI 如果没同步，页面**不会报任何错** ——
 *   它只会静默地查不到任何记录、事件表永远是空的。这是最难在演示现场发现的一类故障。
 *   所以把它做成一条命令，改完合约跑一下，物理上不可能忘。
 *
 * 【⚠️ 这个脚本原来会把 ABI「降级」】
 *   源文件默认写死 v1（RainDeliveryInsurance.abi.json，54 条），而演示页挂的是
 *   968 上的 **v2 合约**（内嵌 85 条）。跑一次 `npm run build`，页面的 v2 ABI 会被
 *   v1 覆盖 —— 页面不报错，只会静默地少认一批事件与字段。
 *   2026-10-08 的修法：**不再写死源**。默认先看页面里现在内嵌的是哪一版，按签名集合
 *   去 03-合约/ 里认领完全一致的那一份当源；认不出唯一一份就报错退出、一个字节都不写。
 *   要指定就 `--abi=v1|v2|v3|multisig`（或任意 abi.json 的文件名），要强行覆盖加 --force。
 *
 * 用法：
 *   node sync_abi.js                    # 自动认源（页面内嵌的那一版）后写入
 *   node sync_abi.js --check            # 只报告会怎么改，不写盘
 *   node sync_abi.js --abi=v2           # 指定源
 *   node sync_abi.js --force --abi=v1   # 明确要降级/换版（覆盖前请想清楚）
 *   node sync_abi.js --self-check       # 自检（认源逻辑 + 临时文件上的真写盘）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONTRACT_DIR = path.join(ROOT, "03-合约");
const TARGETS = [path.join(ROOT, "05-演示站点", "index.html")];
// 只匹配「整行就是一个 const ABI = [...];」的那种，且保留原文件的行尾（\r\n 或 \n）
const RE_SRC = "^const ABI = \\[.*?\\];([ \\t]*\\r?)$";
const RE = new RegExp(RE_SRC, "m");
const RE_G = new RegExp(RE_SRC, "gm");
// 简短别名 → 03-合约 下的文件名（不含 .abi.json）
const ALIAS = {
  v1: "RainDeliveryInsurance",
  v2: "RainDeliveryInsuranceV2",
  v3: "RainDeliveryInsuranceV3",
  multisig: "OperatorMultisig",
};

/* ------------------------------------------------------------------ 纯逻辑 */

/** 一个 ABI 条目 → 可比对的签名串（函数/事件/错误各带前缀；其它类型用 type+name 兜底） */
function sigOf(e) {
  const ins = (e.inputs || []).map((i) => i.type).join(",");
  if (e.type === "function") return `fn ${e.name}(${ins})`;
  if (e.type === "event") return `ev ${e.name}(${ins})`;
  if (e.type === "error") return `er ${e.name}(${ins})`;
  return `${e.type} ${e.name || ""}(${ins})`;
}
const setOf = (abi) => new Set(abi.map(sigOf));

/** 03-合约 下所有候选源 */
function loadCandidates() {
  return fs.readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith(".abi.json"))
    .map((f) => {
      const file = path.join(CONTRACT_DIR, f);
      return {
        name: f.replace(/\.abi\.json$/, ""),
        file,
        abi: JSON.parse(fs.readFileSync(file, "utf8")),
      };
    });
}

/** 候选与页面内嵌 ABI 的签名集合差 */
function score(cand, pageSet) {
  const A = setOf(cand.abi);
  const onlyPage = [...pageSet].filter((s) => !A.has(s));
  const onlyCand = [...A].filter((s) => !pageSet.has(s));
  return {
    same: [...pageSet].filter((s) => A.has(s)).length,
    onlyPage,
    onlyCand,
    exact: onlyPage.length === 0 && onlyCand.length === 0,
  };
}

/**
 * 选源：优先 --abi= 指定；否则按「与页面内嵌完全一致」认领。
 * 认不出唯一一份就抛错（宁可不写，也不静默换版）。
 */
function pickSource(pageAbi, { forced = null, candidates = loadCandidates() } = {}) {
  if (forced) {
    const want = (ALIAS[forced.toLowerCase()] || forced).toLowerCase();
    const hit = candidates.find((c) => c.name.toLowerCase() === want || c.name.toLowerCase().includes(want));
    if (!hit) {
      throw new Error(`--abi=${forced} 找不到对应的 abi.json；候选：${candidates.map((c) => c.name).join(" / ")}`);
    }
    return { cand: hit, why: `--abi=${forced} 指定` };
  }
  const pageSet = setOf(pageAbi);
  const scored = candidates.map((c) => ({ c, s: score(c, pageSet) }));
  const exact = scored.filter((x) => x.s.exact);
  if (exact.length === 1) {
    return { cand: exact[0].c, why: `与页面内嵌 ABI 完全一致（${pageAbi.length} 条签名全对得上）` };
  }
  if (exact.length > 1) {
    throw new Error(`页面内嵌 ABI 同时对上多份候选（${exact.map((x) => x.c.name).join(" / ")}），无法决定用哪份；请显式 --abi=<名称>`);
  }
  const lines = scored
    .sort((a, b) => b.s.same - a.s.same)
    .map((x) => `    ${x.c.name.padEnd(30)} ${String(x.c.abi.length).padStart(3)} 条  交集 ${String(x.s.same).padStart(3)}` +
                `  仅页面有 ${String(x.s.onlyPage.length).padStart(3)}  仅候选有 ${String(x.s.onlyCand.length).padStart(3)}`);
  throw new Error(
    `页面内嵌 ABI（${pageAbi.length} 条）跟 03-合约/ 里任何一份都不是完全一致 —— 拒绝瞎猜：\n` +
    lines.join("\n") +
    `\n  可能的情形：页面挂的合约与 03-合约/ 里的源码不同步（先 npm run compile:v2 之类重编），` +
    `或页面被手改过。确认后显式 --abi=<名称>，或 --force 强行覆盖。`
  );
}

/** 从 HTML 源码里取出内嵌 ABI（找不到 / 不唯一都算致命） */
function extractAbi(src, rel) {
  const hits = (src.match(RE_G) || []).length;
  if (hits !== 1) throw new Error(`${rel}: 期望恰好找到 1 处内嵌 ABI，实际 ${hits} 处 —— 拒绝写入`);
  return JSON.parse(src.match(RE)[0].replace(/^const ABI = /, "").replace(/;[ \t\r]*$/, ""));
}

/** 单个目标文件的同步。返回 {rel, source, before, after, changed, wrote, guarded} */
function syncOne(file, { forced = null, force = false, check = false, candidates = loadCandidates() } = {}) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  const current = extractAbi(src, rel);
  const { cand, why } = pickSource(current, { forced, candidates });
  const next = src.replace(RE, `const ABI = ${JSON.stringify(cand.abi)};$1`);
  const changed = next !== src;

  // ★ 降级守卫：绝不用「条目更少的 ABI」覆盖页面里已有的那份，除非显式 --force。
  // 自动认源那一支不可能触发它（认到的一定完全一致），所以这道闸门只挡 --abi= / 手改场景。
  if (cand.abi.length < current.length && !force && JSON.stringify(cand.abi) !== JSON.stringify(current)) {
    throw new Error(
      `${rel}: 拒绝把内嵌 ABI 从 ${current.length} 条换成 ${cand.abi.length} 条（${cand.name}）。\n` +
      `  覆盖之后页面不会报错，只会静默地少认事件与字段（最难在现场发现的一类故障）。\n` +
      `  确认要换版就加 --force；只是想同步请不加 --abi（自动认源会挑页面正在用的那一版）。`
    );
  }
  if (changed && !check) fs.writeFileSync(file, next, "utf8");
  return { rel, source: cand.name, why, before: current.length, after: cand.abi.length, changed, wrote: changed && !check };
}

/* ------------------------------------------------------------------ 命令行 */

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const h = argv.find((a) => a.startsWith(`${k}=`)); return h ? h.slice(k.length + 1) : null; };
  const opts = {
    forced: arg("--abi"),
    force: argv.includes("--force"),
    check: argv.includes("--check"),
  };
  let total = 0;
  for (const file of TARGETS) {
    const r = syncOne(file, opts);
    const tail = r.changed
      ? (r.wrote ? `✅ 已写入 ${r.after} 条（原 ${r.before} 条）` : `（--check）会写入 ${r.after} 条，原 ${r.before} 条`)
      : `= 无需改动（${r.before} 条）`;
    console.log(`${r.rel}\n    源 ${r.source}.abi.json —— ${r.why}\n    ${tail}`);
    total++;
  }
  console.log(`共同步 ${total} 处内嵌 ABI${opts.check ? "（--check：一个字节都没写）" : ""}`);
}

/* ------------------------------------------------------------------ 自检 */

function selfCheck() {
  let pass = 0, fail = 0;
  const ok = (m, c, extra = "") => { c ? (pass++, console.log(`  ✅ ${m}${extra ? "  " + extra : ""}`)) : (fail++, console.log(`  ❌ ${m}  ${extra}`)); };
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  // 构造两份假候选：A=3 条，B=2 条（B 是 A 的子集）
  const mk = (name, abi) => ({ name, file: `/x/${name}.abi.json`, abi });
  const F = (n, ins = []) => ({ type: "function", name: n, inputs: ins.map((t) => ({ type: t })) });
  const E = (n, ins = []) => ({ type: "event", name: n, inputs: ins.map((t) => ({ type: t })) });
  const A3 = [F("a"), F("b", ["uint256"]), E("e", ["address"])];
  const B2 = [F("a"), F("b", ["uint256"])];
  const cands = [mk("Alpha", A3), mk("Beta", B2)];

  ok("签名串区分类型与参数（fn/ev 前缀 + 参数表）",
    sigOf(F("b", ["uint256"])) === "fn b(uint256)" && sigOf(E("e", ["address"])) === "ev e(address)");
  ok("完全一致的那一份被认出来（唯一）",
    pickSource(A3, { candidates: cands }).cand.name === "Alpha");
  ok("只对上一半 → 拒绝瞎猜（抛错，不写盘）",
    !!throws(() => pickSource([F("a")], { candidates: cands })));
  const errMsg = throws(() => pickSource([F("a")], { candidates: cands })) || "";
  ok("拒绝时把各候选的差集摆出来（好排查）",
    /Alpha/.test(errMsg) && /仅页面有/.test(errMsg) && /仅候选有/.test(errMsg));
  ok("--abi 别名解析（v2 → RainDeliveryInsuranceV2）", (() => {
    const real = loadCandidates().find((c) => c.name === "RainDeliveryInsuranceV2");
    return !!real && pickSource(real.abi, { forced: "v2" }).cand.name === "RainDeliveryInsuranceV2";
  })());
  ok("--abi 报不存在的名字时把候选列出来",
    /候选/.test(throws(() => pickSource(A3, { forced: "nope", candidates: cands })) || ""));
  ok("页面里没有 / 有多处内嵌 ABI 都拒绝", (() => {
    const bad1 = "<html>没有 ABI</html>", bad2 = "const ABI = [];\nconst ABI = [];\n";
    return !!throws(() => extractAbi(bad1, "x")) && !!throws(() => extractAbi(bad2, "x"));
  })());

  // 真写盘：在临时目录上做（不碰仓库）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncabi-"));
  const tpl = (abi) => `<!doctype html>\n<html><body>\nconst ABI = ${JSON.stringify(abi)};\n</body></html>\n`;
  const tmp = path.join(dir, "index.html");

  fs.writeFileSync(tmp, tpl(A3), "utf8");
  const r1 = syncOne(tmp, { candidates: cands, check: true });
  ok("--check 认出源但一个字节都不写",
    r1.source === "Alpha" && r1.wrote === false && fs.readFileSync(tmp, "utf8") === tpl(A3));
  fs.writeFileSync(tmp, tpl(B2), "utf8");
  const r2 = syncOne(tmp, { candidates: cands, forced: "Alpha" });
  ok("--abi 指定后真的写进去了（B→A，条目变多）",
    r2.wrote === true && fs.readFileSync(tmp, "utf8") === tpl(A3));
  fs.writeFileSync(tmp, tpl(A3), "utf8");
  const r3 = syncOne(tmp, { candidates: cands });
  ok("已经是那一版 → 识别为无需改动（不产生无谓 diff）",
    r3.changed === false && r3.wrote === false);
  fs.writeFileSync(tmp, tpl(A3), "utf8");
  const guardMsg = throws(() => syncOne(tmp, { candidates: cands, forced: "Beta" })) || "";
  ok("降级守卫真的抛错、且告诉你怎么覆盖",
    /拒绝把内嵌 ABI 从 3 条换成 2 条/.test(guardMsg) && /--force/.test(guardMsg));
  ok("被守卫拦下时文件没被动过", fs.readFileSync(tmp, "utf8") === tpl(A3));
  const r5 = syncOne(tmp, { candidates: cands, forced: "Beta", force: true });
  ok("--force 明确要换版时放行",
    r5.wrote === true && fs.readFileSync(tmp, "utf8") === tpl(B2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录，清不掉也不影响结论 */ }

  console.log(`\n${fail ? "❌" : "✅"} sync_abi 自检：${pass} 项通过 / ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
}

module.exports = { sigOf, setOf, score, pickSource, extractAbi, syncOne, loadCandidates };

if (require.main === module && process.argv.includes("--self-check")) selfCheck();
else if (require.main === module) {
  try { main(); } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}
