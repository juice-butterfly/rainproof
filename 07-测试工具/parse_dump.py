"""从 --dump-dom 的产物里抽出：① 假钱包日志框 ② 我的保单区 ③ 事件流 ④ toast 内容。"""
import re
import sys
import pathlib

p = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "dump5.html")
html = p.read_text(encoding="utf-8", errors="replace")


def strip_tags(s):
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    return re.sub(r"[ \t]+", " ", s).strip()


# ① 假钱包日志框：Chrome 序列化时会把它写成 "position: fixed; left: 0px; ..."（带空格），
#    所以不能按紧贴的分号写法匹配 —— 用 z-index:99999 这个特征值定位。
print("=" * 78)
print("① 假钱包日志（页面左下角那个黑框）")
print("=" * 78)
m = re.search(r'<div style="[^"]*99999[^"]*"[^>]*>(.*?)</div>', html, re.S)
print(strip_tags(m.group(1)) if m else "  （没找到日志框 —— 说明 SHIM 没被注入或脚本没执行）")

# ② 我的保单
print()
print("=" * 78)
print("② 我的保单 #myPolicies")
print("=" * 78)
m = re.search(r'id="myPolicies"[^>]*>(.*?)(?=<div[^>]*id=|<section|<h2|$)', html, re.S)
print(strip_tags(m.group(1))[:1200] if m else "（没找到 #myPolicies）")

# ③ 事件流
for key in ("eventList", "events", "chainEvents", "feed"):
    m = re.search(r'id="%s"[^>]*>(.*?)(?=<div[^>]*id=|<section|<h2|$)' % key, html, re.S)
    if m:
        print()
        print("=" * 78)
        print("③ 事件流 #%s" % key)
        print("=" * 78)
        print(strip_tags(m.group(1))[:1200])
        break

# ④ toast / 状态条
print()
print("=" * 78)
print("④ 状态条 & 关键文本")
print("=" * 78)
for key in ("modeText", "netText", "walletBtn", "poolText", "toast"):
    m = re.search(r'id="%s"[^>]*>(.*?)</' % key, html, re.S)
    if m:
        print(f"  #{key} = {strip_tags(m.group(1))[:200]!r}")

# ⑤ 所有 data-claim 按钮
print()
print("=" * 78)
print("⑤ 页面里的赔付按钮 [data-claim]")
print("=" * 78)
btns = re.findall(r'<button[^>]*data-claim[^>]*>(.*?)</button>', html, re.S)
if not btns:
    print("  （一个都没有）")
for b in btns:
    print("  •", strip_tags(b)[:120])
# 看看有没有 disabled
for m in re.finditer(r'<button([^>]*data-claim[^>]*)>', html):
    print("  attr:", m.group(1)[:180])
