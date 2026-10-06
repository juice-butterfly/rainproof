/**
 * 把合约部署到 Sepolia（不依赖任何浏览器插件）
 *
 * 用法：
 *   1) npm install
 *   2) 把 .env.example 复制成 .env，填上 PRIVATE_KEY
 *   3) 从 Remix 的 Compile 面板点「ABI」→ 把复制到的内容整段粘进 abi.json（替换里面的 []）
 *      点「Bytecode」→ 把复制到的那一长串粘进 bytecode.txt
 *   4) npm run deploy
 *
 * 这个脚本会把合约地址打印出来，并告诉你用「链上核验台」怎么验证。
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, ContractFactory } = require("ethers");

const ABI_FILE = path.join(__dirname, "abi.json");
const BYTECODE_FILE = path.join(__dirname, "bytecode.txt");

function readAbi() {
  if (!fs.existsSync(ABI_FILE)) throw new Error("找不到 abi.json");
  const raw = fs.readFileSync(ABI_FILE, "utf8").trim();
  if (!raw || raw === "[]") {
    throw new Error("abi.json 还是空的 —— 请把 Remix 里点「ABI」复制到的整段内容粘进去");
  }
  try {
    const abi = JSON.parse(raw);
    if (!Array.isArray(abi) || abi.length === 0) {
      throw new Error("不是非空数组");
    }
    return abi;
  } catch (e) {
    throw new Error(
      "abi.json 不是合法的 JSON：" + e.message +
      "\n  提示：要粘的是 Remix 复制出来的【整个方括号数组】，含 [ 和 ]"
    );
  }
}

function readBytecode() {
  if (!fs.existsSync(BYTECODE_FILE)) throw new Error("找不到 bytecode.txt");
  const raw = fs.readFileSync(BYTECODE_FILE, "utf8").trim();
  if (!raw || raw === "0x" || raw.length < 10) {
    throw new Error(
      "bytecode.txt 还是空的 —— 请把 Remix 里点「Bytecode」复制到的那一长串 0x… 粘进去"
    );
  }
  if (!raw.startsWith("0x")) {
    throw new Error("bytecode.txt 应该以 0x 开头");
  }
  return raw;
}

// 已知真链：chainId → 显示名。RPC 由 .env 的 SEPOLIA_RPC 指定（变量名沿用，指哪条链由它自己答）。
const KNOWN_CHAINS = { 11155111: "Sepolia", 677: "BOT Chain Mainnet" };

async function main() {
  const rpc = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";

  if (!process.env.PRIVATE_KEY || !process.env.PRIVATE_KEY.startsWith("0x")) {
    throw new Error("请先在 .env 里填好 PRIVATE_KEY（0x 开头）");
  }

  const abi = readAbi();
  const bytecode = readBytecode();
  console.log("ABI 条目数 :", abi.length);
  console.log("Bytecode   :", bytecode.length, "字符");

  const provider = new JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const chainName = KNOWN_CHAINS[chainId];
  if (!chainName) {
    throw new Error(`⚠️ 当前 RPC 不是已知的真链（chainId=${chainId}）。已知：` +
      Object.entries(KNOWN_CHAINS).map(([k, v]) => `${v}(${k})`).join(" / "));
  }
  // chainId 能被本地假链伪装（07-测试工具/prep_local_chain.js 就设成 11155111），块高不能：
  // Sepolia 已 1180 万+、BOT Chain 主网已 257 万+，本地假链从 0 开始。这里只把身份说清楚，本地联调照样能跑。
  const blockNumber = await provider.getBlockNumber();
  const isRealChain = blockNumber >= 1000000;
  const sym = chainId === 677 ? "BOT" : "SepETH";   // BOT Chain 的原生代币叫 BOT，不是 SepETH
  console.log("网络       : " + (isRealChain
    ? `${chainName} (${chainId})`
    : `⚠️ 本地假链（块高 ${blockNumber}，chainId 被伪装成 ${chainId}）—— 不是真链！`));

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log("部署账户   :", wallet.address);
  console.log("账户余额   :", (Number(balance) / 1e18).toFixed(6), sym);

  if (balance === 0n) {
    throw new Error("账户余额为 0 —— 先去水龙头领测试币");
  }

  console.log("\n正在部署，请稍候...");
  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  const tx = contract.deploymentTransaction();
  console.log("交易哈希   :", tx.hash);
  console.log("等待确认（约 10~30 秒）...");

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\n✅ 部署成功");
  console.log("合约地址   :", address);
  console.log("交易哈希   :", tx.hash);

  console.log("\n【接下来三件事，按顺序做】");
  console.log("  ① 把合约地址填进 .env 的 CONTRACT_ADDRESS");
  console.log("  ② 喂价前必须先把资金池喂饱 —— 收到 1 份保费（0.001）却要赔 10 倍（0.01），");
  console.log("     池子是空的，第一笔赔付就会因 insufficient funds 失败。三种注资方式任选：");
  console.log(`       · 打开演示页面 → 「资金池」卡片 → 点「注资 0.05 ${sym}」`);
  console.log("       · 或 Remix 上调 fundPool() 并附带 value");
  console.log("  ③ npm run status   ← 确认合约状态、operator、池子余额都对");
  console.log("     npm run demo     ← 注入模拟暴雨，把 5 个区域的降雨推上去");

  console.log("\n【怎么确认链上真有了】");
  console.log("  双击桌面上的  汉客松-链上核验台.html");
  console.log("  把上面那个合约地址粘进去 → 应该看到：");
  console.log("    这是不是合约 → 是合约 ✅");
  console.log("    合约代码长度 → 正整数（不是 0）");
  console.log("\n  （不要用 sepolia.otterscan.io —— 10/4 起它的后端节点挂了，页面会一直转圈）");

  console.log("\n【演示页面现在就打开】");
  console.log("  双击  " + "C:\\Users\\Lenovo\\WorkBuddy\\workbuddy-use\\_hackathon\\site\\index.html");
  console.log("  （或直接开线上版，手机也能看）");
}

main().catch((e) => {
  console.error("\n❌ 失败：", e.message || e);
  process.exit(1);
});
