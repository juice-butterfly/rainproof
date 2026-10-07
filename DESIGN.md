---
name: 雨证 · RainProof 演示与核验界面
description: 深色运营台：真实雨幕做底，细线分段，数字用等宽体说清楚
colors:
  bg: "#070E19"
  bg-2: "#0A1523"
  panel: "#0C1725"
  panel-2: "#101E30"
  ink: "#E9F0F8"
  dim: "#A9BACB"
  faint: "#7F93A9"
  blue: "#3B82F6"
  blue-light: "#7FB0FF"
  accent: "#FFC857"
  ok: "#3FD9A5"
  bad: "#F0836F"
  warn: "#F2B33D"
  cyan: "#2FD3EE"
  hair: "rgba(148,180,215,0.14)"
  hair-strong: "rgba(148,180,215,0.26)"
typography:
  metric:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  h1:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.65
  table:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "26px"
  wrap: "24px"
components:
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
    padding: "18px 20px"
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "#061021"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-default:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-small:
    backgroundColor: "transparent"
    textColor: "{colors.dim}"
    rounded: "{rounded.xs}"
    padding: "7px 12px"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.blue-light}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "2px 7px"
  tag-accent:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "2px 7px"
  metric:
    textColor: "{colors.accent}"
    typography: "{typography.metric}"
  note:
    backgroundColor: "rgba(242,179,61,0.055)"
    textColor: "{colors.dim}"
    typography: "{typography.table}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  toast:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
---

# 雨证 · RainProof — DESIGN

## Overview

**给谁看的、用来干什么**：这是一个 **Operate** 型界面 —— 评委和骑手来看「链上发生了什么、我这单赔不赔、现在能不能投保」。扫描性、一致性、真实状态优先于表现力。

**视觉立场**：像一台**在雨天运行的运营终端**。底色是雨夜（近乎黑的深蓝），真实雨幕由 canvas 画在最底层、强度由链上雨量驱动；上面是**平坦分段 + 发丝线 + 留白**，不用卡片堆叠、不用阴影、不用玻璃。数字（雨量、保费、赔付额、区块高度）一律等宽体 + `tabular-nums`，因为它们是这台机器真正的读数。

**三条设计承诺**：
1. **平面分段，不是卡片堆叠**。分区靠 1px 发丝线与 26px 上留白，不靠阴影与彩色边条。
2. **一个作者化的动效时刻**：雨幕。除此之外页面几乎不动。
3. **页面的每个表面都经过设计**，包括浏览器自己的那部分（选区、光标、滚动条、焦点环、占位符、下划线偏移）。

## Colors

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#070E19` | 页面底（雨夜幕布） |
| `--bg-2` | `#0A1523` | 浮起表面（toast、次级底） |
| `--panel` | `#0C1725` | 面板底 |
| `--panel-2` | `#101E30` | 面板内嵌块（表头、条纹） |
| `--ink` | `#E9F0F8` | 主文字 |
| `--dim` | `#A9BACB` | 次级文字、说明 |
| `--faint` | `#7F93A9` | 三级文字、单位、时间 |
| `--blue` / `--blue-l` / `--blue-d` | `#3B82F6` / `#7FB0FF` / `#1D4ED8` | 主色（操作、链接、主要按钮底）；`-d` 用于按压态与深底上的描边 |
| `--accent` | `#FFC857` | 强调（保费数值、触发线、已触发标记） |
| `--ok` / `--bad` / `--warn` | `#3FD9A5` / `#F0836F` / `#F2B33D` | 状态：已赔付 / 失败 / 警告 |
| `--hair` / `--hair-2` | `rgba(148,180,215,.14)` / `.26` | 1px 发丝线（分隔、描边）；`-2` 用于悬停与滚动条 |
| `--card` / `--line2` | `rgba(255,255,255,.028)` / `rgba(242,179,61,.30)` | 可选表面（离线核验台在用）：内嵌块底 / 琥珀次级描边。主页面不需要就不定义 |

> 历史变量名 `--jade` / `--jade-l` / `--jade-d` 是这套蓝的别名（早期是翡翠绿）。它们**还在被引用**，所以要么连别名一起定义、要么连引用一起改 —— 只改一半会让那一半规则静默失效（离线核验台的焦点环就是这么丢的）。

**规则**
- **对比度**：正文与 placeholder ≥ **4.5:1**，大字与图表标记 ≥ **3:1**。`--faint` 只用于 ≥ 11px 的标签/单位，且必须落在 `--panel` 之上（不要压在 `--panel-2` 的浅块上）。
- **在有色表面上，次级文字从那一路色相里调，绝不用灰**。琥珀面板里的说明文字用琥珀偏白的色，蓝色面板里用蓝色偏白的色。
- 颜色只承担**语义**（状态、可操作、阈值），不做装饰。页面里没有渐变文字、没有装饰性彩色边条。
- 值的写法用 CSS 变量（见 `05-演示站点/index.html` 的 `:root`）；三个页面（主页 / 在线核验台 / 离线核验台）必须引用**同一套 token**。

## Typography

字阶（`--t-*`）：

| token | 值 | 用途 |
|---|---|---|
| `--t-metric` | 26px / 600 / 等宽 | 唯一的大数字：应付保费 |
| `--t-h1` | 19px / 600 | 页面标题 |
| `--t-h2` | 14px / 600 | 分区标题（其后可接一行 `em` 说明） |
| `--t-body` | 13.5px / 400 / 行高 1.65 | 正文、控件 |
| `--t-tbl` | 12.5px / 等宽 | 表格、事件流、说明块 |
| `--t-lab` | 11px | 标签、单位、徽标（**下限**，不再更小） |

**规则**
- 层级靠**字号 + 字重**两层台阶，不靠颜色深浅堆叠。分区标题与正文的差距必须一眼可见。
- **数值一律 `font-variant-numeric: tabular-nums`**（等宽体 + 表格数字），这样纵向读数能对齐。
- 中文正文行宽 ≤ 75 字符；行高 ≥ 1.6。
- **分区之间也要有台阶**。全页只有降雨看板是 `.sec.lead`（17px / 660 / `--ink`），其余分区标题与 `<summary>` 统一 14px / 600 / `--dim`：四个同级的大标题等于没有入口。层级只用字号、字重、颜色深浅，**不加编号、不加色块、不加边条**。
- **同一个状态只说一遍**。越线与否和「还差多少」写在各自那一行（`.rnote`）；「竖线是触发线、赔付按投保后的增量算」只在看板底部写一次（`.rlegend`）；「触发线」三个字只出现在被选中的那一行（`.region:not(.is-sel) .bar::before{content:""}`）。同一件事在三条位置各说一遍，会把读数淹没。
- **标题上方的空间多于下方**：分区 `padding-top` 26px，标题到首块内容的间距 12px。
- 不用 display 字体做「设计感」；等宽体只用于代码、哈希、数字、度量。

## Layout

- 容器：`max-width: 1200px`，左右 `padding: 0 24px`，页面底部 72px 余白。
- 顶栏：品牌（手绘 SVG 标记 + 标题 + 一行说明）与链状态栏同排、可换行；下接 1px 发丝线。
- **状态 rail**：3 格横向网格（资金池余额 / 剩余可赔付 / 合约地址），格间 1px 竖线分隔，每格「小写标签 + 大值」。
- 主体两栏 `grid-template-columns: 1.55fr .95fr`：左栏是数据（降雨看板、链上动态），右栏是操作与解释（投保、AI 层做了什么），**右栏整列一起 sticky**（`.rcol{position:sticky;top:20px;align-self:start}`）。只粘「投保」那一块会在它下方留一段跟着滚的空白 —— 粘的就该是整列。
- 两栏的高度不必相等，但**短的那一栏底下不该是死区**：右栏的内容要撑到和左栏差不多的位置，「AI 层做了什么」放在右栏底部而不是页脚，既补上了这截高度，也把赛道结合度的正面回答放在视线里。
- 分区之间用 `.sec + .sec{border-top:1px solid var(--hair)}` 分隔；不用卡片包裹整个分区。
- 数据行用固定列网格，而不是 flex 文本流：保单行 `200px minmax(220px,1.15fr) minmax(300px,1.5fr) auto`；事件行 `158px minmax(0,1fr) 120px 66px`。长哈希一律 `overflow-wrap:anywhere`，移动端把 `1fr` 换成 `minmax(0,1fr)` 防止撑破列。
- 响应式：单栏（≤ 860px）时状态 rail 与两栏折叠为竖排；表格允许横向滚动（`overflow-x:auto`），不隐藏列。事件流在窄屏默认只显示 6 条，其余折在「展开其余 N 条」按钮后面（`.ev-extra` 只在窄屏隐藏，桌面端一条不少；展开状态记在 `eventsOpen`，轮询重建列表不会把它收回去）—— 不折的话 20 条 × 3 行会吃掉 2/3 屏。
- 折叠区（`<details>`）只用于**低频配置**（合约地址、运营操作），默认收起；主流程永不折叠。

## Elevation & Depth

- **只声明一次层级：1px 发丝描边**（`--hair`）。面板**没有**内阴影、没有外阴影、没有高光边。
- 没有 `box-shadow` 柔影、没有 `backdrop-filter` 玻璃、没有零偏移彩色光晕（`0 0 0 3px`）。焦点与选中状态用**描边颜色**或**实心色块**表达，不用光晕。
- 唯二允许的阴影：① toast 唯一一处投影（`0 12px 40px -12px #000`，用于把浮层从内容里抬起来）；② 不需要第三处。
- 分层只靠三档底色：`--bg` < `--panel` < `--panel-2`，加上描边。

## Shapes

- 圆角：面板与 toast `12px`；控件、说明块 `8px`；徽标、小按钮 `6px`；进度/刻度条用 `99px` 胶囊。
- 胶囊形只给小控件与刻度条，**不给卡片、面板或按钮**。
- 图标一律**手绘几何 SVG**（圆角矩形 + 3 条斜雨线 + 一条 `--accent` 底横线，`viewBox="0 0 34 34"`），与标题**并排**，不用方块底衬、不用 emoji 或符号字形。
- 没有硬偏移阴影（`box-shadow: 4px 4px 0`）、没有斜切、没有描边+内高光的「幽灵卡」。
- 雨幕：canvas 固定在底层（`#rainLayer`），`--rain` 变量（0–1）由链上雨量驱动（刻度 `max(阈值×2, 五城最大值)`，见「降雨看板」条）；`--rain` 用**感知映射** `t^0.6`（t = 该区域雨量 ÷ 刻度）—— 线性映射下 101mm 只有 0.33，画面上就是"几道极淡的斜线"，而雨幕是这一页唯一的主角动效。三轴的强度下限同样按「rain = 0.5 就该看得出在下雨」定：密度 `0.14 + 0.86·rain`、亮度 `0.30 + 0.70·rain`、单滴 alpha `0.16 + 0.42·z`。`prefers-reduced-motion: reduce` 下改为静态雨丝渐变、并把所有动画压到 `0.001ms`。离线核验台没有雨幕，也**没有** `prefers-reduced-motion` 兜底（as-built 差异，待补）。

## Components

组件 token 见 frontmatter（`panel` / `button-primary` / `button-default` / `button-small` / `tag` / `tag-accent` / `metric` / `note` / `toast`）。行为约定：

- **按钮**：hover 只改描边与底色，不位移、不加阴影；`:active` 允许 1px 下沉；`:disabled` 用 `opacity:.5` + **虚线描边**，语义是「还没连钱包 / 条件不满足」。主操作只有一个（`.primary` 实心蓝），其余为描边按钮。
- **输入控件**：`select` 自绘箭头（`appearance:none` + 右侧 34px padding + `::after`），聚焦时描边变 `--blue-l` 并带 3px 低透明色环（唯一允许的聚焦光晕，仅限表单控件）。
- **状态**：每个可交互元素必须有 hover / focus-visible / disabled，数据区必须有 loading（转圈 + 文案）/ empty（说明下一步做什么）/ error（说清问题与恢复路径）四态。空态要写「为什么会空 + 怎么让它不空」，例如「连钱包后，这里会列出你在本合约上的全部保单」。
- **降雨看板**：每条区域一行 —— 行首「城市 + `#id`」、行尾「链上雨量 + 状态徽标」；下方是刻度条（`min(1, 雨量 ÷ (阈值×2))`，阈值位置在 50% 处并画触发线），再下面是「阈值 50 mm · 距触发还差 N mm」的读数行。**刻度公式与触发线位置被 `07-测试工具/check-ui.js` 锁定**，是演示可信度的一部分。注意两个刻度不是同一个：条子回答「这条线跨过去没有」（分母 `阈值×2`），背景雨幕回答「这场雨有多大」（分母 `max(阈值×2, 五城最大值)`）—— 如果雨幕也按 `阈值×2` 封顶，演示链上五城除武汉外会全部顶格，动效层次就没了。读数行只写这一行独有的数（未越线「距触发还差 N mm」/ 已越线「已越过 N mm」），「竖线是什么、赔付按增量算」看板底部只写一次（`.rlegend`），「触发线」三个字只出现在被选中的那一行。
- **AI 层（右栏底部）**：三行「名字 + 一句人话」—— 喂价验收 / 判定复核 / 承保定价，回答「AI 到底在链上链下做了什么」。放在右栏而不是页脚 12.5px 的说明块里：这是赛道结合度的正面回答，压在页脚等于没有。
- **数据行**：保单与事件都是「列头 + 行」的表格化网格，不用卡片；行间 1px 发丝线；哈希与地址用等宽体、中段省略、可复制/可链接（`核验 ↗`）。
- **toast**：底部居中、单条、自动消失 —— **普通提示 5 秒、错误 12 秒**（错误要把恢复路径念完，3 秒不够）；文案是「发生了什么 + 下一步」，前缀用冒号而不是破折号；`role="status"` + `aria-live="polite"`，收起动画结束后**清空文字**（否则屏幕阅读器会重念旧内容）。
- **浏览器表面**：`::selection`、`caret-color`、`::placeholder`、`scrollbar-color` / `::-webkit-scrollbar`、`:focus-visible{outline:2px solid var(--blue-l);outline-offset:2px}`、`a{text-underline-offset:3px}` —— 这些都要显式写，默认样式在这个深色底上不可接受。

## Do's and Don'ts

**Do**
- 保留雨幕作为唯一的主角动效，其余动效时长 ≤ 0.2s 且只解释状态变化。
- 数字用等宽 + `tabular-nums`；单位（SepETH、mm、字节）比数字小一号且用 `--faint`。
- 每个空态、错误态都写「下一步怎么办」。
- 三个页面共用一套 token；新增页面从 `:root` 复制，不另起色值。
- 改动页面后跑 `cd 07-测试工具 && npm test`（六道门禁，251 项）与 `node 07-测试工具/check-html-syntax.js`。

**Don't**
- ❌ 卡片左侧/右侧的彩色边条（≥ 1px 的 `border-left/right` 装饰）。
- ❌ emoji 或 Unicode 字形当图标；❌ 渐变文字；❌ 玻璃模糊（`backdrop-filter`）做装饰；❌ 零偏移彩色光晕；❌ 硬偏移阴影。
- ❌ 「大数字 + 小标签 + 辅证统计」的 hero 指标块当页面结构；本页只有**一个**大数字（应付保费），其余读数走状态 rail 与数据行。
- ❌ 同尺寸「图标 + 标题 + 文字」卡片阵列；❌ 卡片里再套卡片。
- ❌ 标题上方的 kicker / eyebrow；❌ 无信息量的 01 / 02 / 03 章节编号。
- ❌ 进度环、迷你图、柔影圆角块假装内容；❌ 用等宽体当「技术感」戏服。
- ❌ 任何会被代码反驳的文案（例如「现在就能申请赔付」—— 判定只看**投保后的增量**）。

**三页现状（as-built 2026-10-07）**：`05-演示站点/index.html` 结构层已按本文件重构（状态 rail、数据行、去装饰）；`05-演示站点/verifier.html` 与 `06-核验台单文件/汉客松-链上核验台.html` 已同步同一套 token 与元素语言。机械检测（impeccable `detect`）在这三页上：**侧边色条 0 / 图标方块 0 / 11px 以下正文 0**；剩余告警只有该检测器对深色主题误判的 low-contrast（其报出的背景色在文件里不存在）。

**2026-10-07 晚的六条修订**（评审意见落地，只动 `05-演示站点/index.html`）：分区标题分出台阶（`.sec.lead` = 降雨看板）· 右栏改为整列 sticky 并把「AI 层做了什么」从页脚搬进来 · 越线状态只说一遍 · 雨幕加感知映射 `t^0.6` 并抬高三轴强度下限 · 窄屏事件流默认 6 条 + 展开按钮。改动后 `check-ui.js` 21 项与 `check-html-syntax.js` 均通过。
