/**
 * Regression test: a background model verdict must never desync the step that
 * produced it, and must still reach the turn it can legally improve.
 *
 * ## The hazard this guards
 *
 * A turn's tool catalog is fixed by `preStep` (`tools.resolve()` then
 * `systemPrompt.assemble()`) *before* the main model streams. But
 * `ToolsService.execute()` re-selects the executor at **dispatch** time from
 * the Agent scope (`selectExecutor(input.agent)`), not from the step's
 * `toolSet`. So any code that swaps the executor while a step is in flight
 * makes that step dispatch the catalog it was *shown* against an executor that
 * no longer serves it:
 *
 *   - native catalog shown, scope now PTC  → native calls fail `UNKNOWN_TOOL`
 *     ("only `run_code` is callable directly")
 *   - `run_code` shown, scope now native  → `run_code` fails `UNKNOWN_TOOL`
 *
 * The router's slow classifier (default timeout 8s, typically well under a
 * second) returns while the main model is still streaming, so this was not a
 * corner case: it was the default path for every turn the local rules were
 * unsure about.
 *
 * ## The contract asserted here
 *
 * `docs/DESIGN.md` §9.2: a model verdict may only improve the **next** turn.
 * Concretely:
 *
 *   1. a verdict arriving mid-step is parked, never applied in place;
 *   2. the in-flight step keeps dispatching successfully against the catalog it
 *      was shown;
 *   3. the parked verdict is consumed at the next turn's inbox event — before
 *      that turn's tool catalog is resolved — and a continuation inherits it.
 *
 * Run: node dev/midstep-verdict-regression.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as SP from '@deepseek-ai/dsh-system-prompt'
import * as T from '@deepseek-ai/dsh-tools'
import * as NAT from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentCarrier, assembleContextFor } from '@deepseek-ai/dsh-agent'

import { apply } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

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
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A PTC runtime stand-in: shape only, never executes a program. */
class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'regression' }
  }
  resolve(request) {
    return { ...request, cwd: process.cwd() }
  }
  async run() {
    return { value: null, logs: [], error: undefined }
  }
}

/** The classifier stand-in: answers `verdict` after `delayMs`. */
class FakeLlm extends Service {
  constructor(ctx, { verdict = 'ptc', delayMs = 10 } = {}) {
    super(ctx, 'llm')
    this.calls = 0
    this.verdict = verdict
    this.delayMs = delayMs
  }
  listProviders() {
    return [{ id: 'fake' }]
  }
  async *stream() {
    this.calls += 1
    await settle(this.delayMs)
    yield { type: 'text-delta', text: JSON.stringify({ mode: this.verdict, reason: 'regression verdict', confidence: 0.95 }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TOOL = (name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async () => ({ ok: true }),
})

/** Mount the composition plus one Agent, exactly as a session would. */
async function build({ verdict, delayMs = 10 }) {
  const root = new Context()
  const warnings = []
  const logger = (scope) => ({ warn: (message) => warnings.push({ scope, message }), info: () => {} })
  logger.warn = (message) => warnings.push({ message })
  logger.info = () => {}
  root.logger = logger

  await root.plugin(SP.SystemPrompt, { personaPrefix: '' })
  await root.plugin(FakePtcRuntime)
  await root.plugin(T.ToolsService, {})
  await root.plugin(NAT)
  for (const name of ['demo', 'bash']) root.get('tools').register(TOOL(name))
  const llm = new FakeLlm(root, { verdict, delayMs })

  apply(root, {
    enabled: true,
    defaultMode: 'standard',
    guidance: true,
    modelEnabled: true,
    provider: 'fake',
    model: 'fake-model',
    modelTimeoutMs: 2000,
  })
  await import('@deepseek-ai/dsh-tool-executor-ptc')
  await settle(80)

  const messages = []
  const agent = {
    id: `verdict-${Math.random().toString(36).slice(2, 8)}`,
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

  root.emit(agentCarrier(agent), 'agent/created', { agent, source: 'startup' })
  await settle(150)

  const signal = new AbortController().signal
  const modelSelection = { provider: 'fake', model: 'fake-model' }

  const executorName = () => {
    try {
      return root.get('tools').selectExecutor(agent)?.constructor?.name ?? 'undefined'
    } catch (error) {
      return `threw:${error?.constructor?.name ?? String(error)}`
    }
  }

  /**
   * Replay one turn up to the point where its catalog is fixed and the model is
   * about to stream. Returns the fixed catalog and its tool admission.
   */
  const startTurn = async (text) => {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    messages.push(message)
    root.emit(agentCarrier(agent), 'agent/inbox/inserted', { agent, message })
    const toolSet = await root.get('tools').resolve({ agent, modelSelection, signal })
    const assembly = await root
      .get('systemPrompt')
      .assemble({ ...assembleContextFor(agent, signal), modelSelection, toolSet })
    return { message, toolSet, shownToModel: assembly.tools.map((tool) => tool.name).sort() }
  }

  const dispatch = async (turn, name) => {
    const settled = await root.get('tools').execute({
      calls: [{ id: 'call-1', name, arguments: {} }],
      agent,
      toolSet: turn.toolSet,
      signal,
    })
    return settled.results[0].result
  }

  return { root, agent, scope, llm, warnings, executorName, startTurn, dispatch }
}

// ── cases ────────────────────────────────────────────────────────────────────

/**
 * Case A — a native catalog is shown, the verdict says PTC.
 *
 * "帮我看看这个" is a medium-confidence *standard* lean, so the local rules land
 * it on native and ask the model for a second opinion in the background.
 */
async function caseNativeCatalogPtcVerdict() {
  console.log('\n— case A: native catalog shown, verdict says PTC')
  const { root, scope, llm, warnings, executorName, startTurn, dispatch } = await build({ verdict: 'ptc' })
  try {
    const turn = await startTurn('帮我看看这个')
    check(turn.shownToModel.includes('demo'), 'the turn was assembled on the native catalog')
    checkEqual(executorName(), 'NativeToolExecutor', 'the executor is native when the step starts streaming')

    // The main model streams for seconds; the background verdict lands meanwhile.
    await settle(400)
    check(llm.calls >= 1, 'the background classifier actually ran')
    checkEqual(executorName(), 'NativeToolExecutor', 'the mid-step verdict did NOT swap the executor (parked instead)')

    const result = await dispatch(turn, turn.shownToModel[0])
    check(
      result.isError !== true,
      result.isError !== true
        ? 'the in-flight step dispatched its native catalog successfully'
        : `the in-flight step broke: ${result.error.info.code} — ${result.error.message}`,
    )
    turn.toolSet.dispose()

    // A continuation inherits the previous turn's decision, so it is the turn
    // that must consume the parked verdict.
    const next = await startTurn('继续')
    checkEqual(next.shownToModel, ['run_code'], 'the parked PTC verdict is consumed by the next turn')
    checkEqual(executorName(), 'PtcExecutor', 'the next turn selects the PTC executor')
    const nextResult = await dispatch(next, 'run_code')
    check(
      nextResult.isError !== true || nextResult.error.info.code !== 'UNKNOWN_TOOL',
      'the next step reaches the run_code transport (no UNKNOWN_TOOL)',
    )
    next.toolSet.dispose()

    checkEqual(warnings, [], 'the router logged no warning')
  } finally {
    await scope.dispose()
    root.dispose?.()
  }
}

/**
 * Case B — a PTC catalog is shown, the verdict says standard.
 *
 * "写个脚本" is a medium-confidence *ptc* lean, so the local rules land it on PTC
 * and the background verdict (standard) lands mid-step.
 */
async function casePtcCatalogStandardVerdict() {
  console.log('\n— case B: PTC catalog shown, verdict says standard')
  const { root, scope, llm, warnings, executorName, startTurn, dispatch } = await build({ verdict: 'standard' })
  try {
    const turn = await startTurn('写个脚本')
    checkEqual(turn.shownToModel, ['run_code'], 'the turn was assembled on the PTC catalog')
    checkEqual(executorName(), 'PtcExecutor', 'the executor is PTC when the step starts streaming')

    await settle(400)
    check(llm.calls >= 1, 'the background classifier actually ran')
    checkEqual(executorName(), 'PtcExecutor', 'the mid-step verdict did NOT swap the executor (parked instead)')

    // `run_code`'s own argument schema rejects an empty call, so assert on the
    // error *kind*: reaching the transport means no UNKNOWN_TOOL desync.
    const result = await dispatch(turn, 'run_code')
    const code = result.isError === true ? result.error.info.code : 'none'
    check(
      code !== 'UNKNOWN_TOOL',
      code === 'UNKNOWN_TOOL'
        ? 'the in-flight step dispatched against the wrong executor'
        : `the in-flight step still reached run_code (error kind: ${code})`,
    )
    turn.toolSet.dispose()

    const next = await startTurn('继续')
    check(next.shownToModel.includes('demo'), 'the parked standard verdict is consumed by the next turn')
    checkEqual(executorName(), 'NativeToolExecutor', 'the next turn selects the native executor')
    const nextResult = await dispatch(next, next.shownToModel[0])
    check(nextResult.isError !== true, 'the next step dispatches its native catalog successfully')
    next.toolSet.dispose()

    checkEqual(warnings, [], 'the router logged no warning')
  } finally {
    await scope.dispose()
    root.dispose?.()
  }
}

/**
 * Case C — parking is one-shot and a user pin always wins.
 *
 * A parked verdict is consumed exactly once; an explicit `/mode` must clear it
 * rather than let it resurface on a later turn.
 */
async function caseVerdictIsOneShot() {
  console.log('\n— case C: a parked verdict is one-shot, and a user pin wins')
  const { root, scope, warnings, executorName, startTurn } = await build({ verdict: 'ptc' })
  try {
    const first = await startTurn('帮我看看这个')
    await settle(400)
    first.toolSet.dispose()
    checkEqual(executorName(), 'NativeToolExecutor', 'the verdict is parked, not applied, after its own turn')

    // Consume it.
    const second = await startTurn('继续')
    checkEqual(second.shownToModel, ['run_code'], 'the parked verdict is consumed by the next turn')
    second.toolSet.dispose()

    // An explicit user choice overrides and clears the applied mode's stickiness.
    const third = await startTurn('/mode standard')
    checkEqual(third.shownToModel, ['bash', 'demo'], 'an explicit /mode standard wins')
    third.toolSet.dispose()

    const fourth = await startTurn('继续')
    checkEqual(fourth.shownToModel, ['bash', 'demo'], 'the explicit choice stays sticky on the following turn')
    fourth.toolSet.dispose()

    checkEqual(warnings, [], 'the router logged no warning')
  } finally {
    await scope.dispose()
    root.dispose?.()
  }
}

/**
 * Case D — a mid-step verdict must not leak into a *new* task's routing.
 *
 * The next turn is a fresh request, not a continuation: the router re-routes it
 * from its own text, and the parked verdict must not survive that turn.
 */
async function caseNewTaskReroutes() {
  console.log('\n— case D: a new task re-routes instead of inheriting the parked verdict')
  const { root, scope, warnings, executorName, startTurn } = await build({ verdict: 'ptc' })
  try {
    const first = await startTurn('帮我看看这个')
    await settle(400)
    first.toolSet.dispose()

    // A high-confidence *standard* task must win over the parked PTC verdict.
    const second = await startTurn('解释一下这个函数的作用')
    checkEqual(second.shownToModel, ['bash', 'demo'], 'the new task was routed from its own text, not the parked verdict')
    checkEqual(executorName(), 'NativeToolExecutor', 'the new task selects the native executor')
    second.toolSet.dispose()

    checkEqual(warnings, [], 'the router logged no warning')
  } finally {
    await scope.dispose()
    root.dispose?.()
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('mid-step verdict regression — DESIGN.md §9.2: a verdict may only improve the NEXT turn')
  await caseNativeCatalogPtcVerdict()
  await casePtcCatalogStandardVerdict()
  await caseVerdictIsOneShot()
  await caseNewTaskReroutes()

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('regression crashed:', error)
  process.exitCode = 1
})
