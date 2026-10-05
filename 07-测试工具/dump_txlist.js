/** 导出本地链上这笔合约的全部交易（按事件倒序），用于 Step 6 的「交易哈希清单」。 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const INFO = JSON.parse(fs.readFileSync(path.join(__dirname, "_local_chain.json"), "utf8"));
const SOL_DIR = process.argv[2] || path.join(__dirname, "..", "03-合约");
const ABI = JSON.parse(fs.readFileSync(path.join(SOL_DIR, "RainDeliveryInsurance.abi.json"), "utf8"));

(async () => {
  const provider = new ethers.JsonRpcProvider(INFO.rpc);
  const c = new ethers.Contract(INFO.addr, ABI, provider);
  const iface = c.interface;

  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({ address: INFO.addr, fromBlock: 0, toBlock: latest });

  const seen = new Set();
  const rows = [];
  for (const l of logs) {
    let d; try { d = iface.parseLog(l); } catch { continue; }
    const key = l.transactionHash + ":" + l.index;
    if (seen.has(key)) continue;
    seen.add(key);
    let desc = "";
    if (d.name === "PolicyBought")        desc = `保单 #${d.args[0]} · ${d.args[1]} 投保 ${await c.regionName(d.args[2])}`;
    else if (d.name === "RainfallUpdated") desc = `${await c.regionName(d.args[0])} 累计 ${d.args[1]}mm`;
    else if (d.name === "ClaimPaid")      desc = `保单 #${d.args[0]} 赔付 ${ethers.formatEther(d.args[2])} ETH`;
    else if (d.name === "PoolFunded")     desc = `注资 ${ethers.formatEther(d.args[1])} ETH`;
    else desc = d.name;
    rows.push({ block: Number(l.blockNumber), ev: d.name, desc, tx: l.transactionHash });
  }

  rows.sort((a, b) => b.block - a.block);
  console.log("区块\t事件\t说明\t交易哈希");
  for (const r of rows) console.log(`${r.block}\t${r.ev}\t${r.desc}\t${r.tx}`);
  console.log("\n共", rows.length, "条事件，涉及", new Set(rows.map(r => r.tx)).size, "笔交易");
})().catch(e => { console.error("💥", e.shortMessage || e.message || e); process.exit(1); });
