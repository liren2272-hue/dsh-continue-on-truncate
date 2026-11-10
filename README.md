# @local/dsh-continue-on-truncate

当回答因 **已达输出 token 上限** 被截断时，DeepSeek Harness 本来就会：
- 保留已生成的输出在对话里；
- 显示一条 “Output token limit reached / 已达到输出 token 上限” 提示，并建议手动发送「继续」。

本插件让系统**真正自动接着输出**，并把 **真人继续** 与 **机器继续** 清清楚楚地分开：
续写永远是带 `source.kind = "dsh-continue-on-truncate"` 的**机器消息**，绝不伪装成一条
真人「继续」气泡。

当前版本 **v3.3.0**。

---

## v3.3 修了什么（对应「还是没法真正自动续写，之前的对话还是中断了」）

### 症状
线上 `/host-active` 明明回报 `active:true / steerCount:10`（预算用满），但用户仍要
反复手动打「继续」——多份会话日志（`session-38478145` / `session-0bf50f46` / `ee253e`）
都是同一个模式：`机器 steer → 模型续写 → TURN END reason=max-tokens → 用户手动「继续」
→ 新 TURN`。等于插件「动了」却没有把回合接住。

### 根因（从 `app.asar` 的 `dsh-agent-loop/lib/index.js` 逐行取证）
1. **同一回合永远无法干净收尾**。核心循环把 `turnEnds` 锁存：
   `if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;`
   一旦某 step 撞上 `max-tokens`，**这个 turn 的 `turn/end` reason 就永久是 max-tokens**，
   前端于是恒派生 `turn-max-tokens` 节点、恒显示「已达到输出 token 上限…发送『继续』」。
2. **v3.2 用 `agent.steer()` 在「同一回合的下一步」续写**（next-step）。每个续写 step
   都继承上面那条锁存，且很容易再次撞上 max-tokens；预算（默认 5 / 面板 10）很快耗尽，
   回合最终仍以 `max-tokens` 死掉。`steerCount:10` 正是「同回合空转 10 次」。
3. **两半边互相甩锅**。客户端兜底被
   `clientFallback = !host.active && (mode === 'silent' || mode === 'button')` 门控，
   而 `host.active` 只代表「协调路由注册成功」，**恒为 true** → 客户端**永不**自动发
   「继续」，全押宿主 steer；宿主 steer 又无法收尾 → 没有任何东西自动接上。比没插件还糟
   （把兜底关掉了）。

### 修复：改用 `agent.followup()` 开**全新回合**
`followup(input)` 把消息放进 **next-turn** inbox 并带 `wakeup=true`。核心循环
`turn()` 的 `finally` 里 `if (!this.inbox.hasPending) return false;` → `kick()` 的
`while (await this.turn())` 见到 `hasPending` 为真就**自动开启一个新 turn**：新 turn 的
`turnEnds` 复位为 `null`、拥有**独立的 `maxTokens` 输出预算**，模型干净收尾时
`turn/end` = `completed`（不再有 `turn-max-tokens` 节点、不再有「发送继续」提示）。
这等价于用户手动打「继续」，但全自动、且是机器消息而非伪造真人气泡。

具体改动（宿主 `index.js`）：
- 续写触发点**唯一**放在 `agent/turn-stopping`（serial 事件，恰在 `nextStep` 为空、
  回合即将 `break` 时）：此时调 `ag.followup(continuationMsg)` 排一条 next-turn 机器续写。
- `agent/assistant-stream` 退化为**纯观察者**：只按 `frame.attemptId` 维护
  `chain / chainDone / count` 状态，**不再 steer**，避免 followup + steer 双续写。
- 干净的 `stop`（非 `tool-calls` / `error` / `aborted`）→ `chainDone`，回合自然收链；
  `maxContinuations` 预算封顶、`mode=off` 关闭、`agent/disposed` 清理，全部保留。
- `resolveAgentFromFrame` 与能力判定同时兼容 `followup()` / `steer()`（老宿主回退）。
- 版本号 `3.2.0 → 3.3.0`，`GET /host-active` 的 `version` 用于活体区分新旧构建。

客户端 `client.js` 同步：可见文案「系统已在同一回合接续」→「系统已自动接着输出」
（v3.3 是新回合，旧措辞与机制矛盾）；注释与头部版本同步；**门控保持不变**
（host 驱动续写，客户端不做双续写）。

---

## 历史版本修了什么（保留作变更记录）

### v3.2
- 设置卡新增 **「连续续写次数」** 面板：数字框 1–50（默认 5）+「应用」按钮，写入
  `localStorage`（`@local/dsh-continue-on-truncate.cap`）并 `POST {maxContinuations}`
  到宿主，夹取到 1–50 后立即对下一条链生效，无需重启。
- `/host-active` 的 GET 新增 `maxContinuations / capMin / capMax` 三个字段回显运行时上限。
- `version` 升到 3.2.0 用于活体区分。`POST {"enabled":false}` 关闭机器续写（`off` 模式）。

### v3.1
- **改写原生「发送继续」提示**：查明核心循环把 `turnEnds` 锁存为 max-tokens 后前端
  永远渲染误导提示，纯插件改不了 reason，于是在客户端用 apply() 级全局 `<style>`，
  按 `html[data-cot-mode]` 门控（`silent`/`button` 隐藏并改写，`off` 保留原生）。
  选择器基于固定的 `div[data-chat-flow-kind="turn-max-tokens"]`，React 重建节点自动命中。
- 当时新增 `agent/turn-stopping` 在同一回合跨多 step 「保链」（v3.3 已改为在同一事件里
  改排 **fresh-turn followup**，不再 `steer`）。

### v3
- **夜间模式适配**：正文改用 `--dsw-alias-label-primary`（随主题反转）、真实
  `--dsw-radius-sm`，落色兜底 `currentColor` / `CanvasText`；主按钮成对使用
  `button-primary-fill` + `label-primary-foreground`，不写死品牌色。
- **机器/真人界限**：续写消息从 `source:{kind:'user'}`（渲染成真人「继续」气泡）改为
  `source:{kind:'dsh-continue-on-truncate'}`（独立的机器 context/inject 节点）。
  核心循环会把 claimed 的 inbox 消息逐条 `append("user/message", …)` 喂给模型
  （next-step 与 v3.3 的 next-turn 都如此），因此续写照常生效但绝不伪装成人。
- 按 `frame.attemptId` 对每次截断去重、每次新截断重新触发、干净结束清零预算。

---

## 两个半边如何协作（v3.3）
- **宿主半边（`index.js`）——真正的续写驱动（机器）**：监听 `agent/assistant-stream`
  的 `max-tokens` finish 维护链状态；在 `agent/turn-stopping`（回合将 break 时）调用
  `agent.followup()` 把续写排成 **next-turn 的新回合**。新回合 `turnEnds` 复位、
  独立预算，模型继续把任务跑完并可以 `completed` 干净收尾。消息 `source.kind` 非 `user`，
  UI 上是**机器节点**而非真人「继续」气泡。
- **客户端半边（`client.js`）——状态卡 + 手动「继续」按钮（真人）**：注册到追加型
  `conversation.chat.turnTail` 槽（`replaceRisk: "none"`，永不覆盖原生 UI）。扫描
  `turn-max-tokens` 判断截断；提供「机器自动续写 / 手动（真人）」徽标与**只有你点击
  才发送**的「继续」按钮。宿主在场时客户端**不**自动发「继续」（续写已由宿主 followup
  驱动）；仅当宿主半边完全不可达（协调接口 404）时作为最后兜底自动发送。

**防重复触发 / 协调**：宿主把状态通过单一 exact 路由
`/dsh-continue-on-truncate/host-active` 暴露：
- `GET` → `{active, version, steeredRecently, steerEnabled, steerCount, lastSteerTs,
  maxContinuations, capMin, capMax}`（`version` 让一次探针证明运行中宿主实际加载了哪一版）；
- `POST {"enabled":false}` → 关闭机器续写（`off` 时客户端同步）；
- `POST {"maxContinuations":N}` → 设置运行时连续续写上限，夹取到 1–50，立即对下一条链
  生效。两种字段都可选，旧 POST 照常工作。

客户端每次出现**新的** `turn-max-tokens` 节点都重新探测宿主并重新武装（不再一次性冻结）。

## 三种模式（localStorage，键 `@local/dsh-continue-on-truncate.mode`）
- `silent`（默认）：系统以机器消息无感续写，不显示卡片；真人「继续」不被占用。
- `button`：显示机器续写状态 + 徽标 + 手动「继续」按钮；机器仍自动续写。
- `off`：**彻底关闭机器续写**，只保留手动「继续」按钮 —— 续写与否完全由你决定，
  「继续」永远是你发的真人消息。

可在插件设置卡（`plugins.bundle.config`，按包 id 注册）里用单选即时切换；切换通过 `POST`
同步到宿主，并派发 `cot-mode-change` 事件让卡片即时刷新。

## 连续续写次数面板
同一张设置卡下方有「连续续写次数」：数字框（1–50）+「应用」按钮。填好后点「应用」
（或回车）即写入本地并把上限推给运行中的宿主，状态栏显示「已保存到运行中的宿主」及
宿主当前上限；输入非法值会就地提示而不改动。该上限是一条截断链最多续写多少个
**新回合**，防止模型反复打转造成无限循环；干净的 `stop` 会提前收链。
- **版本感知（诚实回退）**：面板按 `GET /host-active` 是否回报 `maxContinuations` 判断
  宿主是否支持运行时上限，不硬编码版本号。宿主已是新版 → 即时生效；宿主仍是旧版
  （尚未重启加载新代码）→ 值照常存进 localStorage，状态栏如实显示「已存本机，宿主
  重启后生效」，绝不谎称已应用。用户自行重启桌面端后，客户端 `apply()` 会把保存的上限
  重新推给新宿主。

## 机制要点
- 截断信号来自宿主 `agent/assistant-stream` 的 `max-tokens` finish；前端 `turn-max-tokens`
  节点只用于客户端状态展示。
- 宿主按 `frame.attemptId` 去重：同一次 attempt 的 replay 跳过，新的 attempt 重新触发；
  干净（非截断）结束会把预算 `count` 归零并清空去重集。
- 续写走 `agent.followup()`（next-turn）→ 核心循环自动开新 turn → `turnEnds` 复位、
  独立 `maxTokens` 预算；这正是 v3.3 能「真正续上且干净收尾」的关键。
- 手动「继续」优先走 `conversation.send("继续")`（会话服务，直达 prompt、不碰输入框）；
  取不到则回退到槽位传入的 `inputActions`（`setDraft` → `submit`）。`conversation` 在
  **发送时**惰性取用。
- 只会对「时间线最后一回合」判断，避免翻历史会话时把「继续」灌进旧截断轮次。

## 启用
本插件由 `cordis.patch.yml` 注入 bundle：在 DSH 插件管理启用
`@local/dsh-continue-on-truncate`（或确认它已出现在已装 bundle 列表），然后
**重启/刷新 DSH 桌面端或 Web GUI** 即可生效。宿主 `index.js` 改动必须重启；客户端
`client.js` 改动可经 HMR 生效。

## 文件
- `package.json` — 包元数据 / `dsh.client.inject` / `dsh.bundle.patch`
- `cordis.patch.yml` — bundle 注入
- `index.js` — 宿主侧：agent 层机器续写（`agent.followup()` 新回合）+ `agent/turn-stopping`
  唯一触发 + 运行时可调上限 + GET/POST 协调接口
- `client.js` — 客户端：截断检测 + 状态卡 + 手动按钮 + 设置卡（含连续续写次数面板）+
  宿主协调 + 原生提示改写全局样式
- `locale/zh.json`、`locale/en.json` — 文案
- `icon.svg` — 主题自适应图标
- `test/selftest.mjs`、`test/chain-scenario.mjs` — 离线单测 + 真实序列链路测试（含负向对照）

## 测试
在插件目录跑（`<baseline-dir>` 指向改动前的 v3.2 原版文件副本，用于负向对照）：

```
node test/selftest.mjs <baseline-dir>        # 宿主 + 客户端单测 + 负向对照
node test/chain-scenario.mjs <baseline-dir>  # 连续截断回合的 fresh-turn 续写链路
```

`selftest.mjs` 覆盖：
- 宿主：每次 `max-tokens` 经 `agent.followup()` 排**新回合**续写（绝不 `steer()`）、
  `source.kind` 非 user、续写标记与 `[CONTINUATION REQUIRED]` 提示存在、`agent/turn-stopping`
  是唯一触发点、`agent/disposed` 清理；GET 协调接口回报 `version:"3.3.0"` 与运行时 cap
  默认值/上下界；`POST {maxContinuations}` 改上限、越界夹取（999→50 / 0→1 / 非数值忽略）、
  `POST {"enabled":false}`（mode=off）禁用；`maxContinuations=2` 恰好封顶 2 次。
- 客户端：`native-hint-rewrite` 全局样式、`data-chat-flow-kind` 选择器、`data-cot-mode`
  门控、中英文改写文案（**不含**「同一回合 / same turn」旧措辞）、`:has` 兜底选择器、
  cap 持久化/宿主同步 helper、设置卡数字框与「应用」按钮、中英文面板文案、host 驱动门控。
- **负向对照**：v3.2 原版没有 version 3.3.0、用 `agent.steer()`（同回合，根因）、没有
  followup 描述、仍写「同一回合」；这些断言在旧 build 上必须「真红」。

`chain-scenario.mjs` 复刻真实日志的「连续截断回合 → 干净 stop 收链」序列，断言：每个
截断回合恰好排 1 次 `followup`、clean `stop` 收链、全是机器消息、`maxContinuations` 边界
（周转到预算耗尽后 agent 空闲、后续回合不再发生）、**负向对照**证明 v3.2 用 steer 且
不满足 v3.3 契约。两套脚本都必须 `ALL SCENARIOS PASS`，负向对照必须真红。
