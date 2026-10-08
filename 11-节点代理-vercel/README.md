# 节点代理（Vercel Serverless Function）

**要解决的问题**：主网 RPC `https://rpc.botchain.ai` 在我们这边**必须走代理才通**（2026-10-08 实测：直连 curl = `000`，走 7890 = `200`）；测试网 `https://rpc.bohr.life` 反过来（直连 200，走代理 000）。队友的机器没有代理 ⇒ 演示页只读主网时会显示「节点连不上」。

这个函数跑在 Vercel 的机房里（能直连主网节点），把只读 JSON-RPC 转发出去 —— 于是**任何网络**下都能读 677 主网。

## 上线（两条命令，需要你自己的 Vercel 账号）

```powershell
cd D:\workbuddy-use\汉客松-参赛包\11-节点代理-vercel
npx vercel login          # 首次：浏览器/邮箱登录
npx vercel --prod         # 部署，输出里会有 https://<项目名>.vercel.app
```

部署完你会拿到一个地址，例如 `https://rainproof-rpc.vercel.app`，节点 URL 就是：

```
https://rainproof-rpc.vercel.app/api/rpc
```

## 怎么用

- 临时用（不用改代码）：演示页加参数
  `https://juice-butterfly.github.io/rainproof/?rpc=https://rainproof-rpc.vercel.app/api/rpc`
- 想让所有人默认就走代理：把 `/api/rpc` 这个地址加进
  `05-演示站点/index.html` 的 `RPC_NODES` **数组第一位**（`verifier.html` 的 `NODES` 同理）——
  主网、测试网两个官方节点留着当后备。

## 边界（别越界）

- **只放读方法**：`eth_sendRawTransaction`、`eth_sendTransaction` 等一律返回 403，避免变成谁都能拿来发交易的中继。
- 换上游：设 Vercel 环境变量 `RPC_UPSTREAM`（默认 `https://rpc.botchain.ai`）。
- 部署区域写在 `vercel.json`（默认 `hkg1` 香港，离节点近）。
- 本地自测：`node D:\DSH\_tmp\test-rpc-proxy.js`（不需要 Vercel，直接拿 mock 请求打这个 handler）。
