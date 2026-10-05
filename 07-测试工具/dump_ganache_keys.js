/** 取出本地 ganache 的账户私钥（用与 prep_local_chain.js 完全相同的 wallet 选项推导）。 */
const ganache = require("ganache");

const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 11155111, hardfork: "shanghai" },
  miner: { blockGasLimit: 30000000 },
  wallet: { totalAccounts: 5, defaultBalance: 1000 },
});

const accts = provider.getInitialAccounts();
for (const [addr, info] of Object.entries(accts)) {
  console.log(addr, info.secretKey);
}
