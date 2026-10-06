/**
 * 把 03-合约/RainDeliveryInsurance.abi.json 同步进前端 HTML 的内嵌 ABI。
 *
 * 【为什么需要它】
 *   index.html 为了能单文件离线双击打开，把 ABI 内嵌在 `const ABI = [...]` 里。
 *   合约一改（比如改了事件参数、加了函数），ABI 如果没同步，页面**不会报任何错** ——
 *   它只会静默地查不到任何记录、事件表永远是空的。这是最难在演示现场发现的一类故障。
 *   所以把它做成一条命令，改完合约跑一下，物理上不可能忘。
 *
 * 用法：node sync_abi.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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
  const src = fs.readFileSync(file, "utf8");
  const hits = (src.match(RE_G) || []).length;
  if (hits !== 1) {
    throw new Error(`${path.relative(ROOT, file)}: 期望恰好找到 1 处内嵌 ABI，实际 ${hits} 处 —— 拒绝写入`);
  }
  fs.writeFileSync(file, src.replace(RE, `const ABI = ${compact};$1`), "utf8");
  console.log(`✅ ${path.relative(ROOT, file)}  ← ${abi.length} 个 ABI 条目`);
  total += hits;
}
console.log(`共同步 ${total} 处内嵌 ABI（源头：03-合约/RainDeliveryInsurance.abi.json）`);
