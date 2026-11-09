# 真实进程验证记录

验证目标：不是 harness 级的「真实核心服务」，而是**真实 `dsh` 进程 + 真实模型**下的端到端可用性。
环境：DSH `0.2.2-rc.1`，macOS arm64，Node 24.21.0。

## 结论

插件在真实 DSH 里**可用**：加载无报错、`/mode` 命令对用户可见且可执行、自动判定按预期切换
executor、`guidance` 提示段落被模型读到、粘性偏好与「继续」语义正确。

## 验证方法（隔离，不影响任何现有 profile）

用工作区内的独立 `DSH_HOME`，只装 `dsh-base` + `dsh-headless`，完全不碰 `~/.dsh/profiles/*`：

```sh
# 仓库根目录下执行
export DEEPSEEK_API_KEY=...        # 验证 run 需要模型凭据
./dev/run-real.sh "你好，请只回复 OK"
# -> OK
```

`dev/run-real.sh` 会：

1. 在工作区建 `.dsh-verify-home/profiles/verify/`（已被 `.gitignore` 忽略）；
2. 拷入 `dev/verify-profile/` 的 profile 模板（`dsh-base` + `dsh-headless`）；
3. 用 `dev/verify-profile/model.patch.yml` 指定模型路由（默认 DSH 自带的 `deepseek-official`）；
4. 用 `--patch` 叠加本检出插件（`dev/dev.insert.patch.yml`）。

> 为什么不能只用 `--dump-config`：它只能证明**组装**正确，证明不了 `inject` 回调、命令注册、
> executor 切换这些**运行期**行为。所以真正 boot 了一次。

## 逐项验证结果

### 1. 组装（`--dump-config`）

插件行正确进入组装树，`name` 解析为绝对 `file://` 路径：

```yaml
- id: dsh-turn-preset-router
  name: file:///path/to/dsh-turn-preset-router/lib/index.js
  config: { enabled: true, defaultMode: standard, modelEnabled: false, guidance: true, sticky: true }
```

### 2. 真实会话对话

```
$ ./dev/run-real.sh "请用一句话说明你当前看到的工具模式是什么"
我当前看到的工具模式是**标准模式（原生函数调用）**，也就是说，我会直接通过原生的函数调用接口，
来调用 bash、read、edit、grep 等工具。
```

→ 说明 `guidance` 段落确实进入了模型上下文（模型复述了插件写入的「当前执行模式」文案）。

### 3. `/mode` 命令（真实 agent 作用域）

`commands.list(agent)` 可见 `mode`（与 `compact`/`feedback`/`goal`/`permission`/`plan` 并列），
四个分支都返回预期结果：

| 输入 | 返回 |
|---|---|
| `/mode` | `模式：标准（原生函数调用）\n来源：默认\n自动判定：开启` |
| `/mode ptc` | `已切换到PTC（run_code 程序化调用），从本轮生效。` |
| `/mode minimal` | `已切换到最小（极简工具集），从本轮生效。` |
| `/mode auto` | `已恢复自动判定：标准（原生函数调用）\n判定依据：本地规则（拿不准）：无明显信号` |

### 4. 自动判定 + 真实 executor 切换

真实 agent 作用域上，`assemble()` 的工具目录与 `selectExecutor()` 的类型逐轮变化：

| 轮次 | 工具目录 | executor |
|---|---|---|
| 启动（bootstrap） | 全部原生工具 | `NativeToolExecutor` |
| 批量遍历任务 | `["run_code"]` | `PtcExecutor` |
| 短问答 | 全部原生工具 | `NativeToolExecutor` |
| 显式 `/mode ptc` | `["run_code"]` | `PtcExecutor` |
| 续写「继续」 | `["run_code"]` | `PtcExecutor` |
| 新任务（粘性生效） | `["run_code"]` | `PtcExecutor` |
| `/mode auto` | 全部原生工具 | `NativeToolExecutor` |

### 5. 启动无插件告警

boot 全程无 `turn-preset-router` 相关 warn/error。

## 已知环境限制（非插件问题）

1. **headless runner 不解析 slash 命令。** `dsh --profile headless "/mode"` 会把 `/mode` 当作普通
   用户消息发给模型。这是 `dsh-headless` 的设计（`config.task` 直接作为用户消息），不是插件缺陷。
   真实 GUI/Web 输入框走 `commands.execute()` 路径，`/mode` 正常。验证时通过直接调用
   `commands.execute(agent, '/mode', [], signal)` 覆盖了这条路径。
2. **`ptcRuntime` 默认未挂载。** `dsh-base` 里 `tool-executor-ptc` 是 `disabled: true`，
   需部署自己挂 `@deepseek-ai/dsh-ptc-runtime-node`。验证用的 profile 通过 base 挂上了它，
   所以 PTC 切换真实生效；未挂载的部署会按设计降级 `standard`。
3. **文件沙箱。** 若在受限沙箱里跑，`~/.dsh` 可能不可写；`dev/run-real.sh` 因此把 `DSH_HOME`
   指向工作区内的 `.dsh-verify-home`。

## 复现步骤

```sh
cd dsh-turn-preset-router
export DEEPSEEK_API_KEY=...        # 或改 dev/verify-profile/model.patch.yml 指向你自己的路由
./dev/run-real.sh "你好，请只回复 OK"
```

验证会在工作区留下 `.dsh-verify-home/`（含会话日志），已被 `.gitignore` 忽略，可随时删除。
