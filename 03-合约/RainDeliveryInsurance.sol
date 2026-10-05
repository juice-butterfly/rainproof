// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * RainDeliveryInsurance —— 雨天骑手配送中断险（参数化保险）
 *
 * 场景：外卖骑手在暴雨天配送，配送中断造成的收入损失，由保险自动赔付。
 * 特点：不看发票、不报案、不人工定损 —— 天气数据触发阈值就自动赔。
 *
 * 相比「教科书骨架版」，这一版修掉了 4 个会在演示现场炸掉的问题，见下方 ★ 标注。
 */
contract RainDeliveryInsurance {

    // ==================== 参数 ====================

    uint256 public constant PREMIUM   = 0.001 ether;   // 保费
    uint256 public constant PAYOUT    = 0.01  ether;   // 赔付额
    uint256 public constant THRESHOLD = 50;            // 触发阈值：保单期间累计降雨 ≥ 50mm
    uint256 public constant MIN_HOURS = 1;
    uint256 public constant MAX_HOURS = 72;            // ★ 修正 1：保单时长必须有上限

    uint8   public constant REGION_COUNT = 5;          // ★ 修正 2：区域要有白名单

    address public operator;                            // 喂价者 = 你的脚本
    bool    public paused;

    // ==================== 数据结构 ====================

    struct Policy {
        address rider;          // 投保骑手
        uint8   regionId;       // 1=武汉 2=上海 3=北京 4=广州 5=成都
        uint256 startTime;
        uint256 endTime;
        uint256 rainfallAtBuy;  // ★ 关键设计：投保当刻的【累计】降雨快照
        bool    paid;
        bool    exists;
    }

    mapping(uint256 => Policy)  public policies;       // policyId => 保单
    mapping(uint8   => uint256) public rainfall;       // regionId => 累计降雨量(mm)，由喂价脚本推
    mapping(address => uint256[]) private _byRider;    // 骑手 => 自己的保单号
    uint256 public nextPolicyId;                       // 从 0 开始

    // ==================== 事件 ====================

    event PolicyBought(uint256 indexed policyId, address indexed rider, uint8 indexed regionId, uint256 endTime);
    event RainfallUpdated(uint8 indexed regionId, uint256 cumulativeMm, address indexed reporter);
    event ClaimPaid(uint256 indexed policyId, address indexed rider, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount, uint256 newBalance);
    event PoolWithdrawn(address indexed to, uint256 amount);
    event OperatorChanged(address indexed from, address indexed to);
    event PausedSet(bool paused);

    // ==================== 修饰器 ====================

    modifier onlyOperator() { require(msg.sender == operator, "not operator"); _; }
    modifier notPaused()    { require(!paused, "contract paused"); _; }

    constructor() {
        operator = msg.sender;
        emit OperatorChanged(address(0), msg.sender);
    }

    // ==================== 投保 ====================

    /// @notice 骑手投保。regionId 1~5，hours_ 1~72，需随交易附带 PREMIUM
    function buyPolicy(uint8 regionId, uint256 hours_) external payable notPaused returns (uint256 id) {
        require(msg.value == PREMIUM, "premium mismatch");
        require(regionId >= 1 && regionId <= REGION_COUNT, "bad region");
        require(hours_ >= MIN_HOURS && hours_ <= MAX_HOURS, "hours out of range");

        id = nextPolicyId++;
        policies[id] = Policy({
            rider:         msg.sender,
            regionId:      regionId,
            startTime:     block.timestamp,
            endTime:       block.timestamp + hours_ * 1 hours,
            rainfallAtBuy: rainfall[regionId],     // 记下快照
            paid:          false,
            exists:        true
        });
        _byRider[msg.sender].push(id);

        emit PolicyBought(id, msg.sender, regionId, policies[id].endTime);
    }

    // ==================== 喂价 ====================

    /**
     * @notice 更新某区域的【累计】降雨量。只有 operator（你的喂价脚本）能调。
     * @dev    传累计值，不是单次增量。脚本每次推送「截至目前的累计降雨」，
     *         合约靠「当前累计 − 投保时快照」算出保单期间的真实降雨。
     */
    function updateRainfall(uint8 regionId, uint256 cumulativeMm) external onlyOperator {
        require(regionId >= 1 && regionId <= REGION_COUNT, "bad region");
        require(cumulativeMm >= rainfall[regionId], "cumulative must not decrease"); // 单调不减
        rainfall[regionId] = cumulativeMm;
        emit RainfallUpdated(regionId, cumulativeMm, msg.sender);
    }

    // ==================== 赔付 ====================

    /**
     * @notice 申请赔付。任何人都可以触发，但钱只会打给保单里的骑手本人。
     * @dev    四条 require 就是「为什么赔 / 为什么不赔」的完整规则，全部链上公开可查。
     */
    function claim(uint256 policyId) external notPaused {
        Policy storage p = policies[policyId];

        require(p.exists,                                  "no such policy");
        require(!p.paid,                                   "already paid");
        require(block.timestamp <= p.endTime,              "policy expired");
        uint256 during = rainfall[p.regionId] - p.rainfallAtBuy;
        require(during >= THRESHOLD,                       "threshold not met");
        require(address(this).balance >= PAYOUT,           "insurance pool empty");   // ★ 修正 3

        // 先改状态再转账 —— 防重入的标准写法（Checks-Effects-Interactions）
        p.paid = true;

        // ★ 修正 4：用 call 而不是 transfer
        //   transfer 只转发 2300 gas，收款方若是合约会失败；call 是现行推荐做法。
        (bool ok, ) = payable(p.rider).call{value: PAYOUT}("");
        require(ok, "payout transfer failed");

        emit ClaimPaid(policyId, p.rider, PAYOUT);
    }

    // ==================== 资金池 ====================

    /// @notice 团队注资到赔付资金池（演示前必须做，否则第一笔赔付就失败）
    function fundPool() external payable {
        require(msg.value > 0, "zero amount");
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    /// @notice 提取多余资金。只允许 operator，且不能把赔付准备金掏空。
    function withdrawPool(uint256 amount) external onlyOperator {
        require(amount <= address(this).balance, "insufficient balance");
        (bool ok, ) = payable(operator).call{value: amount}("");
        require(ok, "withdraw failed");
        emit PoolWithdrawn(operator, amount);
    }

    // ==================== 管理 ====================

    function setPaused(bool v) external onlyOperator {
        paused = v;
        emit PausedSet(v);
    }

    function transferOperator(address next) external onlyOperator {
        require(next != address(0), "zero address");
        emit OperatorChanged(operator, next);
        operator = next;
    }

    // ==================== 只读接口（前端直接用这些） ====================

    function regionName(uint8 regionId) public pure returns (string memory) {
        if (regionId == 1) return "wuhan";
        if (regionId == 2) return "shanghai";
        if (regionId == 3) return "beijing";
        if (regionId == 4) return "guangzhou";
        if (regionId == 5) return "chengdu";
        return "unknown";
    }

    /// @notice 保单期间至今的累计降雨（未到期时随时可查，用于「还差多少才赔」）
    function rainfallDuring(uint256 policyId) external view returns (uint256) {
        Policy storage p = policies[policyId];
        if (!p.exists) return 0;
        return rainfall[p.regionId] - p.rainfallAtBuy;
    }

    /// @notice 距离触发赔付还差多少毫米（0 = 已达标）
    function shortfall(uint256 policyId) external view returns (uint256) {
        Policy storage p = policies[policyId];
        if (!p.exists) return THRESHOLD;
        uint256 during = rainfall[p.regionId] - p.rainfallAtBuy;
        return during >= THRESHOLD ? 0 : THRESHOLD - during;
    }

    /// @notice 某个骑手的全部保单号（前端「我的保单」列表用）
    function policiesOf(address rider) external view returns (uint256[] memory) {
        return _byRider[rider];
    }

    /// @notice 赔付资金池余额 —— 前端顶部显示「偿付能力」
    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice 这份保单现在处于什么状态（前端直接显示，不用自己拼逻辑）
    function policyStatus(uint256 policyId) external view returns (string memory) {
        Policy storage p = policies[policyId];
        if (!p.exists)                                  return "not_found";
        if (p.paid)                                     return "paid";
        if (block.timestamp > p.endTime)                return "expired";
        if (rainfall[p.regionId] - p.rainfallAtBuy >= THRESHOLD) return "claimable";
        return "active";
    }
}
