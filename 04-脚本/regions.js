/**
 * 区域表 + 累计起点 —— 全项目【唯一】的一份
 * ============================================================================
 *
 * 【为什么必须单独一个文件】
 *   和 canonical.js 同一个道理：坐标、区域 id、累计起点如果喂价脚本和 AI 判定
 *   各写一份，两边迟早会悄悄不一致 —— 症状是「AI 判定说不达标，链上却说达标」，
 *   而且看起来一切正常。所以只留这一份。
 *
 * 【约束】
 *   regionId 必须与合约里的 regionName() 一一对应：
 *   1=wuhan 2=shanghai 3=beijing 4=guangzhou 5=chengdu
 *   改动这张表就要同步改合约，脚本会自检（assertRegionsMatchContract）。
 */

// 坐标用城市中心点。Open-Meteo 的网格是 ~11km(ECMWF) / ~13km(GFS)，
// 城市级别足够；真要更细可以换成区级坐标，但 id ↔ 名称的对应关系不能动。
const REGIONS = [
  { id: 1, key: "wuhan",     name: "武汉", lat: 30.5928, lon: 114.3055 },
  { id: 2, key: "shanghai",  name: "上海", lat: 31.2304, lon: 121.4737 },
  { id: 3, key: "beijing",   name: "北京", lat: 39.9042, lon: 116.4074 },
  { id: 4, key: "guangzhou", name: "广州", lat: 23.1291, lon: 113.2644 },
  { id: 5, key: "chengdu",   name: "成都", lat: 30.5728, lon: 104.0668 },
];

const REGION_BY_ID = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

// 累计降雨从这个日期开始算。2026-10-01 = 赛事周的第一天。
// 合约侧按「保单期间增量」判定，这个 epoch 只影响链下脚本怎么算累计值。
const RAIN_EPOCH = process.env.RAIN_EPOCH || "2026-10-01";

/** 把合约里的 regionName 逐个拉出来比对，对不上就抛 —— 别让错区域悄悄跑一整场 */
async function assertRegionsMatchContract(contract) {
  const bad = [];
  for (const r of REGIONS) {
    const onchain = await contract.regionName(r.id);
    if (onchain !== r.key) bad.push(`#${r.id} 合约=${onchain} 脚本=${r.key}`);
  }
  if (bad.length) throw new Error("区域表与合约不一致：" + bad.join("; "));
}

module.exports = { REGIONS, REGION_BY_ID, RAIN_EPOCH, assertRegionsMatchContract };
