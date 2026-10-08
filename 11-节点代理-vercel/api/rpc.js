// 只读 JSON-RPC 转发（Vercel Serverless Function）
//
// 为什么存在：BOT Chain 主网节点 rpc.botchain.ai 在**没有代理**的网络里连不上（实测直连 curl = 000），
// 而 Vercel 的函数跑在能直连它的机房里。把这个函数当节点用，任何网络下都能读主网 677。
//
// 用法：POST /api/rpc，body 就是标准 JSON-RPC（单个对象或数组都行）。
// 安全：**只放读方法**，eth_sendRawTransaction 之类一律 403 —— 免得变成一个谁都能拿来发交易的中继。
const UPSTREAM = process.env.RPC_UPSTREAM || "https://rpc.botchain.ai";

const READ_ONLY = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber", "eth_gasPrice",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockTransactionCountByNumber",
  "eth_syncing", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only / 只接受 POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
  if (!body) return res.status(400).json({ error: "empty body" });
  const items = Array.isArray(body) ? body : [body];
  for (const it of items) {
    const m = it && it.method;
    if (!READ_ONLY.has(m)) return res.status(403).json({ error: "method not allowed (read-only proxy): " + m });
  }

  try {
    const r = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: "upstream failed: " + (e && e.message) });
  }
};
