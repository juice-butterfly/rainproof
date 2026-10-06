/**
 * 链上查询小工具 —— 不依赖任何区块浏览器（OtterScan 挂 / Etherscan 打不开都能用）
 *
 * 用途：不确定交易到底成没成、合约地址是多少时，直接问节点，比任何网页都可靠。
 *
 * 优先用桌面上的「汉客松-链上核验台.html」（双击，更好看）。
 * 这个脚本是命令行兜底版 —— 核验台打不开时用它。
 *
 * 用法：
 *   node check-chain.js tx     0xe45da6...     # 查交易（自动打印合约地址）
 *   node check-chain.js addr   0x9c7e8f...     # 查账户（余额、发过几笔）
 *   node check-chain.js code   0x5f7040...     # 查合约（链上到底有没有代码）
 */

const { JsonRpcProvider } = require("ethers");

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
// 备用节点：publicnode 对「较旧的交易」会返回 null 回执（2026-10-06 实测：
// 对区块 11,833,556 的部署交易返回 null，tenderly 正常返回 status=1）。
// 注意 ankr 已失效——现在要求 API key，匿名调用报 -32000 Unauthorized，不要加回来。
const FALLBACK_RPCS = ["https://sepolia.gateway.tenderly.co"];

async function main() {
  const [mode, value] = process.argv.slice(2);

  if (!mode || !value) {
    console.log("用法：");
    console.log("  node check-chain.js tx   0x<交易哈希>");
    console.log("  node check-chain.js addr 0x<账户地址>");
    console.log("  node check-chain.js code 0x<合约地址>");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  console.log("网络 :", net.name, "chainId =", net.chainId.toString());
  console.log("RPC  :", RPC);
  console.log("-".repeat(60));

  if (mode === "tx") {
    const tx = await provider.getTransaction(value);
    if (!tx) {
      console.log("❌ 找不到这笔交易。可能是：哈希不完整 / 不在 Sepolia / 还没被确认");
      process.exit(1);
    }
    let rc = await provider.getTransactionReceipt(value);
    if (!rc) {
      // 主节点没返回回执 → 换备用节点拿一次，别直接判死
      for (const u of FALLBACK_RPCS) {
        try {
          const r2 = await new JsonRpcProvider(u).getTransactionReceipt(value);
          if (r2) { rc = r2; console.log("回执来源 :", u, "（主节点没返回，这里是备用节点）"); break; }
        } catch (e) { /* 试下一个 */ }
      }
    }
    console.log("区块号   :", tx.blockNumber);
    console.log("from     :", tx.from);
    console.log("to       :", tx.to ?? "(空 —— 这是部署合约的交易)");
    if (!rc) {
      console.log("执行状态 : ⚠️ 两个节点都没返回交易回执（receipt 为 null）");
      console.log("           交易本身已经上链（在区块里），但拿不到 status / gasUsed / 部署地址。");
      console.log("           过几分钟再跑一次通常就好。");
      process.exit(0);
    }
    console.log("执行状态 :", rc.status === 1 ? "✅ 成功" : "❌ 失败");
    console.log("Gas 用了 :", rc.gasUsed.toString());
    if (rc.contractAddress) {
      console.log("");
      console.log("🎯 部署出来的合约地址 :", rc.contractAddress);
    }
  } else if (mode === "addr") {
    const bal = await provider.getBalance(value);
    const nonce = await provider.getTransactionCount(value);
    console.log("地址  :", value);
    console.log("余额  :", (Number(bal) / 1e18).toFixed(6), "SepETH");
    console.log("发过  :", nonce, "笔交易（nonce）");
  } else if (mode === "code") {
    const code = await provider.getCode(value);
    if (!code || code === "0x") {
      console.log("❌ 这个地址上【没有合约代码】—— 说明它不是合约，或者部署失败了");
      process.exit(1);
    }
    console.log("✅ 这个地址上【有合约代码】");
    console.log("代码长度 :", (code.length - 2) / 2, "字节");
    console.log("地址     :", value);
  } else {
    console.log("未知模式：", mode);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ 出错：", e.message || e);
  process.exit(1);
});
