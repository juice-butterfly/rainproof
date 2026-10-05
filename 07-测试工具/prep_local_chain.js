/**
 * 为「页面端到端验证」准备一条本地链：
 *   1. ganache，chainId 强制 = 11155111（这样页面里的 Sepolia 校验会通过）
 *   2. 部署 RainDeliveryInsurance
 *   3. 注资 / 投保 / 喂价 / 赔一笔 —— 让页面有真实数据可渲染
 *   4. 打印合约地址 + RPC 地址，供无头浏览器带参访问
 *
 * 用法：NODE_PATH=<workspace>/node_modules node prep_local_chain.js <合约目录>
 */
const path = require("path");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const SOL_DIR = process.argv[2] || path.join(__dirname, "..", "03-合约");
const ABI = JSON.parse(fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.abi.json"), "utf8"));
const BIN = fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.bytecode.txt"), "utf8").trim();

const PORT = 8545;

// ★ 固定助记词 —— 必须写死，否则 ganache 每次随机生成，
//   喂价脚本（要私钥）就没法连这条测试链。这是公开的测试助记词，不含任何真实资产。
const MNEMONIC = "myth like bonus scare over problem client lizard pioneer submit female collect";

(async () => {
  // 直接用 ganache 自带 HTTP server（比我手搓代理靠谱：批量请求、CORS 都替你处理好）
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 11155111, hardfork: "shanghai" },   // ← 冒充 Sepolia
    miner: { blockGasLimit: 30000000 },
    wallet: { mnemonic: MNEMONIC, totalAccounts: 5, defaultBalance: 1000 }
  });
  await server.listen(PORT, "127.0.0.1");

  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`);
  await provider.getBlockNumber();   // 握手确认
  // ★ 注意：ethers v6 的 JsonRpcProvider.listAccounts() 返回的是 JsonRpcSigner 对象数组，
  //   不是地址字符串 —— 拿它去 getSigner() 会报 "invalid address"。必须走 eth_accounts。
  const accts = await provider.send("eth_accounts", []);
  const [opAddr, riderA] = accts;
  const operator = await provider.getSigner(opAddr);
  const a = await provider.getSigner(riderA);

  const c = await new ethers.ContractFactory(ABI, BIN, operator).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  const PREMIUM = await c.PREMIUM();

  // 造一份"正常演示"的数据
  await (await c.connect(operator).fundPool({ value: ethers.parseEther("0.2") })).wait();
  await (await c.connect(a).buyPolicy(1, 6, { value: PREMIUM })).wait();   // 武汉 #0，会赔付
  await (await c.connect(a).buyPolicy(2, 12, { value: PREMIUM })).wait();  // 上海 #1，保障中
  await (await c.connect(operator).updateRainfall(1, 80)).wait();          // 武汉超阈值
  await (await c.connect(operator).updateRainfall(2, 12)).wait();          // 上海没到
  await (await c.connect(operator).updateRainfall(3, 5)).wait();           // 北京
  await (await c.connect(operator).updateRainfall(4, 47)).wait();          // 广州接近阈值
  await (await c.connect(a).claim(0)).wait();                              // 武汉那笔赔掉
  await (await c.connect(a).buyPolicy(4, 3, { value: PREMIUM })).wait();   // 广州 #2，可赔付
  await (await c.connect(operator).updateRainfall(4, 120)).wait();         // 广州也超阈值

  const pool = await c.poolBalance();

  // 私钥（固定助记词推导出来，仅供本地测试链使用）
  const keys = server.provider.getInitialAccounts();
  const keyOf = (addr) => {
    const hit = Object.entries(keys).find(([a]) => a.toLowerCase() === addr.toLowerCase());
    return hit ? hit[1].secretKey : null;
  };

  console.log("=".repeat(70));
  console.log("本地 Sepolia 已就绪（chainId=11155111 的 ganache，固定助记词）");
  console.log("=".repeat(70));
  console.log("RPC      :", `http://127.0.0.1:${PORT}`);
  console.log("合约地址 :", addr);
  console.log("operator :", opAddr, keyOf(opAddr));
  console.log("骑手A    :", riderA, keyOf(riderA));
  console.log("资金池   :", ethers.formatEther(pool), "ETH");
  console.log("保单数   :", (await c.nextPolicyId()).toString());
  console.log("武汉降雨 :", (await c.rainfall(1)).toString(), "mm");
  console.log("广州降雨 :", (await c.rainfall(4)).toString(), "mm");
  console.log("");
  console.log("页面 URL :", `http://127.0.0.1:8899/index.html?rpc=http://127.0.0.1:${PORT}&addr=${addr}`);
  console.log("");
  console.log("⚠️ 上面这两把私钥只属于这条【本地测试链】，是公开助记词推导的，没有任何真实资产。");
  console.log("");

  fs.writeFileSync(path.join(__dirname, "_local_chain.json"),
    JSON.stringify({
      rpc: `http://127.0.0.1:${PORT}`, addr, opAddr, riderA,
      opKey: keyOf(opAddr), riderAKey: keyOf(riderA),
      pool: pool.toString(), mnemonic: MNEMONIC
    }, null, 2));
  console.log("信息已写入 tools/_local_chain.json（Ctrl+C 停止这条链）");
})().catch(e => { console.error("💥", e.shortMessage || e.message || e); process.exit(1); });
