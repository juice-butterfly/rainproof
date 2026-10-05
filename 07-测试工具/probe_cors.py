"""验证浏览器跨域可行性：OPTIONS 预检 + 免预检的简单请求写法。"""
import json, time, urllib.request, urllib.error

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
RPC = "https://ethereum-sepolia-rpc.publicnode.com"
CONTRACT = "0x5f704090d2a2120806cc12a6ed538511354d82dc"
ORIGIN = "null"   # file:// 页面发出的 Origin 就是字符串 "null"

print("=" * 78)
print("A) OPTIONS 预检（application/json 会触发这个）")
print("=" * 78)
try:
    req = urllib.request.Request(RPC, method="OPTIONS", headers={
        "Origin": ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "User-Agent": "Mozilla/5.0",
    })
    t0 = time.time()
    with OPENER.open(req, timeout=15) as r:
        h = {k.lower(): v for k, v in r.headers.items()}
        print(f"HTTP {r.status}  {(time.time()-t0)*1000:.0f}ms")
        for k in ["access-control-allow-origin", "access-control-allow-methods",
                  "access-control-allow-headers", "access-control-max-age"]:
            print(f"   {k}: {h.get(k, '(缺)')}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}  ← 预检不通过，就不能用 application/json")
    print("   响应头:", {k.lower(): v for k, v in e.headers.items()
                        if k.lower().startswith("access-control")})
except Exception as e:
    print(f"{type(e).__name__}: {e}")

print()
print("=" * 78)
print("B) 免预检的简单请求：Content-Type: text/plain")
print("=" * 78)
for ct in ["text/plain", "text/plain;charset=UTF-8"]:
    try:
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getCode",
                              "params": [CONTRACT, "latest"]}).encode()
        req = urllib.request.Request(RPC, data=payload, headers={
            "Content-Type": ct, "Origin": ORIGIN, "User-Agent": "Mozilla/5.0"})
        t0 = time.time()
        with OPENER.open(req, timeout=15) as r:
            res = json.loads(r.read().decode())
            h = {k.lower(): v for k, v in r.headers.items()}
            print(f"✅ Content-Type: {ct}  HTTP {r.status}  {(time.time()-t0)*1000:.0f}ms")
            print(f"   返回代码长度: {max(0,(len(res['result'])-2)//2)} 字节")
            print(f"   AC-Allow-Origin: {h.get('access-control-allow-origin','(缺)')}")
    except Exception as e:
        print(f"❌ Content-Type: {ct} → {type(e).__name__}: {str(e)[:80]}")

print()
print("=" * 78)
print("C) 备选节点也测一遍（万一 publicnode 抽风）")
print("=" * 78)
payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
for url in ["https://ethereum-sepolia-rpc.publicnode.com",
            "https://rpc.ankr.com/eth_sepolia",
            "https://sepolia.gateway.tenderly.co",
            "https://sepolia-rpc.publicnode.com",
            "https://endpoints.omniatech.io/v1/eth/sepolia/public"]:
    try:
        req = urllib.request.Request(url, data=payload, headers={
            "Content-Type": "text/plain", "Origin": ORIGIN, "User-Agent": "Mozilla/5.0"})
        t0 = time.time()
        with OPENER.open(req, timeout=15) as r:
            res = json.loads(r.read().decode())
            h = {k.lower(): v for k, v in r.headers.items()}
            print(f"✅ {url}")
            print(f"     chainId={int(res['result'],16)}   {(time.time()-t0)*1000:.0f}ms   "
                  f"CORS={h.get('access-control-allow-origin','(缺)')}")
    except Exception as e:
        print(f"❌ {url} → {type(e).__name__}: {str(e)[:60]}")
