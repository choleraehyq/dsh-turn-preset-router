# dsh-turn-preset-router — 设计契约（Lead 冻结版）

> 本文件是团队共享的唯一设计事实源。任何实现偏离都必须先改本文件。

## 1. 目标

在 DeepSeek Harness（DSH）中新增一个 Host bundle 插件：**每一轮对话自动为该轮选择 agent preset**，
结合「本地快速规则」与「模型慢速判定」，并严格尊重用户显式选择与「继续」语义。

## 2. 已核实的 DSH 事实（不要重新假设）

运行环境：DSH `0.2.2-rc.1`，Node `24.21.0`，pnpm `11.28.5`，profile `desktop`。

### 2.1 preset 只能会话启动前切换
`@deepseek-ai/dsh-agent-preset-registry` 的 `select(agent, id)` 会检查
`turnBoundaryOf(session)`：`openTurnStartSeq !== null || lastTurn > 0` 时抛
`agent-preset/locked`。**因此「每轮真正换 preset 组合」在核心 API 层面不成立。**

### 2.2 每轮真正可变的两个杠杆（已实测）
1. **工具执行器（executor）可在 agent scope 内同步换。**
   `ctx.tools.setExecutor(executor)` 是 Cordis effect，作用域内只能有一个；dispose 后该 scope
   的选择变为 unavailable，重新声明即生效。实测：`NativeToolExecutor` ↔ `PtcExecutor`
   同步互换成功，`systemPrompt.assemble()` 立即反映（native 见 `demo`，ptc 只见 `run_code`）。
   - 实测要点：`setExecutor` 必须拿到 **agent 作用域内已 inject 的子 ctx**；
     `PtcExecutor` 构造需要 `tools/systemPrompt/ptcRuntime` 三个服务可见。
   - 回退到 native 时**不要** `new NativeToolExecutor`，而是复用部署默认 executor
     （`tools.selectExecutor(undefined)` 捕获），避免重复构造与语义漂移。
2. **系统提示段落可每轮重渲染。**
   `ctx.systemPrompt.section({name, order, text})` 的 `text` 可为函数，按每次 assemble 调用；
   `section` 返回 disposer。`context()` 同理（order 115 的 approval:policy 就是该用法）。

### 2.3 每轮的可靠触发点
- `agent/inbox/inserted`：用户消息落盘后、驱动器唤醒组装 step **之前**同步触发
  （`mutate()` 内 `session.append` 后立刻 emit）。**这是「每轮判定」的主入口。**
- `agent/pre-step` waterfall：`{agent, messages, turn, step, signal, modelSelection}`，
  可返回 `{kind:'enter', messages}`。**这是最后的安全网**（inbox 事件错过时补判）。
- `agent/created` / `agent/turn-stopping`：生命周期辅助。
- `agents.turnBoundaryOf(session)`：读 `{openTurnStartSeq, lastTurn}`，用于判断是否首轮。
- `agent.session.deriveMessages()`：读历史消息；`session.append(type, data)` 记录自定义事件。

### 2.4 不能依赖的东西
- 本 DSH 版本 **没有** `ctx.tools.presentAs(...)`（参考仓库 dsh-ptc-router 针对旧版/另一分支）。
- 核心 `agentPresets.select()` 在首轮后 locked，**不要**在常规轮次调用它。
- profile 插件不能直接 `import '@deepseek-ai/dsh-*'`（实测 `ERR_MODULE_NOT_FOUND`），
  但 **运行期** 由 `plugin-packages` 的 runtime interception 供给；因此：
  - 需要 import 的实现**只允许**放在可测试的纯逻辑模块 + 通过 `ctx.get(...)` 取服务；
  - 若确需 `PtcExecutor` 类，必须 **lazy dynamic import** 并 try/catch 降级
    （见 §4.3），且 dev/test 通过 `ln -s <dsh>/node_modules ./node_modules` 解析。

## 3. 产品语义（用户视角）

每轮开始前，路由器决定该轮使用的**模式**，并落到 §2.2 的杠杆上：

| 模式 | 含义 | 落地 |
|---|---|---|
| `standard` | 原生函数调用（默认） | executor = 部署默认（native）；提示段落说明当前模式 |
| `ptc` | 程序化工具调用（run_code） | executor = `PtcExecutor`；SDK 段落由该 executor 自带 |
| `minimal` | 最小工具集 | executor = native + `tools.restrict({allow:[...]})` 收窄 |

### 3.1 决策优先级（必须严格按序，先命中先返回）

1. **用户显式指定**（最高优先）：本轮文本里出现显式模式指令 → 直接用，且**记忆为粘性偏好**。
   - 中文：`用ptc`/`用 ptc 模式`/`切到ptc`/`ptc模式`/`标准模式`/`最小模式`/`用标准`
   - 英文：`use ptc`/`switch to ptc`/`ptc mode`/`standard mode`/`minimal mode`
   - 也支持命令：`/mode ptc`、`/preset ptc`、`/mode auto`（清除粘性）
2. **继续语义**：本轮是「继续 / 接着 / 然后呢 / ok / 好 / go on / continue」等短续写
   → **直接沿用上一轮判定**，不重判、不调模型。
3. **本地快速判定**（§4.1）：命中高置信规则 → 直接决定，**不调模型**（省时省钱）。
4. **模型慢速判定**（§4.2）：本地不确定时，一次 Flash 调用给出 `{mode, reason, confidence}`。
5. **兜底**：模型失败/超时 → 用 `defaultMode`（默认 `standard`），并记录原因。

### 3.2 粘性规则
- 用户显式指定后，该偏好**持续生效**，直到用户显式改回 `/mode auto` 或指定另一种模式。
- 「继续」不改变粘性偏好。
- 粘性偏好在会话内持久（用 session event 记录，resume 后可恢复）。

### 3.3 不做的事
- 不自动修改用户的 composer 选择、不弹确认框（除 `/mode` 命令输出外静默）。
- 不接管子 agent（可配置 `applyToSubagents`）。
- 不写超出核心合法值的 `approval/policy` 等。

## 4. 判定实现

### 4.1 本地快速规则（`lib/rules.js`，纯函数、零依赖）
输出 `{mode, confidence:'high'|'medium'|'low', score, reasons[]}`。

**明确 PTC（high）** — 任一命中即 PTC：
- 批量/全量/逐个/逐一/遍历/每一个/每个文件/所有文件/批处理/batch/bulk/for each/every file/iterate/loop over
- 并行/并发/同时执行/parallel/concurrently/in parallel
- 大量循环、循环 N 次、跑 N 遍、重复执行
- 批处理、批量发评论、批量提交、批量发送、批量创建/更新
- 脚本化/流水线/编排/pipeline/automation/orchestrat
- 全仓/全库/全项目/codebase/whole repo/entire repo + 动作
- 数据加工强信号：解析 N 个文件/统计汇总/合并去重/批量转换

**明确 standard（high）** — 任一命中即 standard：
- 单个简单问答：短文本 + 疑问词（什么/为什么/怎么/如何/多少/哪个/是否/what/why/how/explain）
- 寒暄：你好/谢谢/ok/hi/thanks 等
- 单动作：帮我看下 X / 读一下 X / 打开 X（且无批量信号）
- 解释型：解释/说明/介绍一下/有什么区别

**minimal（medium）**：明确要求最小/极简/minimal，或「只跑一条命令」。

**其余 → low**（交给模型）。

### 4.2 模型慢速判定（`lib/classifier.js`）
- 一次 `ctx.llm.stream(...)` 调用，`temperature:0`，`maxTokens` 约 256，带超时。
- provider/model 解析顺序：插件配置 → 会话 `session.requestHeader()` → `agentDefaultModel` →
  `ctx.llm.listProviders()[0]`；model 兜底 `deepseek-v4-flash`。
- 提示词要求**只输出 JSON**：`{"mode":"standard|ptc|minimal","reason":"...","confidence":0..1}`。
- 解析容错：剥 ```json 围栏、抓第一个 `{...}`、非法值回落 `defaultMode`。
- 失败（超时/异常/不可解析）→ 返回 `{ok:false}`，上层走兜底。

### 4.3 PTC 可用性
- `ctx.get('ptcRuntime') === undefined` → ptc 不可用，降级 standard 并在状态里说明。
- `PtcExecutor` 通过 lazy `import('@deepseek-ai/dsh-tool-executor-ptc')` 获取；
  失败则同样降级 standard（记 warn），**绝不抛到会话**。

## 5. 落地机制（`lib/router.js` + `lib/index.js`）

### 5.1 每个 agent 的状态（WeakMap）
```
{
  mode, source: 'default'|'auto-local'|'auto-model'|'user'|'continue',
  sticky,              // 用户显式偏好 {mode} 或 null
  lastDecision,        // {mode, reason, confidence, at}
  appliedMode,         // 当前真正落地的 executor 模式
  toolCtx,             // agent scope 内 inject 的子 ctx
  disposeExecutor,     // setExecutor 的 disposer
  disposeRestrict,     // tools.restrict 的 disposer（minimal）
  ready, setup,        // 幂等初始化
  pending,             // 正在判定的 promise（防并发）
}
```

### 5.2 应用一个模式（同步优先）
`applyMode(agent, mode)`：
1. 确保 `prepare(agent)` 完成（拿到 `toolCtx`）。
2. 若 `mode === 'ptc'` 且 ptc 不可用 → 降级 `standard`。
3. 若目标 executor 与当前相同 → 只更新状态，不重建（避免 KV cache 抖动）。
4. 否则：dispose 旧的 → 声明新的 → emit `tools/change`。
5. `minimal`：native executor + `tools.restrict({allow: minimalAllowlist})`。

### 5.3 每轮入口
- `agent/inbox/inserted`（source.kind === 'user'）：
  - 解析用户显式模式 → 粘性；否则若 `isContinuation(text)` → 沿用；否则 `route(agent, text)`。
  - **全同步**：本地规则高置信直接应用；否则用本地倾向或 `defaultMode` 落地，
    保证本轮一定有可用 executor。模型慢判在后台进行，结论作用于**下一轮**（原因见 §9.2）。
- `agent/pre-step`：安全网，若本轮尚未判定则补判（同一 turn 只判一次）。
- `agent/created`：读取最近实质任务文本做首次判定。
- `agent/disposed`：清理 WeakMap。

### 5.4 状态可见性
- 系统提示注入一小段：当前模式 + 可切换提示（`ctx.systemPrompt.section`，order 取
  `PLAN_POLICY` 之前，name `turn-preset-router:mode`）。
- `/mode` 命令：查看状态、`/mode standard|ptc|minimal|auto` 手动指定/恢复自动。
- `/mode` 无参输出：当前模式、来源、粘性、最近判定原因、ptc 是否可用。

## 6. 配置（全部可选，`cordis.patch.yml` 注释逐项说明）
| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `defaultMode` | `'standard'` | 无法判定/失败时使用 |
| `model` | `'deepseek-v4-flash'` | 慢速判定模型 |
| `provider` | `''` | 空=自动解析 |
| `modelEnabled` | `true` | 是否启用慢判（结论作用于下一轮；见 §9.2） |
| `modelMaxTokens` | `256` | 慢判输出上限 |
| `modelTemperature` | `0` | 慢判采样温度 |
| `modelTimeoutMs` | `8000` | 慢判超时 |
| `minimalAllowlist` | `['bash','read_file','write_file','edit_file']` | minimal 模式允许的工具 |
| `applyToSubagents` | `false` | 是否接管子 agent |
| `guidance` | `true` | 是否注入模式提示段 |
| `extraPtc` / `extraStandard` | `[]` | 追加关键词 |
| `sticky` | `true` | 是否启用用户显式指定粘性 |

## 7. 交付物与目录
```
dsh-turn-preset-router/
├── package.json          # dsh.bundle.patch + engines.dsh
├── cordis.patch.yml      # bundle patch（insert 一行 + 默认配置注释）
├── lib/
│   ├── index.js          # Host 插件入口：事件、/mode、状态
│   ├── rules.js          # 本地快速规则（纯函数）
│   ├── classifier.js     # 模型慢判（llm.stream + 解析）
│   ├── router.js         # 状态机 + executor/restrict 落地
│   ├── config.js         # 配置规范化
│   └── messages.js       # 文本抽取、isContinuation、显式模式解析
├── locale/{zh,en}.json   # 插件页标题/描述
├── icon.svg
├── bin/classify.mjs      # 离线分类 CLI（调试用）
├── test/*.test.mjs       # node:test 单测
├── dev/                  # 真实服务 harness + overlay patch
├── docs/DESIGN.md        # 本文件
├── README.md / README.zh.md
└── LICENSE
```

## 8. 验收标准
1. `node --test test/*.test.mjs` 全绿（规则、续写、显式模式、配置、状态机）。
2. `node bin/classify.mjs "遍历所有文件统计行数"` 输出 ptc；`"解释一下这个函数"` 输出 standard。
3. dev harness 能在真实 `SystemPrompt`/`ToolsService`/`PtcExecutor` 上挂载，
   并断言：批量任务 → 工具表变 `['run_code']`；短问答 → 恢复 native 工具表；
   用户显式 `/mode ptc` 后「继续」仍保持 ptc。
4. `package.json` 的 `engines.dsh` 与 `dsh.bundle.patch` 正确，`cordis.patch.yml` 可被 loader 解析。
5. 无 `@deepseek-ai/*` 静态 import 出现在会被 profile 直接加载的路径（lazy 除外）。

---

## 9. Lead 实施后修正（以此为准，覆盖前文冲突处）

实施与实测后，以下三条修正了 §3/§4.2/§5 的初稿假设。**这些是硬事实，不要改回。**

### 9.1 每轮路径必须完全同步
`preStep` 的顺序是：`inbox.claim()` → `tools.resolve()` → `systemPrompt.assemble()` → **然后才** 跑
`agent/pre-step` waterfall。也就是说：

- `agent/pre-step` 触发时，本 step 的工具目录**已经固定**，在那里换 executor 只对下一轮生效。
- `agent/inbox/inserted` 是唯一窗口：它在 `inbox.mutate()` 里**同步** emit，早于 `wakeDriver()`。
- cordis 的 `emit` **不 await** 异步 listener。因此 `inbox/inserted` 的 handler 里任何 `await`
  都会让切换落到本 step 之后 —— 即静默晚一轮。

**结论**：`lib/router.js` 的 `route` / `applyModeSync` / `handleUserMessage` 全部同步，零 await。
准备工作（`prepare` 拿 agent 子 ctx、`warmUp` 预 import `PtcExecutor`）必须在轮次之外完成。

### 9.2 模型判定不能决定它自己那一轮
由 9.1 推出：异步的模型调用必然在该轮 assemble 之后才返回。所以模型判定只能**改进下一轮**。

- 本轮：由本地规则决定（高置信直接定；否则用本地倾向或 `defaultMode` 落地，保证有可用 executor）。
- 下一轮：`refine()` 在后台拿到模型结论后切换。
- 配置项因此从 `blockOnModel` 改为 **`modelEnabled`**（是否启用慢判）。`blockOnModel` 已删除，
  因为它在 DSH 的组装顺序下无法实现。

### 9.3 `ptcRuntime` 不能放进 `inject`
cordis 的 `inject(['a','b'])` 只在**所有**服务都存在时才回调。`ptcRuntime` 是可选服务，
若放进 inject，未挂载 PTC 的部署会永远 prepare 不成功 → 整个插件失效。
正确做法：`inject(['tools','systemPrompt'])`，PTC 可用性用 `ctx.get('ptcRuntime')` 运行时判断，
`PtcExecutor` 构造失败时 catch 并降级 `standard`。

### 9.4 executor 切换必须「先建后拆」
若先 dispose 旧 executor 再 await/构造新的，中间会出现
`TOOL_EXECUTOR_UNAVAILABLE` 窗口，并发的 `assemble()` 会抛错。
正确顺序：**先构造好 nextExecutor，再 teardown，再 setExecutor**（同一 tick 内完成）。

### 9.5 回退 native 复用部署默认 executor
`tools.selectExecutor(undefined)` 拿到部署默认实例并复用，不要 `new NativeToolExecutor`。

### 9.6 minimal 与 standard 的差异是 restriction，不是 executor
两者用同一个默认 executor，只差 `tools.restrict({allow})`。
因此 `appliedMode` 必须记录 **mode**（`minimal` / `standard`），不能只记录 executor 类型，
否则 `minimal → standard` 不会被识别，allowlist 会永久残留。

### 9.7 本地规则的三个实测修正
§4.1 的初稿规则在实测中被发现三处偏差，已修正（`lib/rules.js`）：

1. **「单个动作」动词不得吃掉强 PTC 信号。**
   `run these in parallel` 曾被判为 standard/low：`+3 并行` 被 `-2 单个动作` 与 `-1 短指令` 抵消。
   修正：单动作正则加负向前瞻——同句含 并行|并发|同时执行|同时处理|parallel|concurrently|
   in parallel|批量|batch|遍历|每个|所有文件|all files|each file 时不命中。

2. **短指令惩罚不得作用于已有强 PTC 信号的文本。**
   `run these in parallel`（20 字符）仍会被 `-1 短指令` 拉低到 medium。
   修正：`ptcScore >= 3` 时不再施加短指令惩罚。现在该类文本为 ptc/**high**，与 §4.1「明确 PTC → high」一致。
   保留短问答惩罚（`-3 短问答`）：疑问句即使短也确实是标准模式场景。

3. **minimal 关键词补齐。**
   §4.1 写了「或『只跑一条命令』」但实现漏了。修正后 `MINIMAL_RULE` 覆盖：
   `最小模式|极简模式|最少工具|minimal\s*(mode|toolset|模式)|only one tool|只要一个工具|
   只(需要?|需|要)?\s*(跑|执行|运行|用)\s*(一|1)\s*条?\s*命令|one command only|just (one|a single) command`。
   注意「用 minimal 模式」在 `parseExplicitMode` 里本就走显式指令路径，这里补的是本地规则层。

### 9.8 route() 返回契约（最终）
`route()` 返回：
```
{ mode, decidedMode, appliedMode, changed, fallback, deferred, source, reason, needsModel }
```
- **`mode`**：实际落地的模式（PTC 不可用时降级为 `standard`）。
- **`decidedMode`**：路由器判定（可能为 `ptc`）。
- **`appliedMode`**：`deferred` 时为 `undefined`。
- **`fallback`**：部署无法兑现判定（无 PTC 运行时 / 作用域未就绪）。
- **`deferred`**：本轮未能落地（作用域未 prepare），状态已记录但不生效。
- **`needsModel`**：本地拿不准，值得后台慢判。
- `inspect().lastDecision.mode` 记录**判定**，与 `route().mode`（落地）可不同，二者都需可见。

`createRouter` 恰好返回 14 个方法；`recoverSticky` 为内部函数，不对外暴露。

### 9.9 模型判定必须「停泊」，不能中途落地（严重缺陷修正）
harness-author 实测发现一个**静默破坏会话**的缺陷，已修：

**现象**：`refine()` 拿到模型结论后**立刻** `applyModeSync`。而慢判（通常 <1s）几乎必然发生在主模型
streaming（数秒）期间，于是改动落进**当前 step**。

**根因**：`ToolsService.execute()` 是 `selectExecutor(input.agent)` —— **dispatch 时**按作用域重新选
executor，**不复用**该 step 组装时的 toolSet。所以中途换 executor 后，本 step 用「模型看到的
catalog」去 dispatch 到「已经换掉的 executor」：
- catalog=native（demo/bash），verdict=ptc 中途落地 → `UNKNOWN_TOOL: only run_code is callable directly`
- catalog=run_code，verdict=standard 中途落地 → `UNKNOWN_TOOL: unknown tool "run_code"`
两个方向都会让该 step 的 tool call 全部失败，且 router 自己不打 warn（静默坏一轮）。

**修正**：`refine()` 不再落地，只把结论存进 `state.pendingMode`；
在**下一次** `agent/inbox/inserted` 的最开始（即下一轮 `tools.resolve()` 之前）由内部
`consumePendingMode()` 消费。`consumePendingMode` 不对外暴露，`createRouter` 仍是 14 个方法。

**回归**：`dev/midstep-verdict-regression.mjs`（4 个 case：双向不中途换 + 下一轮消费 +
one-shot + 新任务重新路由）、`dev/plugin-mount-harness.mjs` scenario 6/9（断言「verdict 不改变
本 step 作用域」+「下一轮消费」+「被显式模式覆盖时丢弃」）、`dev/prestep-harness.mjs` 场景 2/4
（pre-step 只 park + 全程无 TOOL_EXECUTOR_UNAVAILABLE 窗口）。

> 注：最初的复现脚本 `dev/midstep-hazard-repro.mjs` 已在缺陷修复后转成上面的
> `dev/midstep-verdict-regression.mjs` 并删除，避免仓库里留一个断言「缺陷存在」的文件。

### 9.10 其它两处健壮性修正
1. **minimal allowlist 过滤到已知工具。** `tools.restrict()` 遇到本部署不存在的工具名会整体抛错，
   原先 catch 后**静默不施加限制**，于是 `/mode minimal` 报告成功但实际仍是全量工具。
   修正：先用 `tools.view(scope).restrictableNames` 过滤 allowlist，只保留已知工具并 warn 缺失项；
   若过滤后为空则 warn 并标记 `minimalDegraded`，不再假装成功。
2. **presentation-harness 增加 skip 逻辑。** 若部署默认 executor 不是 `NativeToolExecutor`
   （profile 把 PTC 设为默认），native↔ptc 往返会退化成 ptc↔ptc 空操作，所有断言都会假阳性通过。
   现在探测到非 native 默认时打印 SKIP 并 exit 2。

### 9.11 pre-step 安全网也必须「只停泊、不换 executor」
§9.1 原写「pre-step 触发时本 step 工具目录已固定，在那里换 executor 只对下一轮生效」——
harness-author 的 FINDINGS §2 指出这句话**只对 catalog 成立，对 dispatch 不成立**：

- pre-step 换 executor 后，本 step 的 `assemble()` 结果确实不变（catalog 已固定）；
- 但本 step 的 `tools.execute()` 在 dispatch 时按作用域重选 executor，于是**本 step 的 tool call
  仍然全部 `UNKNOWN_TOOL`**。

即安全网不是「只影响下一轮」，而是「破坏它正在兜底的那一轮」。

**修正**：`handlePreStep` 不再调用 `applyModeSync` / `route`，只把判定写入
`state.pendingMode`（无历史时写 `defaultMode`）；真正落地由下一次 `agent/inbox/inserted` 的
`consumePendingMode()` 完成（在 `tools.resolve()` 之前）。这样 pre-step 既完成兜底记录，
又不会让本 step dispatch 失败。

**结论**：整个插件里，**只有 `agent/inbox/inserted` 这一个同步窗口可以改 executor**。
任何其他时机（pre-step、后台慢判返回、agent/created 之外的异步回调）都只能「记录意图」，
落地必须等到下一次 inbox。

### 9.12 dev overlay patch 必须区分「覆盖」与「插入」
harness-author 提醒的 `dev.patch.yml` 疑虑成立，已实测确认 `applyPatches` 的两条语义：

1. **`insert` 永远追加。** 即使 `insert` 里复用了已存在的 id，也是 `data.push(...)`（或
   `target.config.push(...)`），**不去重**。在已安装 bundle 的 profile 上用 insert overlay
   会挂上**两个 router**，争抢同一批 agent 作用域。
2. **非 insert patch 里 `name` 是守卫。** 源码为
   `if (name && name !== target.name) { warn(...); continue }` —— 名字不符会**整条跳过**。
   因此覆盖式 patch 不能靠 `name` 指向检出路径；已安装行的 name 是包名，覆盖 patch 必须省略 `name`。

结论：loader 无法用一条 patch 把「已安装 bundle」替换成「检出路径」。因此拆成两个文件：
- `dev/dev.patch.yml` — 覆盖式（无 insert、无 name），只改 config；用于已安装 profile。
- `dev/dev.insert.patch.yml` — insert 式（name 指向 `../lib/index.js`）；用于未安装的 profile。
两个文件顶部都写清了适用场景与误用后果。

### 9.13 真实进程验证（`dev/run-real.sh` + `docs/LOCAL-VERIFY.md`）
harness 用真实核心服务，但不驱动真实 agent loop。补一层真实进程验证：隔离 `DSH_HOME` 下启动
真的 `dsh`（`dsh-base` + `dsh-headless` + 一个模型路由），挂本检出插件跑真实会话。

已验证（详见 `docs/LOCAL-VERIFY.md`）：
- 插件加载无告警；`--dump-config` 中 `name` 正确解析为绝对 `file://` 路径。
- 真实会话里模型复述了插件写入的「当前执行模式」→ `guidance` 段落确实进入模型上下文。
- `/mode` 对真实 agent 可见（与 compact/feedback/goal/permission/plan 并列），四个分支返回预期文案。
- 逐轮 `assemble()` 工具目录与 `selectExecutor()` 类型真实变化，粘性 + 「继续」成立。

两个环境限制（非插件问题）：
1. **headless runner 不解析 slash 命令。** `dsh --profile headless "/mode"` 把 `/mode` 当普通用户
   消息。这是 `dsh-headless` 的设计（`config.task` 直接作为用户消息）。GUI/Web 输入框走
   `commands.execute()`，`/mode` 正常。
2. **`ptcRuntime` 默认未挂载。** `dsh-base` 里 `tool-executor-ptc` 是 `disabled: true`；未挂载的
   部署按 §4.3 降级 `standard`，这是设计行为。

### 9.14 真实安装后 PTC 静默降级（严重缺陷修正）
装上 GitHub/npm 版后在真实会话里复现：批量任务**判定正确为 ptc**，但实际跑成 standard，
21 次工具调用全是 `bash`。

**证据链**（来自真实会话日志 `session-a5d585fe`）：

| 观察 | 含义 |
|---|---|
| `/mode` 输出 `最近判定：+3 批量/逐项处理，+2 数据加工` | 判定正确 = ptc |
| 21 次 tool/call 全是 `bash` | 落地是 native |
| `/mode` 显示 `模式：标准` + `来源：本地规则` | `applyModeSync` 返回 `fallback: true` |

**根因（两层）**：

1. **`ptcRuntime` 在 `apply()` 时尚未挂载。** bundle row 先于兄弟服务激活，插件加载瞬间
   `ctx.get('ptcRuntime') === undefined`。原 `warmUp()` 见到 false 就直接 return，
   `ptcExecutorClass` 永远是 undefined → 每次 ptc 都降级。
   实测：`ptcRuntime at apply: MISSING` → `at agent/created: PRESENT`。
2. **`ptcClassResolved` 提前置位。** 原实现在 import 之前就把它设为 true，即使失败也永不重试，
   连 `/mode ptc` 也无法恢复。

**修正**：
- `warmUp()` 不再在 `ptcRuntime` 缺失时退出，而是**有界等待**（40 × 100ms = 4s）服务挂载后再 import。
- 移除 `ptcClassResolved` 提前置位；改用 `ptcWarmUp` 共享在途 Promise，失败不锁死，可重试。
- `PTC_SPECIFIERS` 列表化，为将来多路径解析留位。

**验证**：在镜像真实 desktop 组合的 profile 上，`applyModeSync('ptc')` 返回
`{"mode":"ptc","fallback":false}`，executor 变为 `PtcExecutor`。

**为什么开发期没发现**：dev harness 里 `dev/node_modules` 软链到了 DSH 完整 node_modules，
`ptcRuntime` 与 executor 包都立即可见，掩盖了「服务晚于插件激活」这个真实时序。
**教训**：涉及服务可用性的逻辑，harness 必须模拟「服务晚到」，不能只测「服务已就绪」。
