# dev/ — 开发与集成验证

这里的两个 harness 在**真实 DSH 核心服务**上验证本插件的主机制，不 mock 关键路径：
真实的 `ToolsService`、真实的 `SystemPrompt` 组装、真实的 `PtcExecutor` 换入换出。
被 fake 的只有 PTC 运行时（真正执行程序的沙箱）和 inbox/驱动器（属于活跃会话）。

## 前置：让 `@deepseek-ai/*` 可解析

profile 插件在**运行期**由 Harness 的 runtime resolver 供给核心包，所以插件源码里不要静态 import
它们。但 dev harness 是直接 `node` 跑的普通脚本，需要自己提供一个可解析的 `node_modules`。

本机 DSH 的核心包已解包在 `/tmp/asar-extract/dsh/node_modules`：

```sh
cd dev
ln -sfn /tmp/asar-extract/dsh/node_modules node_modules
```

插件根目录也需要同样的软链，因为 `lib/router.js` 会 **lazy dynamic import**
`@deepseek-ai/dsh-tool-executor-ptc`：

```sh
cd ..            # 插件根目录
ln -sfn /tmp/asar-extract/dsh/node_modules node_modules
```

### 若 `/tmp/asar-extract` 不存在

从已安装的 DSH 应用里解包 `app.asar`：

```sh
# 装一个解包工具（一次性）
npm install --prefix /tmp/asartool @electron/asar

# 解包（约 25000 个文件，需要一点时间）
/tmp/asartool/node_modules/.bin/asar extract \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
  /tmp/asar-extract
```

解包后核心包在 `/tmp/asar-extract/dsh/node_modules/@deepseek-ai/`，再执行上面的软链步骤。

## Node

用 Harness 自带的 Node，版本与本机 DSH 一致（24.x）。它位于 DSH 运行时目录下，例如：

```sh
# macOS 安装的 DSH 运行时；按你的实际安装位置调整
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
```

也可以用 PATH 上的任意 Node 24+。

## 跑

```sh
# 完整集成验证：9 个场景 / 25 条断言
$NODE dev/plugin-mount-harness.mjs

# 最小往返 spike：native → ptc → native 连续 3 轮
$NODE dev/presentation-harness.mjs

# 驱动器顺序验证：pre-step 安全网只 park，下一轮才消费
$NODE dev/prestep-harness.mjs

# 慢判时序回归：模型结论不得落进产生它的那一轮
$NODE dev/midstep-verdict-regression.mjs
```

四个脚本都在失败时以非 0 退出，可直接用于 CI。
`presentation-harness.mjs` 在「部署默认 executor 不是 native」的组合下会打印 `SKIP` 并以
**exit 2** 退出（不是失败），因为那种组合下 native↔ptc 往返无法被证明。

## 真实 dsh 进程验证（`run-real.sh`）

harness 用的是真实核心服务，但没驱动真实 agent loop。`dev/run-real.sh` 补这一层：启动**真的
`dsh` 进程**、跑**真的会话**、连**真的模型**，全程不碰 `~/.dsh`（在工作区建一次性 `DSH_HOME`）。

```sh
./dev/run-real.sh "你好，请只回复 OK"
```

它做的事：把 `dev/verify-profile/` 拷成隔离 profile（只含 `dsh-base` + `dsh-headless`），
用 `dev/verify-profile/model.patch.yml` 里配置的模型路由（默认是 DSH 自带的 DeepSeek provider，
需要 `DEEPSEEK_API_KEY`），再用 `--patch` 叠加本检出插件。已验证结果见
[docs/LOCAL-VERIFY.md](../docs/LOCAL-VERIFY.md)，包括：

- 真实会话里模型复述了插件写入的「当前执行模式」→ guidance 段落确实生效；
- `/mode` 对真实 agent 可见，`/mode` / `/mode ptc` / `/mode minimal` / `/mode auto` 四个分支
  都返回预期文案；
- 逐轮 `assemble()` 工具目录与 `selectExecutor()` 类型真实变化：
  批量任务 → `["run_code"]` + `PtcExecutor`，短问答 → 25 个原生工具 + `NativeToolExecutor`；
- 粘性 + 「继续」在真实会话里同样成立。

> 注意 `dsh --profile headless "/mode"` 不会走命令解析（headless runner 把 task 直接当用户消息），
> 这是 `dsh-headless` 的设计，不是插件问题。GUI/Web 输入框走 `commands.execute()`，`/mode` 正常。

## 开发期 overlay patch（两个文件，别用错）

| 文件 | 用于 | 形式 |
|---|---|---|
| `dev/dev.patch.yml` | profile 里**已安装**本插件 bundle，只想改 config 或指向本检出 | 覆盖式 patch（无 `insert`） |
| `dev/dev.insert.patch.yml` | profile 里**没有**安装本插件，纯粹从检出加载 | `insert` 式 |

两条 loader 事实决定了这个拆分：

1. **`insert` 永远追加。** `applyPatches` 即使看到 `insert` 里复用了已存在的 id，也是
   `data.push(...)` / `target.config.push(...)`，**不会**去重。所以在已安装的 profile 上用
   `insert` overlay 会挂上**两个 router 实例**，两者争抢同一批 agent 作用域。
2. **非 insert patch 里 `name` 是守卫，不是字段。** 源码里 `name && name !== target.name` 会
   `warn(...); continue` —— 整个 patch 被跳过。已安装行的 name 是 `dsh-turn-preset-router`，
   所以 `dev.patch.yml` 干脆不写 `name`（写 `../lib/index.js` 会让整条 patch 静默失效）。

所以「用检出代码替换已安装 bundle」这件事，loader **不支持**用一条 patch 做到：要么先卸掉
bundle 再用 `dev.insert.patch.yml`，要么接受已安装包被使用、只用 `dev.patch.yml` 调 config。
开发期建议后者 —— 改完 `lib/` 后重载即可，因为 `dev.insert.patch.yml` 里的 `name` 才指向检出。

一条命令跑全部（含单测）：`npm run verify`。

## 这四个 harness 在验证什么

### `plugin-mount-harness.mjs`

覆盖 9 个场景：

1. 批量任务在**同一个 tick 内**把工具表切成 `['run_code']`。
2. 短问答切回原生工具表。
3. 显式 `/mode ptc` 生效且粘性；「继续」保持；新问题仍保持；`/mode auto` 恢复自动。
4. `minimal` 收窄到 allowlist，`standard` 撤销收窄。
5. 未挂载 `ptcRuntime` 的部署：批量任务保持原生，`/mode ptc` 降级而不抛错。
6. 模糊文本先按本地倾向落地；模型结论返回时**不改变当前作用域**（parked），下一轮才消费。
7. 部署的全局视图（无 agent 的 `assemble()`）未被污染：完整工具列表不变、
   `selectExecutor(undefined)` 实例恒等、global guidance 段落渲染为空串。
8. native → ptc → native 连续 3 轮，不出现 `TOOL_EXECUTOR_UNAVAILABLE`。
9. parked verdict 只影响下一轮：到达时不改作用域、显式 `/mode` 优先、被取代时丢弃。

### `prestep-harness.mjs`

`plugin-mount-harness.mjs` 证明的是 inbox 路径（唯一能改变**本轮**的窗口）；
这个文件覆盖契约的另一半，只有忠实复现驱动器顺序才能证明：

```
inbox.claim() → tools.resolve() → systemPrompt.assemble() → agent/pre-step waterfall
```

所以安全网运行时，本 step 的工具准入与模型可见目录**已经固定**。而
`ToolsService.execute()` 是 dispatch 时按作用域**重新选** executor 的，不复用该 step 的
`toolSet` —— 因此在 pre-step 里换 executor 会破坏**当前 step** 的 dispatch，不是「只影响下一轮」。

结论：安全网**只能记录决策，不能换 executor**。它把决策 park 起来，由**下一次**
`agent/inbox/inserted` 消费。覆盖 5 个场景：

1. inbox 已路由时 pre-step 是 no-op（不重复 emit `tools/change`）。
2. inbox 漏掉时 pre-step 记录决策：本 step 的 executor **不变**、不 emit `tools/change`；
   下一轮 inbox 消费后变 `run_code`（核心断言）。
3. 安全网每轮最多记录一次（同一 turn 的第二个 step 不重复）。
4. 切换过程中没有「无 executor」窗口（每个 microtask 采样都能 select 到 executor）。
5. 无历史时记录 `defaultMode`，同样由下一轮消费。

它用真实的 `ToolsService` / `SystemPrompt` / executor 类，并通过 `agentCarrier()` 与
`assembleContextFor()` 构造 agent 载体，因此监听器过滤与 `assemble.agent` 的行为与真实会话一致。

### `presentation-harness.mjs`

只验证一件事：agent 作用域的 executor 可以在「部署默认」与「PTC」之间反复同步互换，
且**任何时刻都不会出现没有 executor 的窗口**。DSH 升级若破坏了这条性质，这里会最先失败。

它先探测 `selectExecutor(undefined).constructor.name`。如果部署默认本身就不是
`NativeToolExecutor`（例如 profile 把 `tool-executor-ptc` 设为非 disabled），
那么「切回部署默认」看到的是 `run_code` 而不是 native 工具表，往返断言会变成
ptc↔ptc 的假阳性 —— 此时脚本打印 `SKIP` 并 exit 2，而不是假装通过。

### `midstep-verdict-regression.mjs`

守卫一个**曾经真实存在**的缺陷：慢判结论落进了产生它的那一轮。

关键在于 DSH 的两件事不是同一个时刻决定的：

- 一轮的工具目录由 `preStep` 的 `tools.resolve()` + `assemble()` 固定；
- 但 `ToolsService.execute()` 是 `selectExecutor(input.agent)`，在 **dispatch 时**按作用域
  **重新选** executor，不复用该 step 的 `toolSet`。

所以只要在 step 进行中换 executor，本 step 就会拿「模型看到的 catalog」去 dispatch 到
「已经换掉的 executor」，双向都是 `UNKNOWN_TOOL`（native catalog + PTC executor，或反过来），
而且 router 不会打任何 warn —— 静默坏掉一轮。

模型慢判默认 8s 超时、通常不到 1s，主模型 streaming 要数秒，所以这不是边角情况，
而是**每个本地规则拿不准的轮次**都会踩到。DESIGN.md §9.2 因此规定：模型结论只能改进**下一轮**。

覆盖 4 个 case：

1. native catalog + verdict=ptc：中途**不换** executor，本 step 正常 dispatch；下一轮「继续」消费。
2. PTC catalog + verdict=standard：同上，反向验证。
3. parked verdict 只消费一次，且用户显式 `/mode` 优先。
4. 下一轮是新任务时按自身文本重判，不被 parked verdict 劫持。

## 为什么断言是「同步读」

`dev/plugin-mount-harness.mjs` 里的 `send()` 在 `root.emit('agent/inbox/inserted', …)` 之后
**不 await** 就直接读 `assemble()`。这不是偷懒，而是被测性质本身：

DSH 的 `preStep` 顺序是 `inbox.claim()` → `tools.resolve()` → `systemPrompt.assemble()`
→ **然后才** 跑 `agent/pre-step` waterfall。因此一轮的工具目录在 `pre-step` 之前就固定了。
唯一还能改到本轮的窗口，是 `agent/inbox/inserted` 的**同步** handler —— cordis 的 `emit`
不 await 异步 listener。插件因此在本轮路径上零 await。

如果你的改动让 `send()` 需要 `await` 才能看到新模式，那就意味着切换晚了一轮，属于回归。

## 已知限制

- harness 不驱动真实的 agent loop。`prestep-harness.mjs` 用真实的
  `tools.resolve()` / `assemble()` / `ctx.waterfall()` 按驱动顺序**手工编排**，
  因此覆盖了顺序语义，但不覆盖真实 inbox 唤醒与模型流式时序。
- `FakePtcRuntime` 不真正执行程序，只提供 `PtcExecutor` 渲染 SDK 所需的形状。
- `FakeLlm` 返回固定 JSON，用于验证「模型结论只改进后续轮次」的时序，不验证模型判断质量。
- `midstep-verdict-regression.mjs` 用固定延时（10ms 慢判 vs 400ms 主模型）制造时序，
  不是真实 provider 的延迟分布；它证明的是顺序契约，不是真实时序统计。
