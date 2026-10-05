"""生成端到端测试页：copy index.html，在最前面插入一个转发到本地链的假 window.ethereum。

同时把每一次 EIP-1193 调用直接渲染到页面上（不用定时器）——
因为无头浏览器的 --virtual-time-budget 会把 setTimeout 瞬间跑完，toast 一闪就没了。
"""
import json
import pathlib

S = pathlib.Path(__file__).resolve().parent.parent / "05-演示站点"
html = (S / "index.html").read_text(encoding="utf-8")

# 本地链信息：假钱包只暴露 riderA（持有保单的那个账户）
CHAIN = json.loads((pathlib.Path(__file__).parent / "_local_chain.json").read_text(encoding="utf-8"))
WALLET_ACCOUNT = CHAIN["riderA"]

SHIM = """
<script id="MOCKWALLET">
/* 测试用假钱包：把所有 EIP-1193 请求转发给本地 ganache（它会自动签名）。
   用 text/plain —— 免 CORS 预检；ganache 不回 Access-Control-Allow-Headers。 */
window.__MOCK__ = true;
window.__WALLET_ACCOUNT__ = "@@ACCOUNT@@";
var __LOG = [];
var __box = null;
function __late(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}
function __log(s) {
  __LOG.push(s);
  __late(function () {
    if (!__box) {
      __box = document.createElement("div");
      __box.style.cssText = "position:fixed;left:0;bottom:0;z-index:99999;background:#000;color:#0f0;"
        + "font:11px/1.5 monospace;padding:6px 9px;max-width:100%;white-space:pre-wrap;border-top:1px solid #0f0";
      document.body.appendChild(__box);
    }
    __box.textContent = __LOG.join("\\n");
  });
}
window.__LOG = __LOG;
window.addEventListener("error", function (e) { __log("JS ERROR: " + (e.message || e)); });
window.addEventListener("unhandledrejection", function (e) {
  __log("UNHANDLED: " + ((e.reason && (e.reason.shortMessage || e.reason.message)) || e.reason));
});

window.ethereum = {
  isMetaMask: true,
  _id: 1,
  request: async function (arg) {
    var method = arg.method, params = arg.params;
    // 这几个是「钱包方法」，节点没有 —— 假钱包自己接管
    // ★ 真钱包只会返回「当前用户自己的账户」，不会把一个节点上的全部账户都吐出来。
    //   所以这里必须只暴露 riderA（账户列表的第 2 个），否则页面 accts[0] 会拿到 operator，
    //   而 operator 名下没有保单 → 「我的保单」永远是空的。这是测试夹具的失真，不是页面的 bug。
    if (method === "eth_requestAccounts" || method === "eth_accounts") {
      var only = window.__WALLET_ACCOUNT__;
      __log("← " + method + " ok  [假钱包只暴露 " + String(only).slice(0, 10) + "…]（模拟真实钱包）");
      return only ? [only] : [];
    }
    if (method === "wallet_switchEthereumChain") { __log("→ " + arg.method + "（假钱包直接放行）"); return null; }
    if (method === "wallet_addEthereumChain") { __log("→ " + arg.method + "（假钱包直接放行）"); return null; }
    __log("→ " + method);
    try {
      var r = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: window.ethereum._id++, method: method, params: params || [] })
      });
      var j = await r.json();
      if (j.error) { var e = new Error(j.error.message); e.code = j.error.code; throw e; }
      __log("← " + method + " ok  " + String(JSON.stringify(j.result)).slice(0, 70));
      return j.result;
    } catch (err) {
      __log("← " + method + " FAIL " + (err.message || err));
      throw err;
    }
  },
  on: function () {}, removeListener: function () {}
};
__log("mock wallet 已注入, typeof window.ethereum = " + typeof window.ethereum);

/* ---- 测试脚本：等页面渲染完，自动点一次「申请赔付」，把写入路径也测掉 ---- */
(function () {
  var tries = 0, clicked = false;
  var iv = setInterval(function () {
    tries++;
    if (clicked) return;
    var btn = document.querySelector("[data-claim]:not([disabled])");
    if (btn) {
      clicked = true;
      __log(">>> 自动点击： " + btn.textContent.trim());
      btn.click();
      clearInterval(iv);
    }
    if (tries > 60) { __log(">>> 没找到可点的赔付按钮（保单可能都不在 claimable 状态）"); clearInterval(iv); }
  }, 250);
})();
</script>
"""

assert "</head>" in html
# ★ 占位符必须与 JS 变量名不同名 —— 否则 str.replace 会把 `window.__WALLET_ACCOUNT__`
#   里的同名子串一起换掉，生成 `window.0xabc…` 这种非法赋值，整段脚本直接 SyntaxError。
SHIM = SHIM.replace("@@ACCOUNT@@", WALLET_ACCOUNT)
assert "@@ACCOUNT@@" not in SHIM and "window.0x" not in SHIM, "占位符替换有误"
html = html.replace("</head>", SHIM + "</head>", 1)
out = S / "_e2e_index.html"
out.write_text(html, encoding="utf-8")
print("已生成", out, len(html), "字符")
print("假钱包账户（只暴露这一个）:", WALLET_ACCOUNT)
print("合约地址:", CHAIN["addr"], "｜ RPC:", CHAIN["rpc"])

# ★ 自检：把每个 <script> 抽出来交给 node --check，避免「占位符替换把变量名也换掉」
#   这类只在浏览器里才暴露的语法错误（上一版就是这么静默哑火的）。
import re
import subprocess
import tempfile

NODE = r"C:\Users\Lenovo\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
bad = 0
for i, code in enumerate(scripts):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(code)
        tmp = f.name
    r = subprocess.run([NODE, "--check", tmp], capture_output=True, text=True)
    if r.returncode != 0:
        bad += 1
        print(f"  ❌ 内联脚本 #{i} 语法错误：{r.stderr.strip().splitlines()[:3]}")
        print("     片段：", code.strip()[:160].replace("\n", " "))
    pathlib.Path(tmp).unlink(missing_ok=True)
print(f"内联脚本语法自检：{len(scripts)} 段，{len(scripts) - bad} 段通过" + ("" if not bad else f"，{bad} 段失败"))
