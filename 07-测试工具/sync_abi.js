/**
 * 把 03-合约/RainDeliveryInsurance.abi.json 同步进前端 HTML 的内嵌 ABI。
 *
 * 【为什么需要它】
 *   index.html 为了能单文件离线双击打开，把 ABI 内嵌在 `const ABI = [...]` 里。
 *   合约一改（比如改了事件参数、加了函数），ABI 如果没同步，页面**不会报任何错** ——
 *   它只会静默地查不到任何记录、事件表永远是空的。这是最难在演示现场发现的一类故障。
 *   所以把它做成一条命令，改完合约跑一下，物理上不可能忘。
 *
 * 【⚠️ 反过来的坑：这个脚本会把 ABI「降级」】
 *   源文件写死是 v1（RainDeliveryInsurance.abi.json，54 条），而演示页挂的是
 *   **968 上的 v2 合约**（内嵌 ABI 85 条）。所以今天跑一次 `npm run build`，
 *   页面里那份 v2 ABI 会被 v1 覆盖 —— 页面不会报错，只会**静默地少认一批事件与字段**。
 *   对策（下面那段降级守卫）：内嵌条目数比源多时直接拒绝写入并退出非零，
 *   要真降级得显式加 --force。
 *   ⚠️ 但守卫只是止血 —— 正确的修法是让源文件指向页面真正在用的那份 ABI
 *   （见 07-测试工具/ 讨论记录：--abi=v2 或按页面里的 CONTRACT_ADDRESS 选源），
 *   这一步涉及「演示页到底该内嵌哪一版」的口径，未改。
 *
 * 用法：node sync_abi.js [--force]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FORCE = process.argv.includes("--force");
const abi = JSON.parse(
  fs.readFileSync(path.join(ROOT, "03-合约", "RainDeliveryInsurance.abi.json"), "utf8")
);
const compact = JSON.stringify(abi);

const TARGETS = [path.join(ROOT, "05-演示站点", "index.html")];
// 只匹配「整行就是一个 const ABI = [...];」的那种，且保留原文件的行尾（\r\n 或 \n）
const RE_SRC = "^const ABI = \\[.*?\\];([ \\t]*\\r?)$";
const RE = new RegExp(RE_SRC, "m");
const RE_G = new RegExp(RE_SRC, "gm");

let total = 0;
for (const file of TARGETS) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  const hits = (src.match(RE_G) || []).length;
  if (hits !== 1) {
    throw new Error(`${rel}: 期望恰好找到 1 处内嵌 ABI，实际 ${hits} 处 —— 拒绝写入`);
  }
  // ★ 降级守卫：绝不用「条目更少的 ABI」覆盖页面里已有的那份。
  const current = JSON.parse(src.match(RE)[0].replace(/^const ABI = /, "").replace(/;[ \t\r]*$/, ""));
  if (current.length > abi.length && !FORCE) {
    throw new Error(
      `${rel}: 拒绝把内嵌 ABI 从 ${current.length} 条降级成源文件的 ${abi.length} 条。\n` +
      `  源文件 03-合约/RainDeliveryInsurance.abi.json 是 v1，而演示页挂的是链上的 v2 合约；\n` +
      `  覆盖之后页面不会报错，只会静默地少认事件与字段（最难在现场发现的一类故障）。\n` +
      `  排查：确认页面里 CONTRACT_ADDRESS 指向哪一版合约，改用那一版的 abi.json 做源；\n` +
      `  确实要降级（例如换回 v1 合约）再显式加 --force 重跑。`
    );
  }
  fs.writeFileSync(file, src.replace(RE, `const ABI = ${compact};$1`), "utf8");
  console.log(`✅ ${rel}  ← ${abi.length} 个 ABI 条目（原 ${current.length} 条）`);
  total += hits;
}
console.log(`共同步 ${total} 处内嵌 ABI（源头：03-合约/RainDeliveryInsurance.abi.json）`);
