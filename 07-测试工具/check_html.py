"""把 HTML 里的 <script> 抽出来，用 node --check 做语法自检。"""
import re, subprocess, sys, pathlib

HTML = pathlib.Path(r"C:\Users\Lenovo\Desktop\汉客松-链上核验台.html")
NODE = r"C:\Users\Lenovo\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

html = HTML.read_text(encoding="utf-8")
print(f"HTML 大小: {len(html)} 字节")

scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
print(f"找到 {len(scripts)} 段 script")

out = pathlib.Path(r"C:\Users\Lenovo\WorkBuddy\workbuddy-use\_hackathon\tools\_extracted.js")
out.write_text("\n".join(scripts), encoding="utf-8")

r = subprocess.run([NODE, "--check", str(out)], capture_output=True, text=True)
print("node --check 退出码:", r.returncode)
if r.stdout.strip():
    print("stdout:", r.stdout.strip()[:2000])
if r.stderr.strip():
    print("stderr:", r.stderr.strip()[:2000])
if r.returncode == 0:
    print("✅ JS 语法没问题")

print()
print("--- 自检清单 ---")
checks = [
    ("有 fetch 直连 RPC", "ethereum-sepolia-rpc.publicnode.com" in html),
    ("用 text/plain 免预检", "text/plain;charset=UTF-8" in html),
    ("有节点自动降级", html.count("NODES") >= 3),
    ("有合约地址预置", "0x5f704090d2a2120806cc12a6ed538511354d82dc" in html),
    ("有交易哈希预置", "0xe45da6ef7ae55092d77a6c5b20e56699a7900854a9bfa3f2d8ed29f7b40a6453" in html),
    ("有 eth_getCode", "eth_getCode" in html),
    ("有 eth_getLogs", "eth_getLogs" in html),
    ("有 chainId 校验", "11155111" in html),
    ("无外链 CDN 依赖", "cdn." not in html and "unpkg" not in html and "jsdelivr" not in html),
    ("地址长度自检", "长度 ${hash.length}" in html or "hash.length" in html),
]
for name, ok in checks:
    print(("✅ " if ok else "❌ ") + name)
