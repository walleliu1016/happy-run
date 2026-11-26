# 律动跑酷 · B 熔岩运动配色落地清单

| 项 | 值 |
|---|---|
| 文档版本 | `lava-rollout@v1` · 2026-11-26 · P16 |
| 触发 | 用户拍板「选B」（配色方案 A/B 评审，见 `律动跑酷-配色方案AB对比.md`） |
| 上位规范 | `律动跑酷-UI版式规范.md`（栅格 / 安全区 / 字号 / 层级 / 五态 / 点击区，全部数字一项未动） |
| 落地范围 | **9 屏 + 12 弹层 + 游戏 HUD + 关卡海报 + 分享海报 + TV APK 壳**；已覆盖发布（链接不变） |
| 附带修复 | TV 遥控「不灵敏 / 卡顿」根治、老内核 CSS 降级、焦点金圈被组件覆盖的历史 bug |
| 配套 | `p16-lava-rollout-overview.md`、评审稿 `律动跑酷-配色B-熔岩运动.svg` |

---

## 0. 结论先行

1. **B 版已全量落地为「暗色单轨」**：浅色信息外壳（`#f5f5f7` / `#ffffff` / `#1d1d1f` / `#0071e3`）与霓虹暗舞台的双轨割裂已消除，9 个屏统一到 12 个 `--c-*` 语义 token。改动统计：**164 处硬编码 hex → token/暖色、44 处 rgba、28 处装饰色冷转暖**，硬编码 hex 出现次数 248 → 90（剩余 90 处为装饰渐变、段位金属色与 12 个 token 定义本身，按规范不入语义 token）。
2. **换配色不是改一行 CSS**：落地第一步按 P15 §6 做了 token 化，旧变量名（`--blue` / `--card` / `--ink` 等 11 个）保留为**兼容别名**指向新 token，避免逐处改 248 次；同时把浅色外壳的 `rgba(0,0,0,.07)` 分隔线换成 `rgba(255,255,255,.12)`、浅阴影换成 `0 18px 42px rgba(0,0,0,.5)`。
3. **顺手根治了 TV 卡顿**（用户上一条诉求）：响应链路 4 层瓶颈全修，探针实测连续 20 次方向键平均 **0.07ms**、最大 **0.7ms**，长按 repeat 连发 10 次被节流到 0 次移动，0 个页面错误。
4. **发现并修掉一个历史 bug**：`.room-banner` 等组件自带 `box-shadow` 且定义在 `.tv-focus` 之后，同特异性后写胜出，**把 TV 焦点金圈整条规则覆盖掉了** —— 横幅类组件上焦点环从未真正显示。现已强制兜底，并给 `overflow:hidden` 的分组列表加 inset 变体。
5. **不承诺「生成即可用」**：评审稿是规格标注图、不进引擎；逐屏位图资源（发光粒子 / 复杂纹理）、SVG 图标家族、TV 真机验收仍是后续项，见 §11。

---

## 1. 12 个语义 token（B 熔岩运动，精确色值）

| token | 用途 | 值 | 旧别名 |
|---|---|---|---|
| `--c-bg` | 全屏底 | `#120D0B` | `--bg` |
| `--c-surface` | 卡片 / 分组 / 弹层 | `#211812` | `--card` |
| `--c-surface2` | 悬浮 / 按下 / 分隔区 | `#31241B` | `--blue-soft` |
| `--c-ink` | 主文字 | `#FFF6EC` | `--ink` |
| `--c-ink2` | 次文字 | `#BFAE9E` | `--ink-2` |
| `--c-brand` | 主强调 / 主按钮 / 进度 | `#FF7A1A` | `--blue` / `--orange` |
| `--c-accent` | 次强调 / 教练标签 | `#FF4D4D` | `--purple` |
| `--c-gold` | 得分 / 星级 / 连击 | `#FFC233` | — |
| `--c-danger` | 失败 / PK / 破纪录 | `#C4243B` | `--red` |
| `--c-success` | 判定 Perfect / 连接成功 | `#C6FF4D` | `--green` |
| `--c-daily` | 今日挑战 | `#4A6B14` | — |
| `--c-focus` | **TV 焦点环（已确认，两版同值）** | `#FFB020` | — |

辅助 token：`--line: rgba(255,255,255,.12)`、`--line-strong: rgba(255,255,255,.22)`、`--shadow-dark: 0 18px 42px rgba(0,0,0,.5)`。**12 个 token 无重复色值**（B 的 `danger` 与 `accent` 已拆开，避免改一个影响另一个）。

### 对比度使用边界（WCAG 2.1 实算，P15 §3）

| 色对 | 对比度 | 判定 | 本轮执行 |
|---|---|---|---|
| `ink / bg` 主文字 | 18.05:1 | AAA | 全屏正文 |
| `ink2 / bg` 次文字 | 8.97:1 | AAA | 副文案 / 小字 |
| `brand` 上文字 | 7.40:1（深字） | AAA/AA+ | **主按钮 / 选中 chip 统一改 `color: var(--c-bg)` 深炭字**，共 5 处 |
| `gold` 上文字 | 11.96:1（深字） | AAA | 徽章深字 |
| `accent` 上文字 | 5.90:1（深字） | AA | 仅大字号 / 图标 / 描边 |
| `danger` 上文字 | 5.36:1（浅字） | AA | 仅大字号 / 图标 / 描边 |
| `focus` 焦点环 | 10.55:1 | AAA | TV 3m 可辨 |

> `accent` / `danger` 不得承载 B2 24u 以下正文。亮底段位徽章（silver / gold / plat / diamond）改用深色字，避免「浅底浅字」。

---

## 2. 明暗单轨统一（实际改了什么）

| 类别 | 原状 | 落地后 | 数量 |
|---|---|---|---|
| 硬编码 hex | 110 个不同值 / 248 次 | 164 处映射到 token 或暖色变体 | 164 |
| rgba 浅分隔线 | `rgba(0,0,0,.05~.08)` | `rgba(255,255,255,.12~.18)`（暗底可见） | 44 处 rgba 合计 |
| 蓝/紫品牌阴影 | `rgba(0,113,227,*)` / `rgba(123,47,247,*)` | `rgba(255,122,26,*)` / `rgba(255,77,77,*)` | — |
| 白底 chip + 深字 | `background:#fff; color:#6e6e73` | `background: var(--c-surface2); color: var(--c-ink)`（3 处） | 3 |
| 图表预览白块 | `background:#fff` | `background: var(--c-surface)` + 白描边 | 1 |
| 二维码 | 被误映射成暖白 | **保留纯 `#ffffff`**（扫码识别需要） | 1 |
| 段位/榜单亮底徽章文字 | 浅字（映射副作用） | 改深字 `#3a2a20` / `#7a1a10` | 2 |
| 关卡海报装饰色 | 橙 / 天蓝 / 紫 / 红 / 黄 / 橙 | 橙 / 金 / 珊瑚 / 深红 / 青柠 / 暖棕（6 关仍可区分，全暖） | 5 + FREE |
| 动作色 `ACTION_COLOR` | 含紫 `#af52de`、蓝 `#0071e3`、天蓝 `#5ac8fa` | 7 个动作全暖（橙 / 深红 / 亮红 / 青柠 / 金 / 珊瑚 / 棕） | 7 |
| 彩纸 / 分享海报 / 赛道中线 | 冷蓝紫 | 暖色家族 | 3 组 |
| Joy 设备图标 | 蓝柄 `#2f80ff`、红柄 `#ff375f` | 蓝柄提亮 `#5aa9ff` + 浅色 `stroke .6`、红柄对齐 `--c-accent #FF4D4D`，**造型不动** | 1 |

**保留不动**（不在语义 token 范围）：SPACE / CANDY 关卡 Three.js 主题的冷紫蓝场景色 —— 多主题是关卡识别设计，且场景美术不由 UI 规格单方改动；只把默认 `NEON` 主题的三处冷青补光（`sun` / `sunGlow` / `rimR`）改为暖金与品牌橙，消除「菜单暖、进游戏冷」的割裂。

---

## 3. 老内核 CSS 降级（Chrome 60–79，P14 §10.2 落地）

| 特性 | 支持起点 | 原状 | 本轮处理 | 数量 |
|---|---|---|---|---|
| `inset: 0` | Chrome 87 | 全屏遮罩 / 画布 / 海报底图定位**完全失效** | 展开 `top/right/bottom/left: 0` 四值 | 20 |
| `clamp()` | Chrome 79（边界） | 269 处，<79 内核整条声明丢失 | 单值声明前补**固定 px 离散档回退**（取 max 值，TV 大屏友好）；新内核仍走 clamp | 70 |
| `cqw` | 容器查询 | `padding: 2cqw 4cqw` 无回退 | 补 `padding: 3px 6px` 回退 | 1 |
| `aspect-ratio` | Chrome 88 | 关卡海报 / 校准格高度塌陷 | `@supports not (aspect-ratio: 1)` 内用 `::before { padding-top: 100% }` 撑等比高 | 4 类 |
| `:has()` | Chrome 105 | PiP 时 HUD 不避让 | 改 `#screen-game.pip-on`，由 `syncPip()` 在 4 处显隐后同步 class | 2 规则 |
| `backdrop-filter` | 部分老内核 | 17 处毛玻璃 | 保留（不支持时自动忽略，有实色底兜底；非卡顿源） | — |

验证：`inset:` / `:has(` 残留 **0**；`getComputedStyle` 实测 `.lp-bg` / `#game-canvas` 四值均为 `0px`。

---

## 4. TV 焦点响应性根治（本轮附带）

### 4.1 四层瓶颈 → 修复

| 层 | 原瓶颈 | 修复 |
|---|---|---|
| **壳侧按键桥** | 每键注入 DOWN + UP 两次 `evaluateJavascript`；网页侧**无任何 keyup 消费者**，一半跨桥纯浪费；系统 repeat 约 50ms/发 | `MainActivity.dispatchKeyEvent` 只注入 ACTION_DOWN；repeat ≥90ms 限速；首次按下零延迟。版本戳 `&v=1.5`，APK `versionName 1.5 / versionCode 6` |
| **焦点几何** | 每次方向键全层 `querySelectorAll` + 逐元素 `getComputedStyle`/`getClientRects()` + 每候选 `getBoundingClientRect()`，读写交替强制同步布局 | `buildCache()` 一次批量：先读完全部样式（不写），再读完全部 rect（不写），缓存 `FocusNode{el,cx,cy}`；按键只做纯算术。失效条件：层 class 变化 / resize / 任意滚动容器 scroll（capture） |
| **滚动** | `focusEl()` 同帧 `scrollIntoView` 强制布局 | 移到 `requestAnimationFrame`，与按键处理解耦 |
| **渲染** | 焦点环四层 `box-shadow`（含 32/40px 大模糊）+ `scale(1.05)`；焦点按钮 `sheen-loop` 无限动画常驻 | 改零模糊双环、去 scale；`.tv-mode` 下关无限扫光与卡片 transition |

**双保险**：JS 侧 `tvnav.ts` 方向键 `e.repeat` 也按 90ms 节流，浏览器直连路径（未装新 APK）同样生效。

### 4.2 响应性规格（新增，写进规范）

| 项 | 规格值 | 依据 |
|---|---|---|
| 单键焦点响应 | ≤ 16ms（1 帧 @60Hz） | 缓存命中后为纯算术；实测 0.07ms / max 0.7ms（桌面 Chrome，电视盒子按 10× 余量仍在 1 帧内） |
| 长按连发间隔 | 90ms | 系统 repeat ~50ms 过密；90ms 仍能连续移动且不掉帧 |
| 首次按键 | 不受节流、零延迟 | `repeatCount == 0` 直接注入 |
| 几何缓存失效 | 层切换 / resize / scroll / DOM 重建 | 避免过期 rect 导致焦点跳错 |
| 每键跨桥次数 | 1（原 2） | 网页无 keyup 消费者 |

### 4.3 焦点环规格（具名参数，跨引擎存档）

| 场景 | 参数 | 值 |
|---|---|---|
| 通用元素 | 白内环 / 金外环（零模糊） | `box-shadow: 0 0 0 3px rgba(255,255,255,.95), 0 0 0 12px var(--c-focus)` |
| 分组列表内（父级 `overflow:hidden`） | inset 双环 | `inset 0 0 0 3px rgba(255,255,255,.95), inset 0 0 0 8px var(--c-focus)` |
| 焦点环 `transform` | 无（原 `scale(1.05)`） | scale 会改变元素 rect，导致下次几何计算抖动 / 焦点跳格 |
| 优先级 | `!important` 兜底 | 组件自带 shadow 且后写会盖掉通用规则 |
| 四具名九宫格边界（未来移植引擎存档） | left / top / right / bottom | 均 `28u`（P14 原值，未改） |

> 本项目是 DOM/CSS 网页游戏，底板/按钮/卡片一律**纯 CSS**，不切九宫格位图（会糊、装不下多语言、撑包体）。四具名值仅作未来移植 Unity（左 下 右 上）/ Unreal·Godot（左 上 右 下）/ Cocos（左 右 上 下）的存档规格；Cocos 的 Border 绑在 SpriteFrame 上，同一底板要两种边界需出两张图。

---

## 5. 逐屏改动清单

| 屏 / 组件 | 改动 |
|---|---|
| 菜单 `screen-menu` | 顶栏 5 个 chip 暗底化、三条横幅、六张关卡海报全暖色、金圈焦点可见 |
| 设置 `screen-settings` | 分组列表暗底 + 白描边、选中行深字、焦点 inset 双环（原「横贯卡片的金线」消失） |
| 档案 `screen-profile` | 头卡 / 段位六档 / 5 分组暗底化；分享海报暖炭→熔岩橙渐变 |
| 准备 `screen-prepare` | 模式卡 / 难度胶囊统一 token |
| 游戏 HUD `screen-game` | 动作色全暖、进度条品牌橙、青色赛道中线改暖、`pip-on` 替代 `:has()` |
| 结算 `screen-result` | 暖橙 S 徽章 / 金星 / 暗统计卡；`.result-wrap` 加 `overflow-y:auto` + `margin:auto`，TV zoom 1.18 下不再裁底部按钮 |
| 体检 / 投屏 / PK / 日历 / 弹层 | 统一 `--c-surface` / `--line` / `--shadow-dark` |
| 关卡海报数据 | `levels.ts` 5 个 accent + FREE 暖化 |
| TV APK 壳 | 按键桥减半 + repeat 节流 + v1.5 版本戳（CI 自动出 `v1.5` Release） |

---

## 6. 验证数据（可复现）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| CSS 花括号平衡 | 764 / 764 |
| token 生效实测 | `--c-bg #120D0B`；`body` = `rgb(18,13,11)` / `rgb(255,246,236)` |
| 焦点环实测 | `rgba(255,255,255,.95) 0 0 0 3px, rgb(255,176,32) 0 0 0 12px`，`transform: none` |
| 焦点响应 | 20 次方向键 avg **0.07ms** / max **0.7ms**；6 个不同焦点落位；0 pageerror |
| 长按节流 | repeat 连发 10 次 → 0 次移动 |
| `inset` / `:has()` 残留 | 0 / 0；四值定位实测 `0px/0px/0px/0px` |
| 逐屏截图 | 菜单 / 设置 / 档案 / 游戏 HUD / 结算 / 准备 6 张 + 手机窄视口，人工目检通过 |
| 手机窄视口 | `bodyBg rgb(18,13,11)`、强横排仍生效、0 pageerror |
| `lb-data.json` | 发布前保持 `{}`（部署坑③） |

---

## 7. 需要人工精修 / 未覆盖项（不谎报「可直接商用」）

1. **逐屏位图资源未产出**：发光粒子贴图、复杂纹理插画（估 8–12 张）仍是下一轮 C/D；评审稿 SVG 是规格标注图、不进引擎、图内文字仅作标注。
2. **图标家族未换**：现有大量 emoji 图标在暗底上饱和度与 B 语义色不统一，建议随 C 入口换 SVG symbol（32/48/64/96u 四档，小档单独简化）。
3. **场景主题色**：SPACE / CANDY 关卡的冷紫蓝舞台保留（关卡识别设计），若要求全暖需另开一轮并做真机目检。
4. **真机验收**：APK v1.5 的遥控手感需电视盒子实测；排障通道保留（WebView debugging、`chrome://inspect` / `adb logcat` 看按键日志）。
5. **对比度复核**：数字按 WCAG 2.1 公式实算，落到真实字体渲染（字重、抗锯齿、TV 面板色域）后仍需取色工具复核一次。
6. **老内核边界**：`clamp()` 回退用的是 max 离散档（TV 大屏取向），若某盒子内核 <79 且是窄屏，需在真机上确认字号不至于偏大。

---

## 8. 待定项（不阻塞）

| 待定 | 说明 |
|---|---|
| 是否需要 PPT 评审稿 | P14/P15 各问过一次，未确认；需要时按同一套规格生成 |
| 逐屏位图放量优先级 | 默认沿用 P14 工单表 P0：菜单 / 准备 / 游戏 HUD / 结算 + 图标家族 |
| 是否统一 SPACE / CANDY 舞台到暖色 | 属方向变更，需单独确认 |

---

## 9. 命名与版本

- 规范：`律动跑酷-UI版式规范.md`（`ui-layout-spec@v1`，配色状态已更新）
- 评审：`律动跑酷-配色A-深空霓虹.svg` / `律动跑酷-配色B-熔岩运动.svg` / `律动跑酷-配色方案AB对比.md`
- 落地：本文档 `lava-rollout@v1` + `p16-lava-rollout-overview.md`
- 资源命名规范沿用 P14 §9：`ui_<screen>_<component>_<state>@v<version>.<ext>`；图内不放文字；进引擎资源出透明底 + 纯色底双版本。
