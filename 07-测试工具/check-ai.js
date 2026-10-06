/**
 * AI 判定层的最小可运行检查
 * ============================================================================
 * 钉住 ai-judge.js 的判定规则：规则改了、顺序错了、硬约束漏了，这里必须红。
 * 不依赖链、不依赖网络、不依赖大模型 —— 纯函数，随时可跑。
 *
 * 用法：node check-ai.js
 */

const { decide, DECISION } = require("../04-脚本/ai-judge");
const { evidenceHashOf } = require("../04-脚本/canonical");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? "  " + extra : ""}`); }
}

/** 造一份最小快照：只填 decide() 会读的字段 */
function snap({ official, incs, threshold = 50, minConf = 60, simulated = false, policyId = 1 }) {
  return {
    schema: "rainproof/judge-input@1",
    policyId,
    simulated,
    region: { id: 2, key: "shanghai", name: "上海", lat: 31.2304, lon: 121.4737 },
    policy: { startDate: "2026-10-01" },
    oracle: { officialIncrementMm: official, cumulativeMm: official, contract: "0x", chainId: 11155111 },
    weather: {
      source: simulated ? "synthetic" : "open-meteo:...",
      models: incs.map((v, i) => ({ id: "m" + i, label: "M" + i, org: "x", sinceEpochMm: v, inWindowMm: v, days: [] })),
    },
    thresholds: { thresholdMm: threshold, minConfidence: minConf },
  };
}

console.log("=".repeat(74));
console.log("AI 判定层检查");
console.log("=".repeat(74));
console.log("\n[R1] 雨量本身没达标 —— 与模型无关，直接不赔");
{
  const r = decide(snap({ official: 30, incs: [30, 31, 29] }));
  ok("official 30 < 阈值 50 → DENY", r.decision === DECISION.DENY, `decision=${r.decision}`);
  ok("置信度给到 95（这是确定性的，不是推测）", r.confidence === 95, `confidence=${r.confidence}`);
  ok("理由里点名了阈值", r.reasons.some((s) => s.includes("阈值 50mm")));
}

console.log("\n[R2] ★ 独立复核发现预言机和模型严重不符 —— AI 真正值钱的地方");
{
  const r = decide(snap({ official: 80, incs: [20, 22, 21] }));
  ok("链上 80mm vs 三模型中位数 21mm（背离 73.8% > 60%）→ DENY",
    r.decision === DECISION.DENY, `decision=${r.decision} divergence=${r.metrics.divergencePct}%`);
  ok("背离时给高置信度 92（对『链上数据不可信』这件事很确定）", r.confidence === 92);
  ok("理由里写明了背离百分比", r.reasons.some((s) => s.includes("背离")));
  ok("反向验证：同样的数字若只是模拟数据，就不适用 R2",
    decide(snap({ official: 80, incs: [20, 22, 21], simulated: true })).reasons.every((s) => !s.includes("背离")));
}

console.log("\n[R3] 三家里只有 ≤1 家支持赔付");
{
  const r = decide(snap({ official: 50, incs: [30, 25, 20] }));
  ok("达标模型 0/3 → DENY", r.decision === DECISION.DENY, `agree=${r.metrics.agreeCount}`);
  ok("理由里报告了达标家数", r.reasons.some((s) => s.includes("0 个模型")));
}

console.log("\n[R4] 模型自己吵翻天 —— 置信度压到门槛以下，不敢拍板");
{
  const r = decide(snap({ official: 50, incs: [50, 90, 10] }));
  ok("离散度 80 ≥ 中位数 50 → DENY", r.decision === DECISION.DENY);
  ok("置信度被压到 45（< 验收门槛 60）", r.confidence === 45, `confidence=${r.confidence}`);
  ok("理由里说明了离散度与门槛", r.reasons.some((s) => s.includes("分歧过大")));
}

console.log("\n[R5] 正常赔付路径");
{
  const r = decide(snap({ official: 80, incs: [80, 84, 78] }));
  ok("3/3 模型一致且与链上相符 → PAY", r.decision === DECISION.PAY, `decision=${r.decision}`);
  ok("置信度 ≥ 门槛", r.confidence >= 60, `confidence=${r.confidence}`);
  ok("离散度越小置信度越高（单调性）",
    decide(snap({ official: 80, incs: [80, 80, 80] })).confidence > decide(snap({ official: 80, incs: [80, 86, 74] })).confidence);
}

console.log("\n[硬约束] 绝不允许输出「PAY 且置信度 < 门槛」");
{
  // 扫一遍参数网格，任何一格出现 PAY 且 conf < minConf 都算失败
  let violated = null, payCases = 0;
  for (const official of [0, 25, 49, 50, 55, 60, 80, 120, 200]) {
    for (const a of [0, 10, 30, 50, 60, 80, 100, 150]) {
      for (const b of [0, 20, 40, 55, 70, 90, 110]) {
        for (const c of [0, 15, 45, 52, 65, 85, 130]) {
          for (const minConf of [60, 75]) {
            for (const simulated of [false, true]) {
              const r = decide(snap({ official, incs: [a, b, c], minConf, simulated }));
              if (r.decision === DECISION.PAY) {
                payCases++;
                if (r.confidence < minConf) violated = { official, incs: [a, b, c], minConf, conf: r.confidence };
              }
              if (r.confidence < 0 || r.confidence > 99) violated = { official, incs: [a, b, c], conf: r.confidence, outOfRange: true };
            }
          }
        }
      }
    }
  }
  ok(`${payCases} 个 PAY 用例全部过门槛，且置信度都落在 0..99`, violated === null, violated ? JSON.stringify(violated) : "");
}

console.log("\n[可复算] 同一份快照必须得到逐字节相同的结果");
{
  const s = snap({ official: 80, incs: [80, 84, 78] });
  const a = decide(s), b = decide(JSON.parse(JSON.stringify(s)));
  ok("两次调用结果完全一致", JSON.stringify(a) === JSON.stringify(b));
  // decide 不得改写入参 —— 否则重算哈希会漂移
  ok("decide() 不修改输入快照", JSON.stringify(s) === JSON.stringify(snap({ official: 80, incs: [80, 84, 78] })));
}

console.log("\n[哈希绑定] 结论一变，outputHash 必变");
{
  const base = { schema: "rainproof/judgement@1", policyId: 1, decision: 1, confidence: 90, inputHash: "0x" + "ab".repeat(32), reasons: ["x"] };
  const h1 = evidenceHashOf(base);
  const h2 = evidenceHashOf({ ...base, decision: 0 });
  const h3 = evidenceHashOf({ ...base, confidence: 91 });
  ok("decision 变 → 哈希变", h1 !== h2);
  ok("confidence 变 → 哈希变", h1 !== h3);
  ok("键序不同、内容相同 → 哈希不变", evidenceHashOf({ ...base }) === evidenceHashOf(Object.fromEntries(Object.entries(base).reverse())));
}

console.log("\n" + "=".repeat(74));
console.log(`结果：${pass} 项通过 / ${fail} 项失败`);
console.log(fail === 0 ? "✅ 全部通过 —— AI 判定规则可以拿去现场了" : "❌ 有失败项");
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
