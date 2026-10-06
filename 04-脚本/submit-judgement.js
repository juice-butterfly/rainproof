/**
 * AI 判定 · 第 3 步 —— 把判定结果登记上链
 * ============================================================================
 *
 * 【上链的是什么、不是什么是关键】
 *   上链的只有：保单号 / 赔或不赔 / 置信度 / 两个 32 字节哈希 / 版本号。
 *   上链的【不是】判定过程，也【不是】钱。合约里 submitJudgement 只登记，不转账；
 *   要不要真的赔，仍然由 claim() 按写死的规则执行，而且要运营方另行触发。
 *
 *   这么切分是有意为之：
 *   · 链只担保「这个结论在某时刻被某个人提交过，且对应这份不可篡改的输入」；
 *   · 算错的后果不会自动变成资金损失；
 *   · 也因此不需要为「AI 判错」设计链上回滚 —— 那才是真的复杂且危险。
 *
 * 【第三方怎么验】
 *   1. 从链上读出 inputHash / outputHash；
 *   2. 拿到仓库里的 snapshot-policy<N>.json 与 judgement-policy<N>.json；
 *   3. 用 04-脚本/canonical.js 重算两个哈希，必须完全一致。
 *   本脚本在提交【之前】自己先做一遍第 3 步，对不上就拒绝提交 ——
 *   绝不把一笔哈希对不上的记录写进链，那等于自己给自己埋一个假证据。
 *
 * 【用法】
 *   node submit-judgement.js 0
 */

try { require("dotenv").config(); } catch (_) { /* dotenv 可选 */ }
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");
const { evidenceHashOf } = require("./canonical");

const RPC = process.env.SEPOLIA_RPC || process.env.RPC_URL || "http://127.0.0.1:8545";
const ADDR = process.env.CONTRACT_ADDRESS || "";
const KEY = process.env.PRIVATE_KEY || "";
const OUT_DIR = process.env.AI_OUT_DIR || path.join(__dirname, "..", "09-AI判定留痕");

const ABI = [
  "function submitJudgement(uint256 policyId, uint8 decision, uint8 confidence, bytes32 inputHash, bytes32 outputHash, string modelVersion) external",
  "function judgements(uint256) external view returns (uint8 kind, uint8 decision, uint8 confidence, uint8 sources, uint64 judgedAt, bool exists, bytes32 inputHash, bytes32 outputHash, string modelVersion)",
  "function policyStatus(uint256) external view returns (string)",
  "function operator() external view returns (address)",
];

(async () => {
  const policyId = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)));
  if (!Number.isInteger(policyId)) { console.error("用法：node submit-judgement.js <policyId>"); process.exit(2); }
  if (!ADDR) { console.error("缺少 CONTRACT_ADDRESS"); process.exit(2); }
  if (!KEY) { console.error("缺少 PRIVATE_KEY（04-脚本/.env）"); process.exit(2); }

  const snapFile = path.join(OUT_DIR, `snapshot-policy${policyId}.json`);
  const judgeFile = path.join(OUT_DIR, `judgement-policy${policyId}.json`);
  for (const f of [snapFile, judgeFile]) {
    if (!fs.existsSync(f)) { console.error(`找不到 ${f}`); process.exit(2); }
  }
  const { snapshot, inputHash: snapHash } = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  const { judgement, outputHash } = JSON.parse(fs.readFileSync(judgeFile, "utf8"));

  // ——— 提交前自检：两个哈希都要能重算出来 ———
  const recomputedIn = evidenceHashOf(snapshot);
  if (recomputedIn !== snapHash) { console.error(`💥 快照哈希对不上：${snapHash} ≠ ${recomputedIn}`); process.exit(1); }
  const recomputedOut = evidenceHashOf(judgement);
  if (recomputedOut !== outputHash) { console.error(`💥 判定哈希对不上：${outputHash} ≠ ${recomputedOut}`); process.exit(1); }
  if (judgement.inputHash !== snapHash) { console.error("💥 判定文件里记的 inputHash 与快照不匹配"); process.exit(1); }
  if (Number(judgement.policyId) !== policyId) { console.error("💥 判定文件里的保单号与参数不一致"); process.exit(1); }

  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(KEY, provider);
  const c = new Contract(ADDR, ABI, wallet);

  const operator = (await c.operator()).toLowerCase();
  if (wallet.address.toLowerCase() !== operator) {
    console.error(`💥 这把私钥不是 operator。\n   operator = ${operator}\n   本私钥   = ${wallet.address.toLowerCase()}`);
    process.exit(1);
  }

  const before = await c.judgements(policyId);
  if (before.exists) {
    console.error(`💥 保单 #${policyId} 已有判定（合约规定一份保单只判一次），不重复提交。`);
    process.exit(1);
  }
  const statusBefore = await c.policyStatus(policyId);

  console.log("=".repeat(74));
  console.log(`提交 AI 判定上链（保单 #${policyId}）`);
  console.log("=".repeat(74));
  console.log(`结论      ${judgement.decisionLabel}  置信度 ${judgement.confidence}  版本 ${judgement.judgeVersion}`);
  console.log(`提交前状态 ${statusBefore}`);
  console.log(`inputHash  ${snapHash}`);
  console.log(`outputHash ${outputHash}`);

  const tx = await c.submitJudgement(
    policyId, judgement.decision, judgement.confidence, snapHash, outputHash, judgement.judgeVersion
  );
  console.log(`交易已发出 ${tx.hash}  等待打包…`);
  const rc = await tx.wait();
  console.log(`✅ 已上链  区块 ${rc.blockNumber}  gas ${rc.gasUsed}`);

  // ——— 读回校验：链上存下来的必须与本地文件逐字段一致 ———
  const after = await c.judgements(policyId);
  const checks = [
    ["exists", after.exists === true],
    ["decision", Number(after.decision) === Number(judgement.decision)],
    ["confidence", Number(after.confidence) === Number(judgement.confidence)],
    ["inputHash", after.inputHash === snapHash],
    ["outputHash", after.outputHash === outputHash],
    ["modelVersion", after.modelVersion === judgement.judgeVersion],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  console.log("读回校验    " + (bad.length ? `❌ 不一致：${bad.join(", ")}` : "✅ 6/6 个字段与本地文件一致"));
  console.log(`提交后状态 ${await c.policyStatus(policyId)}`);
  if (bad.length) process.exit(1);
})().catch((e) => {
  console.error("💥 提交失败：" + (e.shortMessage || e.message || e));
  const inner = e.info && e.info.error && e.info.error.message;
  if (inner) console.error("   链上原始回执: " + inner);
  process.exit(1);
});
