# dsh-turn-preset-router

[English](README.md) | 中文

**为 DeepSeek Harness 在每一轮对话前自动选择工具模式。** 新消息进来时，本地规则在第一步模型请求之前同步定下这一轮用 `standard`、`ptc` 还是 `minimal`；本地拿不准时后台再补一次 Flash 判定，用来改进下一轮。

## 为什么需要它

DSH 用 agent preset 决定一个会话以什么形态向模型呈现工具。但 preset 只能在会话启动前选定：首轮开始后，`agentPresets.select()` 会抛 `agent-preset/locked`。于是绝大多数会话从头到尾只有一种工具形态。

真实会话却常常混着用：先批量改一批文件，紧接着问「刚才那个为什么失败」；或者先随口问一句，再让它遍历整个仓库。用一种形态硬扛所有轮次，要么在短问答上浪费上下文，要么在批量任务里让模型一遍遍手写循环。

本插件补上「每轮选择」这一层：

- **每轮判定，同步落地**：用户消息落盘后、驱动器组装 step 之前完成，本轮的工具目录随之切换。
- **本地优先**：高置信规则直接给结果，不调模型；只有本地拿不准时才在后台补一次 Flash 判定。
- **尊重显式选择**：说一句「用 ptc」或敲 `/mode ptc` 就粘性生效，直到你改回来。
- **「继续」不重判**：短续写沿用上一轮，不打断正在进行的任务。
- **优雅降级**：部署没有挂载 PTC 运行时时保持 `standard`，任何异常都不会抛到会话里。

插件名里的 preset 指的是「这一轮想要的那套 preset 行为」。在本 DSH 版本中 preset 组合本身换不了，每轮真正可变的是工具执行器与系统提示段落，本插件接管的正是这一部分。

三种模式：

| 模式 | 模型看到 | 落地 |
|---|---|---|
| `standard` | 每个工具一份 JSON Schema（原生函数调用） | 部署默认 executor（native） |
| `ptc` | 一个 `run_code` 加生成的 SDK（程序化调用） | `PtcExecutor` |
| `minimal` | 收窄后的少量工具（默认 `bash` / `read_file` / `write_file` / `edit_file`） | 部署默认 executor + `tools.restrict({ allow })` |

## 安装

这是一个 DSH Host bundle：不需要构建，也没有运行时依赖。

装完都需要**重启 DSH** —— 插件改的是 profile 的 patch 层，热重载不生效。

### 插件页（推荐）

打开 **插件** → **添加插件**，三选一：

| 方式 | 填什么 |
|---|---|
| **npm 包名** | `dsh-turn-preset-router` |
| **GitHub 仓库地址** | `choleraehyq/dsh-turn-preset-router` |
| **本地目录** | 本检出的绝对路径，如 `/path/to/dsh-turn-preset-router` |

装好后在插件页**启用**它。插件页会同时把包写进 `dependencies` 和 `dsh.profile.bundles`，这一步很关键——只装包不加 bundle 的话插件不会被加载。

> 三种方式的取舍：**npm** 最省事、能收到版本更新；**GitHub** 可以钉到某个 commit；**本地目录**用 `link:` 语义，改代码重启即生效，适合开发调试。

### CLI

```sh
dsh plugin --profile <你的profile名> add dsh-turn-preset-router
```

⚠️ 两个注意点：

1. **`desktop` profile 不能用 CLI 管理。** 它被 DSH 应用独占，CLI 会直接报
   `profile "desktop" is managed exclusively by the Electron application`。这种情况请用上面的插件页。
2. **CLI 只装包，不改 `dsh.profile.bundles`。** 装完还要手动把
   `dsh-turn-preset-router` 加进 profile `package.json` 的 `dsh.profile.bundles` 数组，否则插件不会被加载。

### 开发期 overlay

```sh
dsh --profile <你的profile名> --patch ./dev/dev.patch.yml
```

`dev/dev.patch.yml` 是**覆盖式** patch（没有 `insert`），只改已安装行的 config，不会加载检出代码。要从检出直接加载插件，用 `dev/dev.insert.patch.yml`（仅适用于**未安装**该插件的 profile）：

```sh
dsh --profile <你的profile名> --patch ./dev/dev.insert.patch.yml
```

两者的区别和误用后果见 [docs/DESIGN.md](docs/DESIGN.md) §9.12。

## 使用

### 自动判定

无需操作。每条用户消息落盘后，`agent/inbox/inserted` 会在驱动器唤醒、组装 step 之前同步触发：显式模式指令与本地规则都在这个同步 handler 里完成切换，所以结果对本轮生效。只有后台的模型补判是异步的。`agent/pre-step` 是安全网——它触发时本 step 的工具目录已经固定，只用于补齐漏判的 agent、准备后续轮次。新会话创建时会读取最近一条实质性用户消息做首次判定。

「继续」「接着」「然后呢」「ok」这类短回复沿用上一轮模式，既不重判也不调模型。

### `/mode`

```text
/mode                  查看当前模式、来源、粘性、最近一次判定原因，以及 PTC 是否可用
/mode standard         固定为标准模式
/mode ptc              固定为 PTC
/mode minimal          固定为最小工具集
/mode auto             清除粘性，恢复自动判定
```

手动指定的偏好会粘性生效（可用 `sticky: false` 关闭），直到 `/mode auto` 或指定另一种模式；「继续」不会改变它。文本里的 `/preset …`、`/router …` 也会被识别为显式模式指令（只是不会打印 `/mode` 的状态块）。

## 怎么判定

本轮判定严格按序、先命中先返回：

| # | 判定 | 说明 |
|---|---|---|
| 1 | 用户显式指定 | 文本里出现模式指令（`用ptc` / `切到 ptc` / `ptc模式` / `use ptc` / `switch to ptc` / `standard mode` …）或 `/mode …` 命令，立即生效并记为粘性偏好 |
| 2 | 继续语义 | 本轮是「继续 / 接着 / 然后呢 / ok / go on / continue」等短续写，直接沿用上一轮，不重判、不调模型 |
| 3 | 本地快速规则 | 命中高置信规则直接决定本轮，不调模型，省时省钱 |
| 4 | 本地倾向 / `defaultMode` | 本地不确定时用本地倾向落地；毫无信号则用 `defaultMode`。保证本轮一定有可用 executor |

如果第 4 步发生了、且 `modelEnabled` 为 `true`，插件会在后台调用一次 Flash 模型，结论返回后切换模式——**作用于下一轮**，不会回头影响已经开始的那一轮。这不是实现偷懒，而是 DSH 的组装顺序决定的：`preStep` 先 assemble 工具目录、之后才跑 `agent/pre-step` waterfall，且 cordis 的 `emit` 不 await 异步 listener，所以异步判定不可能赶在它自己那一轮之前完成。

### 本地规则

- **明确 ptc（高置信）**：批量 / 全量 / 逐个 / 遍历 / 每个文件 / 所有文件；并行 / 并发 / 同时执行；大量循环 / 循环 N 次 / 重复执行；批处理 / 批量发评论 / 批量提交 / 批量创建；脚本化 / 流水线 / 编排；全仓 / 全库 / 全项目范围；解析 N 个文件 / 统计汇总 / 合并去重这类数据加工。
- **明确 standard（高置信）**：短文本加疑问词（什么 / 为什么 / 怎么 / 如何 / what / why / how）；寒暄（你好 / 谢谢 / hi / thanks）；单个动作（帮我看下 X / 读一下 X）；解释型（解释 / 说明 / 介绍一下 / 有什么区别）。
- **minimal（中置信）**：明确要求最小 / 极简 / minimal，或「只跑一条命令」。
- **其余**：本地给不出高置信结论，先按本地倾向或 `defaultMode` 落地，再交给后台模型补判。

### 示例

| 输入 | 模式 | 依据 |
|---|---|---|
| `遍历所有文件，统计每个文件的行数并汇总` | `ptc` | 批量 + 遍历 |
| `并行下载这些 URL 然后合并结果` | `ptc` | 并行 |
| `批量发评论` | `ptc` | 批处理 |
| `解释一下这个函数的作用` | `standard` | 解释型 |
| `帮我看下 README 第一段` | `standard` | 单动作 |
| `你好` | `standard` | 寒暄 |
| `继续` | 沿用上一轮 | 续写 |
| `/mode minimal` | `minimal` | 用户显式指定 |

### 模型慢判（改进下一轮）

- 不在本轮等待模型：本地不确定时先用本地倾向或 `defaultMode` 落地，保证本轮一定有可用 executor。
- 后台发起一次 `ctx.llm.stream(...)`，`temperature` 默认 `0`，输出上限默认 256 tokens，超时默认 8 秒。
- 提示词要求模型只输出 JSON：`{"mode":"standard|ptc|minimal","reason":"…","confidence":0..1}`。
- 解析容错：剥掉 ```` ```json ```` 围栏、抓第一个 `{...}`、非法值回落 `defaultMode`。
- 失败（超时 / 异常 / 不可解析）一律按「模型没有给出可用判定」处理：保持已落地的模式，不影响会话。
- 结论返回后，如果用户期间没有手动指定、且结论与当前模式不同，就切换——从下一轮开始生效。
- provider / model 解析顺序：插件配置 → agent options / 会话 `requestHeader()` → `agentDefaultModel` → 第一个注册的 provider；model 默认 `deepseek-v4-flash`。

## 配置

所有字段都可选，逐项说明见 `cordis.patch.yml` 注释。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `defaultMode` | `'standard'` | 无法判定 / 失败时使用 |
| `provider` | `''` | 空 = 自动解析 |
| `model` | `'deepseek-v4-flash'` | 慢速判定模型 |
| `modelEnabled` | `true` | 是否启用 Flash 慢判（结论作用于下一轮） |
| `modelMaxTokens` | `256` | 慢判输出上限 |
| `modelTemperature` | `0` | 慢判采样温度 |
| `modelTimeoutMs` | `8000` | 慢判超时 |
| `minimalAllowlist` | `['bash','read_file','write_file','edit_file']` | minimal 模式允许的工具 |
| `applyToSubagents` | `false` | 是否接管子 agent |
| `guidance` | `true` | 是否注入模式提示段 |
| `extraPtc` | `[]` | 追加 PTC 关键词 |
| `extraStandard` | `[]` | 追加 standard 关键词 |
| `sticky` | `true` | 是否启用用户显式指定粘性 |

在 profile patch 中覆盖：

```yaml
- id: dsh-turn-preset-router
  config:
    modelEnabled: false
    minimalAllowlist: ['bash', 'read_file', 'edit_file']
    extraPtc: ['截图比对', '批量截图']
```

`extraPtc` / `extraStandard` 追加到本地规则的关键词列表，不改变模型慢判的行为；`modelEnabled: false` 时完全不发模型请求，本轮行为只由本地规则与 `defaultMode` 决定。

## 工作原理

**唯一的切换窗口。** 每轮切换必须在 `agent/inbox/inserted` 的**同步** handler 里完成：该事件在 `inbox.mutate()` 内同步 emit，早于驱动器 `wakeDriver()` 与 step 组装，是本轮唯一还能改变工具目录的时机。cordis 的 `emit` 不 await 异步 listener，所以轮次路径上任何 `await` 都会让切换静默晚一轮。插件因此把准备工作全部挪到轮次之外：`agent/created` 时 `prepare` 拿到 agent 作用域的子 ctx，插件加载时 `warmUp` 预 import `PtcExecutor` 类；轮次路径（`handleUserMessage` → `route` → `applyModeSync`）全程零 await。

**安全网。** `agent/pre-step` 触发时本 step 的工具目录已经固定，在那里换 executor 只对下一轮生效；它只用于补齐 inbox 路径漏掉的 agent 和为后续轮次准备状态。`agent/disposed` 清理状态。

**落地。** 插件在 agent 作用域内 inject 一个可见 `tools` / `systemPrompt` 的子 ctx，用 `ctx.tools.setExecutor()` 同步切换 executor。顺序是**先建后拆**：先把下一个 executor 构造好，再 dispose 旧的，最后 `setExecutor`，同一 tick 内完成——否则中间会出现 `TOOL_EXECUTOR_UNAVAILABLE` 窗口，并发的 assemble 会直接抛错。`ptc` 换成 `PtcExecutor`；`standard` 复用部署默认 executor（不是重新 `new` 一个 native，避免重复构造与语义漂移）；`minimal` 用同一个默认 executor，只多一层 `tools.restrict({ allow: minimalAllowlist })`。`appliedMode` 记录的是 mode 而不是 executor 类型——`standard` 与 `minimal` 共用 executor，只比类型会漏掉 `minimal → standard`，让 allowlist 永久残留。

**可见性。** 切换后 emit `tools/change`，让其他注册表重新读取工具目录；系统提示里注入一小段当前模式说明（`ctx.systemPrompt.section`），每次 assemble 重新渲染。

**降级。** `ptcRuntime` 是可选服务，不能放进 `inject`（`inject` 只在所有服务都存在时才回调，未挂载 PTC 的部署会永远 prepare 不成功、整个插件失效），而是用 `ctx.get('ptcRuntime')` 运行时探测。PTC 不可用、预 import 失败或 `PtcExecutor` 构造失败，都降级 `standard` 并记 warn，绝不把异常抛到会话。

**状态。** 每个 agent 一份 WeakMap：已落地的 mode、当前 mode、来源、粘性偏好、最近判定、agent 子 ctx、两个 disposer、以及后台补判的 promise（防并发），agent 销毁时自动清理。

## 开发

```sh
npm test                                   # 规则、续写、显式模式、配置、状态机
npm run classify -- "遍历所有文件统计行数"   # 离线分类 CLI，只跑本地规则
```

三个集成 harness 会挂载真实的 Host 服务，需要先让 `@deepseek-ai/*` 能从 `dev/` 解析：

```sh
ln -s /path/to/dsh/node_modules dev/node_modules
npm run integration    # 在真实 ToolsService / SystemPrompt 上挂载插件（9 场景 / 25 断言）
npm run spike          # executor 往返切换 spike
npm run prestep        # pre-step 安全网只 park、下一轮消费（5 场景 / 30 断言）
npm run regression     # 慢判时序回归：结论不得落进产生它的那一轮（4 case / 26 断言）
npm run verify         # 以上全部 + 单测，一条命令跑完

npm run real -- "你好"  # 启动真实 dsh 进程 + 真实模型跑一轮（隔离 DSH_HOME）
```

`npm run real` 是最接近用户实际使用的一层：真实 `dsh` 进程、真实会话、真实模型。结果与限制见
[docs/LOCAL-VERIFY.md](docs/LOCAL-VERIFY.md)。

设计与实现契约见 [docs/DESIGN.md](docs/DESIGN.md)；文档与实现不一致时以它为准（其中 §9 是实施后的修正，覆盖前文冲突处）。

## 限制

- **模型判定只影响下一轮。** 受 DSH 组装顺序限制：工具目录在 `agent/pre-step` 之前就已固定，且事件 emit 不 await 异步 listener。本轮永远由本地规则或 `defaultMode` 决定；这不是实现偷懒。
- **切换会重建前缀。** 换模式会改变工具目录与系统提示，下一次请求要重建前缀（一次 KV cache 失效）。这是换模式的固有代价。
- **`ptc` 需要挂载 `ptcRuntime`。** 未挂载时自动降级 `standard`，并在 `/mode` 里说明。
- **preset 本身换不了。** 首轮之后 `agentPresets.select()` 被锁，插件接管的是工具执行器与提示段落，也就是 preset 中每轮真正可变的部分。
- **默认只接管根 agent。** 子 agent 保持自己的组合；需要时设 `applyToSubagents: true`。根/子的判定读会话头（`origin: 'subagent'`）——DSH 0.2.2-rc.2 删除了 `agents.roots()`；普通 fork 仍算根 agent。
- **关闭慢判只剩本地规则。** `modelEnabled: false` 时不发模型请求，本轮行为完全由本地规则与 `defaultMode` 决定。
- **粘性偏好不写配置文件。** 它按 agent 保存在插件内存里；resume / fork 后从 session log 里的 `command/run`（`/mode`）事件恢复，因此跨进程重启仍能延续，但不会被写入 profile 配置。需要部署级默认行为请调 `defaultMode` 与 `sticky`。

## 目录结构

```text
dsh-turn-preset-router/
├── package.json              # engines.dsh + dsh.bundle.patch + peerDependencies
├── cordis.patch.yml          # bundle patch（insert 一行 + 默认配置注释）
├── .npmrc                    # 发布指向 npmjs（无凭据）
├── lib/
│   ├── index.js              # Host 插件入口：事件、/mode、状态
│   ├── rules.js              # 本地快速规则（纯函数）
│   ├── classifier.js         # 模型慢判（llm.stream + 解析）
│   ├── router.js             # 状态机 + executor/restrict 落地
│   ├── config.js             # 配置规范化
│   └── messages.js           # 文本抽取、isContinuation、显式模式解析
├── locale/{zh,en}.json       # 插件页标题/描述
├── icon.svg
├── bin/classify.mjs          # 离线分类 CLI（调试用）
├── test/*.test.mjs           # node:test 单测（145 条）
├── dev/
│   ├── plugin-mount-harness.mjs      # 真实服务集成（inbox 路径）
│   ├── presentation-harness.mjs      # executor 往返 spike
│   ├── prestep-harness.mjs           # pre-step 安全网
│   ├── midstep-verdict-regression.mjs # 慢判时序回归
│   ├── run-real.sh                   # 启动真实 dsh 进程验证
│   ├── verify-profile/               # 隔离验证 profile 模板
│   ├── dev.patch.yml                 # 覆盖式 overlay（已安装 profile）
│   └── dev.insert.patch.yml          # 插入式 overlay（未安装 profile）
├── docs/
│   ├── DESIGN.md             # 设计契约（§9 记录实施后修正）
│   └── LOCAL-VERIFY.md       # 真实进程验证记录
├── README.md / README.zh.md
└── LICENSE
```

## 许可证

MIT
