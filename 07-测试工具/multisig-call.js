// 通过 2/3 多签调用 v3 合约（operator 已交给多签之后，喂价/判定这类 onlyOperator 动作都得走这里）。
// 用法：
//   $env:SEPOLIA_RPC='https://rpc.botchain.ai'; $env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:7890'
//   node D:\DSH\_tmp\mscall.js <多签地址> updateRainfall 1 67 0x<32字节evidence> 84 2
//   node D:\DSH\_tmp\mscall.js <多签地址> setPaused false
//   node D:\DSH\_tmp\mscall.js <多签地址> --calldata submitJudgement 0 1 91 3 0x… 0x… 0x… 553
// 参数按 v3 ABI 的类型自动编码（数字 → uint，true/false → bool，0x 开头按类型给 bytes32/address/string）。
const path = require("path");
const fs = require("fs");
const SCRIPTS = path.join(__dirname, "..", "04-脚本");
const ROOT = path.join(__dirname, "..");
require(path.join(SCRIPTS, "node_modules", "dotenv")).config({ path: path.join(SCRIPTS, ".env") });
const { ethers } = require(path.join(SCRIPTS, "node_modules", "ethers"));

const [msAddr, fn, ...rest] = process.argv.slice(2);
if (!msAddr || !fn) { console.error("用法：node mscall.js <多签地址> <v3函数名> [参数…]"); process.exit(1); }

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC || "https://rpc.botchain.ai", undefined, { staticNetwork: true });
  const a = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const b = new ethers.Wallet(process.env.RIDER_KEY, provider);
  const V3 = process.env.CONTRACT_ADDRESS || "0x89e7C942535930B61cB61631051E8b0bD670596a";
  const abiV3 = JSON.parse(fs.readFileSync(path.join(ROOT, "03-合约", "RainDeliveryInsuranceV3.abi.json"), "utf8"));
  const abiMs = JSON.parse(fs.readFileSync(path.join(ROOT, "03-合约", "OperatorMultisig.abi.json"), "utf8"));
  const iface = new ethers.Interface(abiV3);

  const args = rest.map((v, i) => {
    const type = iface.getFunction(fn).inputs[i].type;
    if (type === "bool") return v === "true" || v === "1";
    if (type.startsWith("uint") || type.startsWith("int")) return BigInt(v);
    if (type === "address") return ethers.getAddress(v);
    return v; // bytes32 / bytes / string 原样
  });
  const data = iface.encodeFunctionData(fn, args);
  console.log(`目标 v3 : ${V3}`);
  console.log(`多签    : ${msAddr}`);
  console.log(`调用    : ${fn}(${args.map((x) => (typeof x === "bigint" ? x.toString() : x)).join(", ")})`);
  console.log(`calldata: ${data}`);

  const ms = new ethers.Contract(msAddr, abiMs, a);
  const sTx = await ms.submit(V3, 0, data);
  await sTx.wait();
  const txId = Number(await ms.txCount()) - 1;
  console.log(`\nsubmit  : ${sTx.hash} ⇒ txId ${txId}`);
  const cTx = await new ethers.Contract(msAddr, abiMs, b).confirm(txId);
  const rc = await cTx.wait();
  const t = await ms.getTx(txId);
  console.log(`confirm : ${cTx.hash}（区块 ${rc.blockNumber} · gas ${rc.gasUsed}）`);
  console.log(`结果    : executed=${t[3]} · confirmations=${t[4]}`);
  if (!t[3]) console.log("⚠️ 还没执行 —— 票数不够？再看一眼 getTx / threshold。");
})().catch((e) => { console.error("💥 " + (e.shortMessage || e.message)); process.exit(1); });
