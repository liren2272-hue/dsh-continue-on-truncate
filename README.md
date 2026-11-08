# @local/dsh-continue-on-truncate

当回答因 **已达输出 token 上限** 被截断时，DeepSeek Harness 本来就会：
- 保留已生成的输出在对话里；
- 显示一条 “Output token limit reached” 提示。

本插件在此基础上提供「继续 / Continue」能力，并支持 **系统自动识别 + 自动续写**。

## 两个半边如何协作（绝不重复触发）
- **客户端半边（`client.js`）——可靠主路径**：注册到追加型 `conversation.chat.turnTail`
  列表槽（`replaceRisk: "none"`，永不覆盖原生 UI）。该槽在本回合关闭的瞬间挂载组件，
  组件扫描回合节点里的原生 `turn-max-tokens` 标记判断是否被截断，约 1 秒后自动通过
  `conversation.send("继续")` 让模型接着输出——不打扰、不闪输入框。这是**一定会生效**的路径。
- **宿主半边（`index.js`）——尽力无感增强**：在 agent 层监听 `agent/assistant-stream`，当某步
  以 `max-tokens` 结束时，调用 `agent.steer()` 把续写接在同一回合的「下一步」，UI 上**看不到
  任何「继续」气泡**，体验最无感。

**防重复触发**：宿主半边只处理自己真正续过的那一次——它把「刚才是否 steer 过」通过一个
`GET /dsh-continue-on-truncate/host-active` 接口（`{active, steeredRecently, lastSteerTs}`）
告诉客户端。客户端只有在 `steeredRecently` 为真（宿主确实续了这一轮）时才让出自动发送的资格；
若宿主插件未加载、监听没收到事件、或 `agents` 服务取不到，客户端**兜底**照常自动发送「继续」，
用户永远不会因此失去自动续写。

> 注：当前已安装版本的 asar 里 `agent/assistant-stream` 的 emit 载荷是 `{frame}`（不含 agent）、
> 且分发给 agent-local 作用域，宿主侧只能从 `frame.attemptId` 反查 `sessionId` 再经 `agents`
> 服务拿回 Agent 实例。若任何一环取不到，宿主半边会安全地什么都不做，由客户端兜底。因此
> **客户端半边才是功能保证**，宿主半边只是让那一次更无感。

## 三种模式（存于 localStorage，键 `@local/dsh-continue-on-truncate.mode`）
- `silent`（默认）：无 UI，系统自动续写。最接近「无感」。
- `button`：显示状态 + 自动开关 + 继续按钮，并自动续写。
- `off`：只显示提示 + 继续按钮，不自动（手动点才续写）。

可在插件设置卡（`plugins.bundle.config`，按包 id 注册）里用单选即时切换。

## 机制要点
- 截断信号来自原生 `turn-max-tokens` 节点（只有触达输出上限的那一轮才挂这个节点）。
- 自动发送优先走 `conversation.send("继续")`（会话服务，直达 prompt、不碰输入框）；
  若该服务取不到，回退到槽位传入的 `inputActions`（`setDraft` → `submit`）。
- **只会对「时间线最后一回合」自动触发**，避免翻到 / 重开历史会话时把「继续」灌进旧截断轮次。
- 宿主半边带预算（`maxContinuations`，默认 5）与重入守卫（延续消息带
  `CONTINUATION_MARK` 标记），续到正常结束即清零预算，不会无限循环。

## 启用
本插件由 `cordis.patch.yml` 注入 bundle：在 DSH 插件管理启用 `@local/dsh-continue-on-truncate`
（或确认它已出现在已装 bundle 列表），然后**重启/刷新 DSH 桌面端或 Web GUI** 即可生效。

## 文件
- `package.json` — 包元数据 / `dsh.client.inject` / `dsh.bundle.patch`
- `cordis.patch.yml` — bundle 注入
- `index.js` — 宿主侧：agent 层无感续写（steer）+ 协调接口
- `client.js` — 客户端：截断检测 + 自动续写 + 设置卡 + 宿主协调兜底
- `locale/zh.json`、`locale/en.json` — 文案
- `icon.svg` — 图标

## 测试
`node src/smoke_cot.mjs`（在会话目录跑）：校验客户端三种模式渲染、`turnTail`/`config` 槽注册、
i18n 全键覆盖，以及宿主半边的 steer 触发 / 干净结束不触发 / 重入守卫 / 缺 agents 服务不抛错 /
协调接口返回诚实快照等单元断言。
