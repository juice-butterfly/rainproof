/**
 * 把 `10-金融与定价/ref/PricingV3.sol`（v3 五维定价模块）部署到 BOT Chain 测试网 968。
 *
 * 为什么不复用 04-脚本/deploy.js：那个脚本只部署 `03-合约/` 里的产品合约（v1/v2），
 * 从 `03-合约/*.abi.json` 读 `07-测试工具` 的编译产物。定价模块是 `10-金融与定价/ref/`
 * 下的独立件（B 写的、自包含、不继承 v2、不碰判定链），产物不在 `03-合约/`，所以这里自己编译。
 *
 * ★ 演示基线不受影响：部署这个模块**不动** 968 上的 v2 产品合约（`0x89e7…596a`），
 *   两者互不引用 —— 模块只是把 60 格五维定价表放到链上，让"可复算"这件事也能被链上核验。
 *
 * 用法（在 04-脚本/ 下）：
 *   node deploy-pricing-v3.js            # 部署到 968（用 .env 的 PRIVATE_KEY 付 gas）
 *   node deploy-pricing-v3.js --dry      # 只编译 + 报字节码长度，不广播
 *   node deploy-pricing-v3.js --rpc=https://... --chain=968
 *
 * 部署完：
 *   ① 把地址记进 `.env`：`PRICING_V3_ADDR=0x...`
 *   ② `cd ../10-金融与定价 && node ref/apply-pricing-v3.js --addr=0x... --apply`    （60 笔 setPremiumRow）
 *   ③ `cd ../10-金融与定价 && node ref/apply-pricing-v3.js --addr=0x... --verify`   （读回 240 项比对）
 */
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, ContractFactory } = require("ethers");
// 锚到脚本自己旁边的 .env，而不是 cwd —— 否则从别处跑就静默读不到 PRIVATE_KEY
require("dotenv").config({ path: path.join(__dirname, ".env") });

const TOOLS = path.join(__dirname, "..", "07-测试工具", "node_modules");
const solc = require(path.join(TOOLS, "solc"));
const SOL_PATH = path.join(__dirname, "..", "10-金融与定价", "ref", "PricingV3.sol");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const KNOWN_CHAINS = { 11155111: "Sepolia", 677: "BOT Chain 主网", 968: "BOT Chain 测试网 968" };

function compile() {
  const input = {
    language: "Solidity",
    sources: { "PricingV3.sol": { content: fs.readFileSync(SOL_PATH, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["PricingV3.sol"].PricingV3;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

// 读操作自动重试（BOT Chain RPC 偶发 timeout）。★ 发交易不自动重试 —— 重试就是重复部署。
async function retry(label, fn, n = 3) {
  let last;
  for (let i = 1; i <= n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.log(`  ⚠️ ${label} 第 ${i}/${n} 次失败：${e.shortMessage || e.message}`);
      if (i < n) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}

async function main() {
  const target = Number(arg("chain", "968"));
  const rpc = arg("rpc", process.env.PRICING_V3_RPC || process.env.SEPOLIA_RPC || "https://rpc.bohr.life");
  const { abi, bytecode } = compile();

  console.log("合约       : PricingV3（v3 五维定价模块，自包含、不继承 v2）");
  console.log("源码       : 10-金融与定价/ref/PricingV3.sol");
  console.log("编译器     : solc", solc.version());
  console.log("ABI 条目数 :", abi.length);
  console.log("Bytecode   :", (bytecode.length - 2) / 2, "字节");
  console.log("RPC        :", rpc);
  if (has("dry")) {
    console.log("\n--dry：只编译，不广播。");
    return;
  }
  if (!process.env.PRIVATE_KEY || !process.env.PRIVATE_KEY.startsWith("0x")) {
    throw new Error("请先在 .env 里填好 PRIVATE_KEY（0x 开头）");
  }

  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const net = await retry("读网络", () => provider.getNetwork());
  const chainId = Number(net.chainId);
  const blockNumber = await retry("读块高", () => provider.getBlockNumber());
  console.log("网络       :", `${KNOWN_CHAINS[chainId] || "未知链"} (chainId ${chainId}) · 块高 ${blockNumber}`);
  if (chainId !== target) {
    throw new Error(`⚠️ 当前 RPC 是 chainId=${chainId}，不是要部署的 ${target}（${KNOWN_CHAINS[target] || "?"}）—— 拒绝部署`);
  }
  if (blockNumber < 1000000) {
    throw new Error(`⚠️ 块高只有 ${blockNumber}，像是本地假链 —— 拒绝部署`);
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await retry("读余额", () => provider.getBalance(wallet.address));
  const sym = chainId === 677 || chainId === 968 ? "BOT" : "SepETH";
  console.log("部署账户   :", wallet.address);
  console.log("账户余额   :", (Number(balance) / 1e18).toFixed(6), sym);
  if (balance === 0n) throw new Error(`部署账户在 ${KNOWN_CHAINS[chainId]} 上没有 ${sym} 可付 gas`);

  console.log("\n正在部署（gasLimit 写死 2,000,000，不走 estimateGas —— 本仓有过双峰估 gas 的前科）...");
  const factory = new ContractFactory(abi, bytecode, wallet);
  const c = await factory.deploy({ gasLimit: 2_000_000n });
  const tx = c.deploymentTransaction();
  console.log("交易哈希   :", tx.hash);
  console.log("浏览器     :", `https://scan.bohr.life/tx/${tx.hash}`);

  // ★ 交易已经发出去了，这里再超时也【绝不能重发】—— 重发就是第二个合约、又一份 gas。
  try {
    await c.waitForDeployment();
  } catch (e) {
    console.error(`\n⚠️ 等确认超时/失败：${e.shortMessage || e.message}`);
    console.error("   交易可能已经上链 —— 别重跑本脚本，先拿上面的哈希去浏览器查。");
    process.exit(2);
  }

  const address = await c.getAddress();
  const code = await retry("读代码", () => provider.getCode(address));
  const operator = await c.operator();
  console.log("\n✅ 部署成功");
  console.log("合约地址   :", address);
  console.log("运行时代码 :", (code.length - 2) / 2, "字节");
  console.log(
    "operator   :",
    operator,
    operator.toLowerCase() === wallet.address.toLowerCase()
      ? "（= 部署账户 ✅ 60 笔 setPremiumRow 由它签名）"
      : "⚠️ 不是部署账户，写价会被 onlyOperator 拒掉"
  );
  console.log("浏览器     :", `https://scan.bohr.life/address/${address}`);
  console.log("\n接下来：");
  console.log(`  ① 记进 .env：PRICING_V3_ADDR=${address}`);
  console.log(`  ② cd ../10-金融与定价 && node ref/apply-pricing-v3.js --addr=${address} --apply`);
  console.log(`  ③ cd ../10-金融与定价 && node ref/apply-pricing-v3.js --addr=${address} --verify`);
}

main().catch((e) => {
  console.error("\n❌ 失败：", e.message || e);
  process.exit(1);
});
