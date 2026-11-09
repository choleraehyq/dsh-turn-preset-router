/**
 * Driver-order harness: what the `agent/pre-step` safety net can and cannot do.
 *
 * `plugin-mount-harness.mjs` proves the inbox path — the only window that can
 * change the turn it belongs to. This file covers the other half of the
 * contract, which only a faithful driver order can demonstrate.
 *
 * The real `preStep` is, in this order:
 *
 *     inbox.claim()  →  tools.resolve()  →  systemPrompt.assemble()
 *                    →  agent/pre-step waterfall
 *
 * So when the safety net runs, this step's tool admission and model-facing
 * catalog are **already fixed**. The router may still change the Agent scope's
 * executor there, but that change must only be observable by the *next* step.
 * Two assertions make that precise:
 *
 *   - the tool set resolved before the waterfall keeps naming native tools, and
 *     the assembly built from it does too;
 *   - a tool set / assembly resolved after the switch names `run_code`.
 *
 * The harness drives that order by hand against the real `ToolsService`,
 * `SystemPrompt` and executor classes. Only the PTC sandbox (a stand-in runtime
 * that never executes programs) and the Agent object are faked — the Agent is
 * constructed the way the loop builds one, with a scoped `ctx` from
 * `createScope()` and an event carrier from `agentCarrier()`.
 *
 * Run: node dev/prestep-harness.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as SP from '@deepseek-ai/dsh-system-prompt'
import * as T from '@deepseek-ai/dsh-tools'
import * as NAT from '@deepseek-ai/dsh-tool-executor-native'
import * as PTC from '@deepseek-ai/dsh-tool-executor-ptc'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentCarrier, assembleContextFor } from '@deepseek-ai/dsh-agent'

import { apply } from '../lib/index.js'

// ── tiny assertion helpers ───────────────────────────────────────────────────

let checks = 0
let failures = 0
function check(condition, message) {
  checks += 1
  if (condition) console.log(`ok   - ${message}`)
  else {
    failures += 1
    console.error(`FAIL - ${message}`)
  }
}
function checkEqual(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(same, same ? message : `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ── fakes: only what the plugin cannot reach offline ─────────────────────────

/**
 * A PTC runtime stand-in.
 *
 * `PtcExecutor` reads `language`, `programFormat`, `executionInstructions` and
 * `isolation` to render its SDK section, and calls `resolve()`/`run()` only when
 * a program is actually executed — which this harness never does. It therefore
 * needs the shape, not a sandbox.
 */
class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'prestep-harness' }
  }
  resolve(request) {
    return { ...request, cwd: process.cwd() }
  }
  async run() {
    return { value: null, logs: [], error: undefined }
  }
}

/** The tool catalog; `demo` is the marker that native tools are visible. */
const TOOL_NAMES = ['demo', 'bash', 'read_file', 'write_file', 'edit_file']
const NATIVE = [...TOOL_NAMES].sort()

function makeTool(name) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
  }
}

const userMessage = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** A batch-shaped turn: the local rules route it to PTC with high confidence. */
const BATCH = '遍历所有文件，统计每个文件的行数并汇总成表格'

// ── composition + Agent ──────────────────────────────────────────────────────

/**
 * Mount the real Host services and the plugin, exactly as a session would.
 *
 * @param {{defaultMode?: string, modelEnabled?: boolean, withPtc?: boolean}} [options]
 */
async function build(options = {}) {
  const { defaultMode = 'standard', modelEnabled = false, withPtc = true } = options
  const root = new Context()

  // Capture every warning the plugin emits; a healthy run must produce none.
  const warnings = []
  const logger = (scope) => ({ warn: (message) => warnings.push({ scope, message }), info: () => {} })
  logger.warn = (message) => warnings.push({ scope: undefined, message })
  logger.info = () => {}
  root.logger = logger

  await root.plugin(SP.SystemPrompt, { personaPrefix: '' })
  if (withPtc) await root.plugin(FakePtcRuntime)
  await root.plugin(T.ToolsService, {})
  await root.plugin(NAT)

  const tools = root.get('tools')
  for (const name of TOOL_NAMES) tools.register(makeTool(name))

  apply(root, {
    enabled: true,
    defaultMode,
    guidance: true,
    // The model is not part of this harness: the safety net is local-only, and
    // an async classifier would only add nondeterminism to the timing checks.
    modelEnabled,
    provider: '',
    model: '',
  })

  // `warmUp()` imports the PTC executor class off the turn path. Cache the
  // module here first so that import resolves immediately, then let the plugin
  // fibers settle before the first turn starts.
  if (withPtc) await import('@deepseek-ai/dsh-tool-executor-ptc')
  await settle(50)

  const deploymentDefault = tools.selectExecutor(undefined)
  return { root, tools, deploymentDefault, warnings }
}

/** Build one Agent the way the loop does: scoped ctx + fused event carrier. */
function makeAgent(root, id) {
  const messages = []
  const agent = {
    id,
    session: {
      deriveMessages: () => messages.slice(),
      requestHeader: () => undefined,
      append: (type, data) => {
        messages.push({ type, data })
        return { type, data }
      },
    },
    inject: (message) => messages.push(message),
  }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  return { agent, scope, messages }
}

/** Run the loop's `agent/created` step and wait for the bootstrap to settle. */
async function bootstrap(root, agent) {
  const changed = onceToolsChange(root)
  root.emit(agentCarrier(agent), 'agent/created', { agent, source: 'startup' })
  await changed
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve on the next `tools/change`, with a deadline so a hang fails loudly. */
function onceToolsChange(root, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let off
    const timer = setTimeout(() => {
      off?.()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for tools/change`))
    }, timeoutMs)
    off = root.on('tools/change', () => {
      clearTimeout(timer)
      off?.()
      resolve()
    })
  })
}

/** Poll a synchronous predicate until it holds or the deadline passes. */
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await settle(intervalMs)
  }
  return false
}

// ── driver-order primitives ──────────────────────────────────────────────────

/**
 * Replay one `preStep` in the driver's exact order.
 *
 * This is the whole point of the file: `tools.resolve()` and `assemble()` run
 * *before* the `agent/pre-step` waterfall, so anything the safety net does
 * cannot reach the returned `toolSet`/`assembly`.
 *
 * @param {{root: Context, agent: object, signal: AbortSignal, modelSelection: object}} ctx
 * @param {{turn?: number, step?: number, claimed?: object[], onProceed?: () => void}} [position]
 */
async function preStep(ctx, position = {}) {
  const { root, agent, signal, modelSelection } = ctx
  const { turn = 1, step = 1, claimed = [], onProceed } = position

  // 1. claim — the driver takes this step's messages from the inbox.
  const messages = claimed

  // 2. resolve — the step's tool admission is fixed here.
  const toolSet = await root.get('tools').resolve({ agent, modelSelection, signal })

  // 3. assemble — the model-facing catalog is built from that admission.
  const assembly = await root
    .get('systemPrompt')
    .assemble({ ...assembleContextFor(agent, signal), modelSelection, toolSet })

  // 4. waterfall — the safety net runs last, after the catalog is already fixed.
  const decision = await root.waterfall(
    agentCarrier(agent),
    'agent/pre-step',
    { agent, messages, turn, step, signal, modelSelection },
    () => {
      onProceed?.()
      return Promise.resolve({ kind: 'enter', messages })
    },
  )

  return { toolSet, assembly, decision, names: assembly.tools.map((tool) => tool.name).sort() }
}

/** Assemble the way the driver does, but without a fixed tool set (a fresh read). */
async function freshNames(ctx) {
  const { root, agent, signal, modelSelection } = ctx
  const assembly = await root.get('systemPrompt').assemble({ ...assembleContextFor(agent, signal), modelSelection })
  return assembly.tools.map((tool) => tool.name).sort()
}

/** Read the Agent scope's currently selected executor class name. */
function executorName(ctx) {
  const { root, agent } = ctx
  try {
    return root.get('tools').selectExecutor(agent)?.constructor?.name ?? 'undefined'
  } catch (error) {
    return `threw:${error?.constructor?.name ?? String(error)}`
  }
}

/** Turn a context plus Agent into the arguments `preStep`/`freshNames` need. */
function driverContext(root, agent) {
  const controller = new AbortController()
  return { root, agent, signal: controller.signal, modelSelection: { provider: 'harness', model: 'harness' } }
}

// ── scenarios ────────────────────────────────────────────────────────────────

/**
 * Scenario 1 — the happy path: the inbox already routed, so the safety net is a
 * no-op. It must not re-route, re-emit `tools/change`, or disturb the step.
 */
async function scenarioInboxRouted(root) {
  console.log('\n— scenario 1: pre-step is a no-op after the inbox already routed')
  const { agent, messages, scope } = makeAgent(root, 'inbox-routed')
  await bootstrap(root, agent)
  const ctx = driverContext(root, agent)

  checkEqual(await freshNames(ctx), NATIVE, 'a bootstrapped agent starts on native tools')

  let changes = 0
  const off = root.on('tools/change', () => {
    changes += 1
  })

  const message = userMessage(BATCH)
  messages.push(message)
  root.emit(agentCarrier(agent), 'agent/inbox/inserted', { agent, message })
  checkEqual(await freshNames(ctx), ['run_code'], 'the inbox handler routed this turn synchronously')
  check(changes === 1, `the inbox swap emitted exactly one tools/change (got ${changes})`)

  const turn = await preStep(ctx, { claimed: [message] })
  checkEqual(turn.names, ['run_code'], 'the step catalog is the routed one')
  await settle(20)
  check(changes === 1, `the safety net did not re-route an already-routed turn (got ${changes} tools/change)`)
  checkEqual(turn.names, ['run_code'], 'the fixed catalog is unchanged by the safety net')
  checkEqual(await freshNames(ctx), ['run_code'], 'a fresh read still agrees')

  off()
  await scope.dispose()
}

/**
 * Scenario 2 — the safety net's reason to exist: the inbox listener never saw
 * the turn (a resume, another plugin's injection, a listener that ran early).
 *
 * It must record a decision for the **next** turn without touching this one.
 * The stronger form — swapping the executor here — is deliberately not used:
 * `ToolsService.execute()` re-selects the executor at dispatch time, so a swap
 * during the waterfall would make this very step dispatch its already-fixed
 * catalog against the new executor and fail with `UNKNOWN_TOOL`.
 */
async function scenarioInboxMissed(root, deploymentDefault) {
  console.log('\n— scenario 2: a missed inbox is covered by pre-step, applied from the next turn')
  const { agent, messages, scope } = makeAgent(root, 'inbox-missed')
  const ctx = driverContext(root, agent)

  // Deliberately no `agent/created`: the router has never prepared this scope,
  // which is exactly the state a missed turn leaves behind.
  checkEqual(executorName(ctx), 'NativeToolExecutor', 'the un-prepared scope selects the deployment default')

  let changes = 0
  const off = root.on('tools/change', () => {
    changes += 1
  })

  const message = userMessage(BATCH)
  messages.push(message)

  const turn = await preStep(ctx, { claimed: [message] })

  checkEqual(turn.names, NATIVE, 'the pre-step turn was assembled on native tools (the catalog is already fixed)')
  await settle(50)
  checkEqual(
    executorName(ctx),
    'NativeToolExecutor',
    'the safety net did not swap the executor mid-step (a swap here would break this step\'s dispatch)',
  )
  check(changes === 0, `the safety net emitted no tools/change during this step (got ${changes})`)
  checkEqual(await freshNames(ctx), NATIVE, 'a fresh read within the same turn still agrees')

  // The recorded decision is consumed by the NEXT turn's inbox event, which is
  // the only safe point to change the executor.
  turn.toolSet.dispose()
  const nextMessage = userMessage('继续')
  messages.push(nextMessage)
  root.emit(agentCarrier(agent), 'agent/inbox/inserted', { agent, message: nextMessage })
  checkEqual(await freshNames(ctx), ['run_code'], 'the next turn consumes the recorded decision and exposes run_code')
  checkEqual(executorName(ctx), 'PtcExecutor', 'the next turn selects the PTC executor')

  // The deployment's own default view is untouched by any of this.
  const globalAssembly = await root.get('systemPrompt').assemble({})
  checkEqual(globalAssembly.tools.map((tool) => tool.name).sort(), NATIVE, 'the global view still lists native tools')
  check(
    root.get('tools').selectExecutor(undefined) === deploymentDefault,
    'the deployment default executor is the very same instance as before the turn',
  )
  check(
    deploymentDefault?.constructor?.name === 'NativeToolExecutor',
    'the deployment default executor is still the native one',
  )
  const globalGuidance = globalAssembly.sections.find((section) => section.name === 'turn-preset-router:mode')
  check(globalGuidance !== undefined && globalGuidance.text === '', 'the global guidance section renders empty')

  off()
  await scope.dispose()
}

/**
 * Scenario 3 — the safety net records a decision at most once per turn and never
 * overrides a turn that already has an applied mode. `tools/change` is the
 * observable: because pre-step no longer swaps, a healthy run emits none.
 */
async function scenarioOncePerTurn(root) {
  console.log('\n— scenario 3: the safety net records at most once per turn')
  const { agent, messages, scope } = makeAgent(root, 'once-per-turn')
  const ctx = driverContext(root, agent)
  const message = userMessage(BATCH)
  messages.push(message)

  let changes = 0
  const off = root.on('tools/change', () => {
    changes += 1
  })

  await preStep(ctx, { turn: 1, step: 1, claimed: [message] })
  await settle(30)
  check(changes === 0, `the first pre-step recorded without swapping (got ${changes} tools/change)`)

  await preStep(ctx, { turn: 1, step: 2, claimed: [message] })
  await settle(20)
  check(changes === 0, `a second step in the same turn does not re-route (got ${changes} tools/change)`)

  await preStep(ctx, { turn: 2, step: 1, claimed: [message] })
  await settle(20)
  check(changes === 0, `a later turn still records without swapping (got ${changes} tools/change)`)

  off()
  await scope.dispose()
}

/**
 * Scenario 4 — the executor swap has no unavailable-executor window.
 *
 * The router builds the next executor before tearing the old one down and does
 * both in one synchronous block, so no microtask can observe
 * `TOOL_EXECUTOR_UNAVAILABLE`. The swap is driven from the inbox path (the only
 * path that may change the executor); sampling on every microtask across it,
 * and from inside a `tools/change` listener, proves the invariant.
 */
async function scenarioNoUnavailableWindow(root) {
  console.log('\n— scenario 4: the executor swap has no unavailable-executor window')
  const { agent, messages, scope } = makeAgent(root, 'no-window')
  const ctx = driverContext(root, agent)
  // The inbox path requires a prepared scope: `bootstrap` does that off the
  // turn path, exactly as `agent/created` does in a live session.
  await bootstrap(root, agent)
  const message = userMessage(BATCH)
  messages.push(message)

  const samples = []
  let sampling = true
  let budget = 512
  const sample = () => {
    samples.push(executorName(ctx))
    budget -= 1
    if (sampling && budget > 0) queueMicrotask(sample)
    else sampling = false
  }

  // A `tools/change` listener runs synchronously inside the swap; reading the
  // selection there is the strictest observation point available.
  const fromListener = []
  const off = root.on('tools/change', () => {
    fromListener.push(executorName(ctx))
  })

  queueMicrotask(sample)
  root.emit(agentCarrier(agent), 'agent/inbox/inserted', { agent, message })
  await waitFor(() => executorName(ctx) === 'PtcExecutor')
  await settle(20)
  sampling = false

  const bad = samples.filter((name) => name !== 'NativeToolExecutor' && name !== 'PtcExecutor')
  check(bad.length === 0, `every microtask sample saw a real executor (bad samples: ${JSON.stringify(bad)})`)
  check(
    fromListener.length === 1 && fromListener[0] === 'PtcExecutor',
    `the tools/change listener observed the new executor, never an unavailable one (saw ${JSON.stringify(fromListener)})`,
  )
  checkEqual(await freshNames(ctx), ['run_code'], 'the scope is left on a working PTC executor')

  off()
  await scope.dispose()
}

/**
 * Scenario 5 — with no task history, the safety net records `defaultMode` for
 * the next turn.
 *
 * `defaultMode` is configured as `ptc` here so the effect is observable on a
 * scope that otherwise would have kept the deployment's native executor.
 */
async function scenarioDefaultMode() {
  console.log('\n— scenario 5: pre-step with no history records defaultMode for the next turn')
  const { root } = await build({ defaultMode: 'ptc' })
  try {
    const { agent, scope } = makeAgent(root, 'default-mode')
    const ctx = driverContext(root, agent)

    // No agent/created and no messages: the only entry point is the safety net.
    checkEqual(executorName(ctx), 'NativeToolExecutor', 'the scope starts on the deployment default')

    const turn = await preStep(ctx, { claimed: [] })
    checkEqual(turn.names, NATIVE, 'the empty turn was assembled on the deployment default')
    await settle(50)
    checkEqual(executorName(ctx), 'NativeToolExecutor', 'the safety net did not swap the executor mid-step')

    // The recorded default is applied by the next turn's inbox event.
    const message = userMessage('继续')
    root.emit(agentCarrier(agent), 'agent/inbox/inserted', { agent, message })
    checkEqual(await freshNames(ctx), ['run_code'], 'the next turn applies the recorded defaultMode = ptc')
    check(
      root.get('tools').selectExecutor(agent) instanceof PTC.PtcExecutor,
      'the next turn selects the PTC executor',
    )

    await scope.dispose()
  } finally {
    root.dispose?.()
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { root, deploymentDefault, warnings } = await build()

  try {
    await scenarioInboxRouted(root)
    await scenarioInboxMissed(root, deploymentDefault)
    await scenarioOncePerTurn(root)
    await scenarioNoUnavailableWindow(root)
    await scenarioDefaultMode()

    console.log('\n— cross-cutting: the plugin never logged a warning')
    check(warnings.length === 0, `no warnings were emitted (got ${JSON.stringify(warnings.slice(0, 5))})`)
  } finally {
    root.dispose?.()
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('prestep harness crashed:', error)
  process.exitCode = 1
})
