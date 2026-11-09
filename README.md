# dsh-turn-preset-router

English | [中文](README.zh.md)

**Picks the tool mode for every turn in DeepSeek Harness.** When a message arrives, local rules settle — synchronously, before the turn's first model request — whether this turn runs in `standard`, `ptc`, or `minimal`. When they are unsure, a background Flash verdict improves the next turn.

## Why

In DSH, an agent preset decides how tools are presented to the model. But a preset can only be chosen before the session starts: once the first turn begins, `agentPresets.select()` throws `agent-preset/locked`. So most sessions run in a single tool shape from beginning to end.

Real conversations don't work that way. You batch-edit a pile of files, then ask "why did that one fail?" — or ask a quick question, then ask for a sweep over the whole repository. Forcing one shape onto every turn either burns context on short Q&A or makes the model hand-write loops during batch work.

This plugin adds the per-turn layer:

- **Decided per turn, applied synchronously** — after the user message lands and before the driver assembles the step, so the turn's tool catalog is already switched.
- **Local first** — high-confidence rules answer without a model call; a Flash call runs in the background only when the local rules are unsure.
- **Explicit choices win** — say "use ptc" or run `/mode ptc` and it sticks until you change it.
- **"Continue" doesn't re-route** — short continuations inherit the previous turn instead of interrupting the task in flight.
- **Graceful fallback** — stays in `standard` when no PTC runtime is mounted, and never throws into the session.

"Preset" in the name is the preset behaviour you want for that turn. This DSH version cannot swap the preset bundle itself; what actually varies per turn is the tool executor and the system-prompt section, and that is the part this plugin owns.

The three modes:

| Mode | The model sees | Applied as |
|---|---|---|
| `standard` | every tool as a JSON Schema (native function calling) | the deployment's default executor (native) |
| `ptc` | one `run_code` plus a generated SDK (programmatic calls) | `PtcExecutor` |
| `minimal` | a narrowed set of tools (default `bash` / `read_file` / `write_file` / `edit_file`) | the default executor + `tools.restrict({ allow })` |

## Install

The plugin is a Host bundle: no build step, no runtime dependencies.

### Plugins page (recommended)

Open **Plugins**, install from GitHub (this repository) or from a local checkout, then enable `dsh-turn-preset-router`.

### CLI

```sh
dsh plugin --profile desktop add github:choleraehyq/dsh-turn-preset-router
```

Substitute your own profile name for `--profile`. Then enable `dsh-turn-preset-router` on the Plugins page — the page keeps the profile's bundle list in sync; the bare CLI command only installs the package.

### Development overlay

```sh
dsh --profile desktop --patch ./dev/dev.patch.yml
```

`dev/dev.patch.yml` loads `../lib/index.js` straight from this checkout, so edits apply on the next boot or reload without installing anything into the profile.

## Usage

### Automatic

Nothing to do. After each user message is appended, `agent/inbox/inserted` fires synchronously — after the message lands, before the driver wakes and assembles the step. Explicit mode instructions and the local rules are both handled inside that synchronous handler, so the switch applies to the current turn. Only the background model refinement is asynchronous. `agent/pre-step` is a safety net: by the time it runs the step's tool catalog is already fixed, so it only covers agents the inbox path missed and prepares later turns. A new session is routed once from its most recent substantive user message.

Short replies like `继续`, `接着`, `然后呢`, or `ok` inherit the previous turn's mode: no re-classification, no model call.

### `/mode`

```text
/mode                  show the current mode, its source, stickiness, the last reason, and whether PTC is available
/mode standard         pin standard
/mode ptc              pin PTC
/mode minimal          pin the minimal tool set
/mode auto             clear stickiness and resume automatic routing
```

A manual choice sticks (disable with `sticky: false`) until `/mode auto` or another mode is named. "Continue" never changes it. A `/preset …` or `/router …` prefix in the message text is also read as an explicit mode instruction (it just does not print the `/mode` status block).

## How it decides

The current turn is decided strictly in order; the first match wins:

| # | Rule | What happens |
|---|---|---|
| 1 | Explicit user choice | A mode instruction in the text (`用ptc`, `切到 ptc`, `ptc模式`, `use ptc`, `switch to ptc`, `standard mode`, …) or a `/mode …` command takes effect immediately and is remembered as a sticky preference |
| 2 | Continuation | A short continuation (`继续` / `接着` / `然后呢` / `ok` / `go on` / `continue` …) inherits the previous turn — no re-classification, no model call |
| 3 | Local rules | A high-confidence rule decides the turn on the spot; no model call, saving time and money |
| 4 | Local lean / `defaultMode` | When the local rules are unsure, their lean lands; with no signal at all, `defaultMode` does. Either way the turn has a working executor |

If step 4 was taken and `modelEnabled` is `true`, the plugin asks a Flash model in the background and applies the verdict when it returns — **on the next turn**. It cannot affect the turn already in progress, and that is a property of DSH rather than a shortcut: `preStep` assembles the tool catalog before it runs the awaited `agent/pre-step` waterfall, and cordis `emit` does not await async listeners, so an asynchronous verdict can never land before its own turn.

### Local rules

- **Clearly ptc (high confidence):** batch / all / each / every file / all files; parallel / concurrent / at the same time; heavy loops / loop N times / repeat; bulk processing / bulk comments / bulk submit / bulk create; scripting / pipelines / orchestration; repository-wide / codebase-wide scope; data work such as parsing N files / aggregating / merging and deduplicating.
- **Clearly standard (high confidence):** short text with a question word (what / why / how / which / whether); greetings (hi / thanks / 你好); a single action (look at X / read X); explanations (explain / what does X do).
- **minimal (medium confidence):** an explicit request for minimal / bare-bones, or "just run one command".
- **Everything else:** no high-confidence local verdict, so the local lean or `defaultMode` lands and the background model refines it.

### Examples

| Input | Mode | Why |
|---|---|---|
| `遍历所有文件，统计每个文件的行数并汇总` | `ptc` | batch + iterate |
| `并行下载这些 URL 然后合并结果` | `ptc` | parallel |
| `批量发评论` | `ptc` | bulk operation |
| `解释一下这个函数的作用` | `standard` | explanation |
| `帮我看下 README 第一段` | `standard` | single action |
| `你好` | `standard` | greeting |
| `继续` | unchanged | continuation |
| `/mode minimal` | `minimal` | explicit user choice |

### The model call (improves the next turn)

- The current turn never waits for the model: when the local rules are unsure, the local lean or `defaultMode` lands first so the turn always has a working executor.
- One `ctx.llm.stream(...)` call in the background, `temperature` `0` by default, about 256 output tokens, with a timeout (8 seconds by default).
- The prompt asks for JSON only: `{"mode":"standard|ptc|minimal","reason":"…","confidence":0..1}`.
- Parsing is forgiving: strip ```` ```json ```` fences, grab the first `{...}`, fall back to `defaultMode` on an invalid value.
- Failure (timeout / error / unparseable) is treated as "the model had no usable verdict": the applied mode stays and the session is unaffected.
- When the verdict returns, it is applied only if the user has not pinned a mode meanwhile and it differs from the current one — effective from the next turn.
- Provider and model resolve in order: plugin config → agent options / session `requestHeader()` → `agentDefaultModel` → the first registered provider; the model defaults to `deepseek-v4-flash`.

## Configuration

Every field is optional; see `cordis.patch.yml` for inline comments.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `defaultMode` | `'standard'` | used when routing cannot decide or fails |
| `provider` | `''` | empty = resolve automatically |
| `model` | `'deepseek-v4-flash'` | model for the slow classification call |
| `modelEnabled` | `true` | enable the background Flash verdict (applies to the next turn) |
| `modelMaxTokens` | `256` | output cap for the slow classification |
| `modelTemperature` | `0` | sampling temperature for the slow classification |
| `modelTimeoutMs` | `8000` | timeout for the slow classification |
| `minimalAllowlist` | `['bash','read_file','write_file','edit_file']` | tools allowed in minimal mode |
| `applyToSubagents` | `false` | also adopt subagents |
| `guidance` | `true` | inject the mode guidance section |
| `extraPtc` | `[]` | extra PTC keywords |
| `extraStandard` | `[]` | extra standard keywords |
| `sticky` | `true` | honour explicit user choices as sticky preferences |

Override in a profile patch:

```yaml
- id: dsh-turn-preset-router
  config:
    modelEnabled: false
    minimalAllowlist: ['bash', 'read_file', 'edit_file']
    extraPtc: ['screenshot diff', '批量截图']
```

`extraPtc` / `extraStandard` extend the keyword lists used by the local rules and do not change the model call. With `modelEnabled: false` no model request is made at all, so the turn is decided purely by the local rules and `defaultMode`.

## How it works

**The one window.** Every switch has to happen inside the **synchronous** `agent/inbox/inserted` handler: that event is emitted synchronously from `inbox.mutate()`, before the driver's `wakeDriver()` and step assembly, and it is the only moment at which the current turn's tool catalog can still change. Cordis `emit` does not await async listeners, so any `await` on the turn path would silently push the switch one turn late. The plugin therefore moves all preparation off the turn path: `prepare` obtains the agent-scoped child context at `agent/created`, and `warmUp` pre-imports the `PtcExecutor` class when the plugin loads. The turn path (`handleUserMessage` → `route` → `applyModeSync`) contains no awaits at all.

**Safety net.** By the time `agent/pre-step` runs, the step's tool catalog is fixed — swapping an executor there only affects the next turn. It covers agents the inbox path missed and prepares later turns. `agent/disposed` cleans up.

**Applying.** The plugin injects an agent-scoped child context that can see `tools` / `systemPrompt`, then switches the executor synchronously with `ctx.tools.setExecutor()`. The order is **build first, tear down second**: construct the next executor, dispose the old one, then `setExecutor`, all in the same tick. Otherwise the scope is briefly observable without an executor, a window where a concurrent `assemble()` throws `TOOL_EXECUTOR_UNAVAILABLE`. `ptc` installs a `PtcExecutor`; `standard` reuses the deployment's default executor rather than constructing a new native one, avoiding duplicate construction and semantic drift; `minimal` keeps that same default executor and adds `tools.restrict({ allow: minimalAllowlist })`. `appliedMode` records the *mode*, not the executor kind — `standard` and `minimal` share an executor, so comparing executor kinds would miss the `minimal → standard` transition and leave the allowlist stuck.

**Visibility.** A switch emits `tools/change` so other registries re-read the catalog, and a short section describing the current mode is injected into the system prompt (`ctx.systemPrompt.section`), re-rendered on every assemble.

**Fallback.** `ptcRuntime` is optional and deliberately *not* listed in `inject` (`inject` only fires once every named service exists, so a deployment without the PTC runtime would never prepare and the whole plugin would go dark). Availability is probed at runtime with `ctx.get('ptcRuntime')`. If PTC is unavailable, the pre-import failed, or `PtcExecutor` construction throws, the router falls back to `standard` with a warning — never an exception in the session.

**State.** One WeakMap entry per agent: applied mode, current mode, source, sticky preference, last decision, the agent child context, both disposers, and the in-flight refinement promise (to prevent concurrent routing). It is dropped when the agent is disposed.

## Development

```sh
npm test                                   # rules, continuations, explicit modes, config, state machine
npm run classify -- "遍历所有文件统计行数"   # offline classifier CLI — local rules only
```

All three integration harnesses mount the real host services, so `@deepseek-ai/*` must resolve from `dev/` first:

```sh
ln -s /path/to/dsh/node_modules dev/node_modules
npm run integration    # mount the plugin on the real ToolsService / SystemPrompt (9 scenarios / 25 checks)
npm run spike          # executor switch round-trip spike
npm run prestep        # the pre-step safety net only parks; the next turn consumes (5 scenarios / 30 checks)
npm run regression     # classifier timing: a verdict never lands in the turn that produced it (4 cases / 26 checks)
npm run verify         # all of the above plus the unit tests, in one command

npm run real -- "hello"  # boot a real dsh process with a real model (isolated DSH_HOME)
```

`npm run real` is the layer closest to actual use: a real `dsh` process, a real session, a real model.
Results and caveats live in [docs/LOCAL-VERIFY.md](docs/LOCAL-VERIFY.md).

The design and implementation contract lives in [docs/DESIGN.md](docs/DESIGN.md); where documentation and implementation disagree, it wins (§9 there records the post-implementation corrections and overrides earlier conflicting sections).

## Limits

- **The model verdict only affects the next turn.** That follows from DSH's assembly order: the tool catalog is fixed before `agent/pre-step` runs, and event emit does not await async listeners. The current turn is always decided by the local rules or `defaultMode`; this is a real limitation, not an implementation shortcut.
- **A switch rebuilds the prefix.** Changing the mode changes the tool catalog and the system prompt, so the next request rebuilds its prefix (one KV-cache miss). That is inherent to changing the shape.
- **`ptc` needs a mounted `ptcRuntime`.** Without one the plugin degrades to `standard` automatically and says so in `/mode`.
- **The preset itself cannot change.** After the first turn `agentPresets.select()` is locked; the plugin owns the tool executor and the prompt section — the parts of a preset that actually vary per turn.
- **Root agents only by default.** Subagents keep their own composition; set `applyToSubagents: true` to adopt them.
- **Disabling the model leaves only local rules.** With `modelEnabled: false` no model request is made, so the turn is decided entirely by the local rules and `defaultMode`.
- **Sticky preferences are not written to config.** They are held per agent in plugin memory, and are recovered after resume / fork from the logged `command/run` (`/mode`) events — so a restart keeps them without touching the profile. Use `defaultMode` and `sticky` for deployment-wide behaviour.

## Repository layout

```text
dsh-turn-preset-router/
├── package.json          # dsh.bundle.patch + engines.dsh
├── cordis.patch.yml      # bundle patch (one insert row + commented defaults)
├── lib/
│   ├── index.js          # host plugin entry: events, /mode, state
│   ├── rules.js          # local fast rules (pure functions)
│   ├── classifier.js     # model-based slow classification (llm.stream + parsing)
│   ├── router.js         # state machine + executor/restrict application
│   ├── config.js         # config normalisation
│   └── messages.js       # text extraction, isContinuation, explicit-mode parsing
├── locale/{zh,en}.json   # plugin page title/description
├── icon.svg
├── bin/classify.mjs      # offline classifier CLI (debugging)
├── test/*.test.mjs       # node:test unit suites
├── dev/                  # real-service harnesses + overlay patch
├── docs/DESIGN.md        # design contract
├── README.md / README.zh.md
└── LICENSE
```

## License

MIT
