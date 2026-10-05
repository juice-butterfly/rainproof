"""核对 Day 1 在真 Sepolia 上的链上事实（清单材料必须是真的，不能凭记忆写）。"""
import json
import ssl
import urllib.request

OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ssl.create_default_context())
)

NODES = [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.gateway.tenderly.co",
]


def rpc(method, params):
    for url in NODES:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                headers={"Content-Type": "application/json", "User-Agent": "probe/1.0"},
            )
            with OPENER.open(req, timeout=25) as r:
                j = json.loads(r.read())
            if "result" in j:
                print(f"      [节点 {url.split('/')[2]}]")
                return j["result"]
            print(f"      [节点 {url.split('/')[2]}] 错误: {j.get('error')}")
        except Exception as e:
            print(f"      [节点 {url.split('/')[2]}] 失败: {type(e).__name__}: {e}")
    return None


TX = "0xe45da6ef7ae55092d77a6c5b20e56699a7900854a9bfa3f2d8ed29f7b40a6453"
CONTRACT = "0x5f704090d2a2120806cc12a6ed538511354d82dc"
ACCOUNT = "0x9c7e8f1adb7303505bf1c31ba2212fbf28b4339a"

print("=" * 74)
print("① 部署交易", TX[:20] + "…")
print("=" * 74)
tx = rpc("eth_getTransactionByHash", [TX])
rc = rpc("eth_getTransactionReceipt", [TX])
if tx:
    print("   from        :", tx.get("from"))
    print("   to          :", tx.get("to"), "  ← None 表示部署合约交易")
    print("   nonce       :", int(tx.get("nonce", "0x0"), 16))
    print("   value       :", int(tx.get("value", "0x0"), 16), "wei")
if rc:
    print("   执行状态    :", int(rc.get("status", "0x0"), 16), " (1=成功)")
    print("   区块号      :", int(rc["blockNumber"], 16))
    print("   gasUsed     :", int(rc["gasUsed"], 16))
    print("   🎯 合约地址 :", rc.get("contractAddress"))

print()
print("=" * 74)
print("② 合约", CONTRACT)
print("=" * 74)
code = rpc("eth_getCode", [CONTRACT, "latest"])
if code is not None:
    n = (len(code) - 2) // 2
    print(f"   运行时代码长度: {n} 字节  ({'是合约 ✅' if n > 0 else '不是合约 ❌'})")

print()
print("=" * 74)
print("③ 账户", ACCOUNT)
print("=" * 74)
bal = rpc("eth_getBalance", [ACCOUNT, "latest"])
nonce = rpc("eth_getTransactionCount", [ACCOUNT, "latest"])
if bal:
    print("   余额 :", int(bal, 16) / 1e18, "SepETH")
if nonce:
    print("   nonce:", int(nonce, 16), " (已经发过几笔交易)")
