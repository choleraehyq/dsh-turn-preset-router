# dev/ 集成验证审查结论

审查对象：`dev/` 下的 harness、`dev.patch.yml`、`dev/README.md`，以及 `lib/` 的落地实现。
本文记录审查中发现的问题与最终结论；Lead 已按本文修完 `lib/` 与部分 harness。

## 复跑结果（最终，全绿）

```sh
cd dsh-turn-preset-router
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"  # or any Node 24+

$NODE dev/plugin-mount-harness.mjs          # 25/25 checks passed   (9 场景)
$NODE dev/presentation-harness.mjs          # spike passed          (12 条)
$NODE dev/prestep-harness.mjs               # 30/30 checks passed   (5 场景)
$NODE dev/midstep-verdict-regression.mjs    # 26/26 checks passed   (4 case)
$NODE --test test/*.test.mjs                # 134/134 pass
```

全部 exit 0。

---

## 1. 已修复：`refine()` 的模型结论曾落进「当前 step」，导致该 step 的 tool call 全部失败

**严重级别：阻塞。这是本轮审查最有价值的发现。**

### 根因

DSH 里「一轮用什么工具目录」和「dispatch 时用哪个 executor」**不是同一个时刻决定的**：

1. `preStep` 顺序：`inbox.claim()` → `tools.resolve()` → `systemPrompt.assemble()` → **然后才**
   `agent/pre-step` waterfall。工具目录在 `assemble()` 时就固定。
2. 但 `ToolsService.execute()` 的实现是：
   ```js
   async execute(input) {
     return this.selectExecutor(input.agent).execute(input)   // dispatch 时按 scope 重新选
   }
   ```
   它**不复用** step 的 `toolSet` 里携带的 executor。

原实现里 `refine()` 拿到后台 verdict 后**立刻** `applyModeSync`。模型慢判默认 8s 超时、
通常 <1s，而主模型 streaming 要数秒 —— 于是 verdict 几乎必然落在同一 step 的
`assemble()` 之后、`tools.execute()` 之前。结果：本 step 用「模型看到的 catalog」去
dispatch 到「已经换掉的 executor」。

### 实测两个方向都失败

| 场景 | 模型看到的 catalog | dispatch 时 executor | 结果 |
|---|---|---|---|
| A：本地倾向 standard，模型判 ptc | `["bash","demo"]` | `PtcExecutor` | `UNKNOWN_TOOL: unknown tool "bash": only run_code is callable directly` |
| B：本地倾向 ptc，模型判 standard | `["run_code"]` | `NativeToolExecutor` | `UNKNOWN_TOOL: unknown tool "run_code"` |

两次 router 自己都**没有 warn**，是静默坏掉一轮。

### 影响面

`config.modelEnabled` 默认 `true`，任何本地规则**非 high 置信**的文本都会触发
（如「帮我看看这个」「写个脚本」）。这是默认开启路径上的缺陷，不是边角情况。

### 修复

- `refine()` 不再 `applyModeSync`，只把 verdict 存进 `state.pendingMode`；
- 新增内部 `consumePendingMode(agent)`，在下一次 `agent/inbox/inserted` 的**最开头**
  （`route()` 之前、`tools.resolve()` 之前）消费；
- 竞态处理：用户期间 pin 了模式（sticky）或已落地同模式，parked verdict 直接丢弃。

### 回归测试

`dev/midstep-verdict-regression.mjs`（新增，26 条断言，4 个 case）：

1. native catalog + verdict=ptc：中途**不换** executor，本 step 正常 dispatch；下一轮消费。
2. PTC catalog + verdict=standard：反向验证同上。
3. parked verdict 只消费一次，用户显式 `/mode` 优先。
4. 下一轮是新任务时按自身文本重判，不被 parked verdict 劫持。

---

## 2. 已澄清：`agent/pre-step` 安全网的真实边界

§9.1 原文是「pre-step 触发时本 step 工具目录已固定，在那里换 executor 只对下一轮生效」。
实测发现这句话**只对 catalog 成立，对 dispatch 不成立**：

- pre-step 换 executor 后，本 step 的 `assemble()` 结果确实不变（catalog 已固定）；
- 但本 step 的 `tools.execute()` 会在 dispatch 时选中**新的** executor，
  所以本 step 的 tool call 仍会 `UNKNOWN_TOOL`。

因此安全网如果换 executor，破坏的不是「下一轮」而是「当前轮」。当前 `handlePreStep` 的
实现是「若已有 appliedMode 就直接 return」，只在完全没路由过时兜底，因此实践上不会触发
这个窗口；`dev/prestep-harness.mjs` 的 scenario 2 断言了「catalog 不变」这一层，
并在注释里说明了 dispatch 层的限制。

---

## 3. 已修复：`presentation-harness.mjs` 在「部署默认就是 PTC」时会假阳性

把 root 挂成 `await root.plugin(PTC)`（等价于 profile 里 `tool-executor-ptc` 非 `disabled`）：

- `deploymentDefault.constructor.name === 'PtcExecutor'`；
- 基线 view 已经是 `['run_code']`；
- 每轮 `nativeView.includes('demo_tool')` **必然 FAIL**。

反向问题更值得注意：这种部署下 `setExecutor(deploymentDefault)` 切回去看到的还是
`run_code`，于是「往返成功」的断言证明不了 native↔ptc 能换，只证明了 ptc↔ptc —— 假阳性。
而 router 的 `standard` 模式恰好复用 `selectExecutor(undefined)`，所以这种部署下
`standard == ptc`，路由语义本身也退化。

**修复**：harness 先探测 `selectExecutor(undefined).constructor.name`；不是
`NativeToolExecutor` 就打印 `SKIP` + exit 2，明确说明「往返无法在本组合下证明」。

---

## 4. 已修复：`plugin-mount-harness.mjs` 两处断言偏弱

### 4.1 scenario 6 曾把缺陷当正确行为断言

原断言：模糊文本本轮落 native → 等 400ms → `assemble()` 变 `run_code`。
这只说明 verdict 生效了，**没有**说明它没有污染本轮 —— 而按 §1 它当时确实污染了。

**修复后**：断言 (a) 模糊文本先按本地倾向落地；(b) verdict 返回后**作用域没变**；
(c) 下一轮「继续」消费后变 `run_code`。

### 4.2 scenario 7 全局视图断言偏弱

原断言只有 `globalTools.includes('demo')`，查不出「全局 guidance 被写脏」或
「某个 tool 被从全局删掉」。

**修复后**补三条：global tools 完整列表、`selectExecutor(undefined)` **实例恒等**、
global guidance section 文本为空串。

---

## 5. 已修复：`minimal` 模式在 allowlist 含未知工具时静默降级

默认 `minimalAllowlist = ['bash','read_file','write_file','edit_file']`。若部署里没有
`read_file` 等工具，`tools.restrict()` 会**整体抛错**，原实现 catch 后不施加 restriction，
于是 `/mode minimal` 实际仍是全量工具，但命令仍回 `success: 已切换到最小`。

**修复**：`applyRestriction` 先用 `tools.view(scope).restrictableNames` 过滤 allowlist，
只保留部署真实存在的工具，缺失项 warn；过滤后为空则 warn + 标记 `minimalDegraded`。
实测：部署只有 bash+demo 时 `/mode minimal` → `["bash"]`。

---

## 6. 交付文件

| 文件 | 作用 | 状态 |
|---|---|---|
| `dev/plugin-mount-harness.mjs` | 端到端：inbox 同步切换、粘性、minimal、降级、parked verdict、全局视图 | 25/25 |
| `dev/presentation-harness.mjs` | executor 往返 spike（含非 native 部署的 SKIP 保护） | passed |
| `dev/prestep-harness.mjs` | pre-step 安全网专项：no-op / 兜底 / 每 turn 一次 / 无空窗 / defaultMode | 30/30 |
| `dev/midstep-verdict-regression.mjs` | §1 缺陷的回归测试（新语义） | 26/26 |
| `dev/dev.patch.yml` | 从检出加载 `../lib/index.js` 的 overlay | 可被 `loadOverlayPatches` 解析 |
| `dev/README.md` | 运行方式、软链、asar fallback、各 harness 验证什么、为什么「同步读」 | — |

`dev.patch.yml` 已用真实的 `loadOverlayPatches('dsh', …)` 验证可解析，`name` 正确解析为
`file:///Users/.../lib/index.js`，配置项为 `modelEnabled`（`blockOnModel` 已不存在）。
