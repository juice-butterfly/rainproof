/**
 * AI 判定 · 第 1 步 —— 采集证据快照（snapshot）
 * ============================================================================
 *
 * 【这一层在做什么】
 *   合约不能自己上网（链是确定性的），所以「外面到底下了多少雨」必须由链下写进去。
 *   喂价脚本（push-rainfall.js）干的是「写进去」；本脚本干的是【独立复核】：
 *   它绕开那个写数的人，自己去问三个气象模型，然后和链上的数字对一遍。
 *
 *   这就是把「你信不信我」变成「你自己验」在链下的那一半：
 *   预言机是单一运营方，AI 是第二个、独立的意见 —— 而两者的证据都留痕、可复算。
 *
 * 【三模型是三个真的不同模型，不是同一个源换个名字】
 *   ECMWF IFS025 / GFS / ICON 是欧洲、美国、德国三家的数值预报，
 *   实测同一坐标同一天可以差很多（如武汉 10-03：13.7 / 6.3 / 5.0 mm）。
 *   模型之间的分歧量本身就是风险度量，所以快照里既存各模型的逐日序列，也存离散度。
 *
 * 【产物】
 *   09-AI判定留痕/snapshot-policy<N>.json
 *   文件结构 = { snapshot: {...}, inputHash: "0x..." }
 *   inputHash = keccak256(canonicalize(snapshot)) —— 任何人拿到这个文件都能自己
 *   重算一遍并核对（口径见 04-脚本/canonical.js）。上链时只写这个 32 字节哈希，
 *   完整快照留在仓库里，评委可逐字节复现。
 *
 * 【用法】
 *   node ai-collect.js 0                 # 真实三模型，复核链上数据
 *   node ai-collect.js 0 --demo          # 演示模式：模型序列由链上值合成，并在快照里
 *                                        # 明确标记 simulated=true（不撒谎）
 */

try { require("dotenv").config(); } catch (_) { /* dotenv 可选 */ }
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract } = require("ethers");
const { REGION_BY_ID, RAIN_EPOCH, assertRegionsMatchContract } = require("./regions");
const { evidenceHashOf } = require("./canonical");

const RPC = process.env.SEPOLIA_RPC || process.env.RPC_URL || "http://127.0.0.1:8545";
const ADDR = process.env.CONTRACT_ADDRESS || "";
const OUT_DIR = process.env.AI_OUT_DIR || path.join(__dirname, "..", "09-AI判定留痕");

// 三个模型 + 给人看的名字。顺序固定，写进快照，判定脚本按同一顺序读。
const MODELS = [
  { id: "ecmwf_ifs025", label: "ECMWF IFS025", org: "欧洲中期天气预报中心" },
  { id: "gfs_seamless", label: "GFS",          org: "美国 NOAA/NCEP" },
  { id: "icon_seamless", label: "ICON",        org: "德国气象局 DWD" },
];

const COLLECT_VERSION = "ai-collect-v1";

const ABI = [
  "function policies(uint256) external view returns (address rider, uint8 regionId, uint256 startTime, uint256 endTime, uint256 rainfallAtBuy, bool paid, bool exists)",
  "function rainfall(uint8) external view returns (uint256)",
  "function rainfallDuring(uint256) external view returns (uint256)",
  "function THRESHOLD() external view returns (uint256)",
  "function MIN_CONFIDENCE() external view returns (uint8)",
  "function regionName(uint8) external pure returns (string)",
];

const ARGV = process.argv.slice(2);
const POLICY_ID = Number(ARGV.find((a) => /^\d+$/.test(a)));
const DEMO = ARGV.includes("--demo");

/** unix 秒 → 亚洲/上海时区的 YYYY-MM-DD（判定窗口按自然日切，必须钉在同一个时区） */
const shDate = (sec) => new Date((Number(sec) + 8 * 3600) * 1000).toISOString().slice(0, 10);

/** 逐日累加，返回 6 位小数 —— 和 canonical 的口径对齐，避免 0.30000000000000004 这种哈希漂移 */
const sum6 = (arr) => Math.round(arr.reduce((x, y) => x + y, 0) * 1e6) / 1e6;

/** 拉一个区域的三个模型，裁剪到 epoch 之后，返回 [{id,label,org,sinceEpochMm,inWindowMm,days}] */
async function fetchModels(region, startDate) {
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${region.lat}&longitude=${region.lon}`
    + "&daily=precipitation_sum&timezone=Asia%2FShanghai&past_days=14&forecast_days=3"
    + `&models=${MODELS.map((m) => m.id).join(",")}`;
  const r = await fetch(url, { headers: { "User-Agent": "rainproof-ai-collector/1.0" } });
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const j = await r.json();
  if (!j.daily || !j.daily.time) throw new Error("Open-Meteo 返回里没有 daily.time");

  const allDates = j.daily.time;
  return MODELS.map((m) => {
    const raw = j.daily[`precipitation_sum_${m.id}`];
    if (!raw) throw new Error(`Open-Meteo 没有返回模型 ${m.id} 的序列`);
    const vals = raw.map((v) => Number(v) || 0);
    // 和喂价脚本同一条纪律：只保留 epoch 当日及以后。
    // forecast 接口的 past_days=14 会带出 epoch 之前的日子，不裁就会把
    // 「赛事周之前下的雨」算进本期累计，凭空多出一周的雨。
    const keep = allDates.map((d, i) => [d, vals[i]]).filter(([d]) => d >= RAIN_EPOCH);
    const days = keep.map(([date, mm]) => ({ date, mm }));
    const inWindow = keep.filter(([d]) => d >= startDate).map(([, mm]) => mm);
    return {
      id: m.id, label: m.label, org: m.org,
      sinceEpochMm: sum6(keep.map(([, mm]) => mm)),
      inWindowMm: sum6(inWindow),
      days,
    };
  });
}

/**
 * 演示模式用的合成序列。
 * ⚠️ 关键在诚实：真实三模型对不上「脚本注入的模拟暴雨」（链上 80mm，真实模型 24mm），
 * 硬拿真实数据去核对会得到 DENY，演示就演不下去。所以演示模式明确【合成】一份
 * 与链上值一致的模型序列，并在快照里打上 simulated=true —— 让记录自己说明它是模拟的，
 * 而不是让 AI 假装核对通过。
 */
function synthModels(region, startDate, targetMm, onchainValue) {
  // 固定偏移，保证同样输入永远得到同样的快照（可复算）
  const offsets = [0, -0.06, 0.04];
  const days = [];
  // 把 targetMm 摊在窗口内的每一天：第一天占 60%，其余均分 —— 形状不重要，
  // 重要的是「模拟」这两个字被写进证据里。
  const span = Math.max(1, (new Date(shDate(Date.now() / 1000)) - new Date(startDate)) / 86400000 + 1);
  for (let i = 0; i < span; i++) {
    const d = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().slice(0, 10);
    days.push({ date: d, mm: 0 });
  }
  if (days.length) days[0].mm = Math.round(targetMm * 0.6 * 1e6) / 1e6;
  const rest = Math.round((targetMm - days[0].mm) * 1e6) / 1e6;
  for (let i = 1; i < days.length; i++) days[i].mm = Math.round((rest / (days.length - 1)) * 1e6) / 1e6;

  return MODELS.map((m, i) => {
    const mm = Math.round(targetMm * (1 + offsets[i]) * 1e6) / 1e6;
    return {
      id: m.id, label: m.label, org: m.org,
      sinceEpochMm: onchainValue,
      inWindowMm: mm,
      days: days.map((d) => ({ ...d, mm: Math.round(d.mm * (1 + offsets[i]) * 1e6) / 1e6 })),
    };
  });
}

(async () => {
  if (!Number.isInteger(POLICY_ID)) {
    console.error("用法：node ai-collect.js <policyId> [--demo]");
    process.exit(2);
  }
  if (!ADDR) { console.error("缺少 CONTRACT_ADDRESS 环境变量"); process.exit(2); }

  const provider = new JsonRpcProvider(RPC);
  const c = new Contract(ADDR, ABI, provider);
  await assertRegionsMatchContract(c);   // 区域表对不上就别往下走

  const p = await c.policies(POLICY_ID);
  if (!p.exists) { console.error(`保单 #${POLICY_ID} 不存在`); process.exit(2); }
  const region = REGION_BY_ID[Number(p.regionId)];
  if (!region) { console.error(`区域 #${p.regionId} 不在区域表里`); process.exit(2); }

  const startDate = shDate(p.startTime);
  const onchainCum = Number(await c.rainfall(p.regionId));
  const incrementMm = Number(await c.rainfallDuring(POLICY_ID));
  const thresholdMm = Number(await c.THRESHOLD());
  const minConfidence = Number(await c.MIN_CONFIDENCE());

  let models;
  if (DEMO) {
    models = synthModels(region, startDate, incrementMm, onchainCum);
  } else {
    models = await fetchModels(region, startDate);
  }

  const snapshot = {
    schema: "rainproof/judge-input@1",
    collectVersion: COLLECT_VERSION,
    policyId: POLICY_ID,
    collectedAt: new Date().toISOString(),
    simulated: DEMO,
    ...(DEMO ? { simulationNote: "模型序列由链上注入值合成，用于演示；真实模式下会向 ECMWF/GFS/ICON 实取。" } : {}),
    epoch: RAIN_EPOCH,
    region: { id: region.id, key: region.key, name: region.name, lat: region.lat, lon: region.lon },
    policy: {
      rider: p.rider,
      regionId: Number(p.regionId),
      startTime: Number(p.startTime),
      endTime: Number(p.endTime),
      startDate,
      rainfallAtBuy: Number(p.rainfallAtBuy),
      paid: p.paid,
    },
    oracle: {
      // 链上那本账（由喂价脚本写入）—— AI 的对照物
      cumulativeMm: onchainCum,
      officialIncrementMm: incrementMm,
      contract: ADDR,
      chainId: Number((await provider.getNetwork()).chainId),
    },
    weather: {
      source: DEMO ? "synthetic" : "open-meteo:ecmwf_ifs025+gfs_seamless+icon_seamless",
      windowFrom: startDate,
      models,
    },
    thresholds: { thresholdMm, minConfidence },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `snapshot-policy${POLICY_ID}.json`);
  const inputHash = evidenceHashOf(snapshot);
  fs.writeFileSync(file, JSON.stringify({ snapshot, inputHash }, null, 2));

  const inc = models.map((m) => m.inWindowMm);
  console.log("=".repeat(74));
  console.log(`证据快照已生成（保单 #${POLICY_ID} · ${region.name}）${DEMO ? "  ⚠️ 模拟数据" : ""}`);
  console.log("=".repeat(74));
  console.log(`窗口        ${startDate} 起 · 阈值 ${thresholdMm}mm`);
  console.log(`链上官方增量 ${incrementMm}mm  （累计 ${onchainCum}mm，投保时快照 ${p.rainfallAtBuy}mm）`);
  console.log(`三模型窗口增量  ${inc.join(" / ")} mm   （${MODELS.map((m) => m.label).join(" · ")}）`);
  console.log(`inputHash   ${inputHash}`);
  console.log(`写入        ${file}`);
})().catch((e) => {
  console.error("💥 采集失败：" + (e.shortMessage || e.message || e));
  process.exit(1);
});
