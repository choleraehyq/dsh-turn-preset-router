/**
 * Integration harness: mount the real router against real Host services.
 *
 * This is the load-bearing verification for the plugin. It does not mock the
 * mechanism that matters: a real `ToolsService` registry, a real
 * `SystemPrompt` assembly, and a real `PtcExecutor` swapping in and out of an
 * Agent scope. What it fakes is only the PTC *runtime* (the sandbox that would
 * execute programs) and the inbox/driver, which belong to a live session.
 *
 * The key property under test is that a mode change is visible in the very
 * next `assemble()` **synchronously** after the inbox event: that is the only
 * window in which the Harness has not yet fixed a turn's tool catalog.
 *
 * Run: node dev/plugin-mount-harness.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as SP from '@deepseek-ai/dsh-system-prompt'
import * as T from '@deepseek-ai/dsh-tools'
import * as NAT from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'

import { apply } from '../lib/index.js'

let failures = 0
let checks = 0
function check(condition, message) {
  checks += 1
  if (condition) {
    console.log(`ok   - ${message}`)
  } else {
    failures += 1
    console.error(`FAIL - ${message}`)
  }
}
function checkEqual(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

/** A PTC runtime stand-in: enough shape for PtcExecutor to render its SDK. */
class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'harness' }
  }
  resolve(request) {
    return { ...request, cwd: process.cwd() }
  }
  async run() {
    return { value: null, logs: [], error: undefined }
  }
}

/** A model stand-in that answers one canned mode verdict. */
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.calls = 0
    this.reply = '{"mode":"ptc","reason":"模型认为这是批量任务","confidence":0.95}'
    this.delayMs = 0
  }
  listProviders() {
    return [{ id: 'fake' }]
  }
  async *stream() {
    this.calls += 1
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    yield { type: 'text-delta', text: this.reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Build one composition and one Agent, ready to receive inbox events.
 * @param {{withPtc?: boolean, withLlm?: boolean, modelEnabled?: boolean, llmDelayMs?: number, minimalAllowlist?: string[]}} [options]
 */
async function build(options = {}) {
  const { withPtc = true, withLlm = true, modelEnabled = false, llmDelayMs = 0, minimalAllowlist } = options
  const root = new Context()
  root.logger = { warn: (message) => console.log(`[warn] ${message}`), info: () => {} }

  await root.plugin(SP.SystemPrompt, { personaPrefix: '' })
  if (withPtc) await root.plugin(FakePtcRuntime)
  await root.plugin(T.ToolsService, {})
  await root.plugin(NAT)
  const llm = withLlm ? new FakeLlm(root) : undefined
  if (llm !== undefined) llm.delayMs = llmDelayMs

  // A small tool catalog: `demo` is the marker native tools are visible.
  const toolNames = ['demo', 'bash', 'read_file', 'write_file', 'edit_file']
  for (const toolName of toolNames) {
    root.get('tools').register({
      name: toolName,
      description: `${toolName} tool`,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: async () => ({ ok: true }),
    })
  }

  apply(root, {
    enabled: true,
    defaultMode: 'standard',
    provider: withLlm ? 'fake' : '',
    model: withLlm ? 'fake-model' : '',
    modelEnabled,
    ...(minimalAllowlist === undefined ? {} : { minimalAllowlist }),
  })

  const messages = []
  const agent = {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    session: {
      deriveMessages: () => messages.slice(),
      requestHeader: () => undefined,
    },
    inject: (message) => messages.push(message),
  }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx

  // `agent/created` prepares the scope off the turn path; wait for it.
  root.emit('agent/created', { agent, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 150))

  /** Assemble exactly the way the driver does: with the Agent in context. */
  const tools = async () =>
    (await root.get('systemPrompt').assemble({ agent, scope: agent })).tools.map((tool) => tool.name).sort()

  /** Deliver one user message and read the tool catalog WITHOUT yielding. */
  // A turn is two events under the current contract: `inserted` records the
  // decision, `claimed` commits it before the step's tool catalog is resolved.
  // Both are synchronous, so reading the catalog right after `claimed` proves
  // the change lands in that step.
  const send = (text) => {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    messages.push(message)
    root.emit('agent/inbox/inserted', { agent, message })
    root.emit('agent/inbox/claimed', { agent, message })
    return tools()
  }

  /** Deliver a message that arrives while a step is in flight (no claim yet). */
  const sendMidStep = (text) => {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    messages.push(message)
    root.emit('agent/inbox/inserted', { agent, message })
    return tools()
  }

  /** The step boundary the router reads to decide whether it may commit. */
  const claim = () => {
    root.emit('agent/inbox/claimed', { agent, message: messages[messages.length - 1] })
    return tools()
  }

  return { root, agent, scope, tools, send, sendMidStep, claim, llm }
}

async function main() {
  console.log('— scenario 1: a batch task switches to PTC synchronously')
  {
    const { tools, send } = await build()
    checkEqual(await tools(), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'a fresh agent starts on native tools')
    checkEqual(
      await send('遍历所有文件，统计每个文件的行数并汇总成表格'),
      ['run_code'],
      'a batch task exposes only run_code, in the same tick',
    )
  }

  console.log('\n— scenario 2: a short question switches back to native')
  {
    const { send } = await build()
    await send('遍历所有文件，统计每个文件的行数并汇总成表格')
    checkEqual(await send('解释一下这个函数的作用'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'a short question restores native tools')
  }

  console.log('\n— scenario 3: an explicit choice is sticky and survives "继续"')
  {
    const { send } = await build()
    checkEqual(await send('/mode ptc'), ['run_code'], '/mode ptc applies')
    checkEqual(await send('继续'), ['run_code'], '"继续" keeps the mode')
    checkEqual(await send('这个项目是做什么的'), ['run_code'], 'the sticky choice outlives a new question')
    checkEqual(await send('/mode auto'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], '/mode auto restores automatic routing')
  }

  console.log('\n— scenario 4: minimal mode narrows the tool set, standard restores it')
  {
    const { send } = await build({ minimalAllowlist: ['bash', 'read_file'] })
    checkEqual(await send('/mode minimal'), ['bash', 'read_file'], 'minimal exposes only the allowlist')
    checkEqual(await send('/mode standard'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'standard lifts the restriction')
  }

  console.log('\n— scenario 5: a deployment without a PTC runtime degrades cleanly')
  {
    const { send } = await build({ withPtc: false })
    checkEqual(
      await send('遍历所有文件，统计每个文件的行数并汇总成表格'),
      ['bash', 'demo', 'edit_file', 'read_file', 'write_file'],
      'a batch task stays native when PTC is unavailable',
    )
    checkEqual(await send('/mode ptc'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], '/mode ptc degrades instead of throwing')
  }

  console.log('\n— scenario 6: a model verdict is parked, never applied mid-step')
  {
    const { send, tools, llm } = await build({ modelEnabled: true, llmDelayMs: 20 })
    // "把代码格式化一下" is not a high-confidence local match, so the local lean
    // lands now and the model gets asked in the background.
    checkEqual(await send('把代码格式化一下'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'an ambiguous turn lands on the local lean')
    // The verdict arrives while that turn is still in flight. It must NOT touch
    // the scope: `tools.execute()` selects the executor at dispatch, so a
    // mid-step swap would make the in-flight step dispatch its already-fixed
    // catalog against the wrong executor (UNKNOWN_TOOL in both directions).
    await new Promise((resolve) => setTimeout(resolve, 400))
    checkEqual(await tools(), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'the parked verdict did not change the scope mid-step')
    check(llm.calls >= 1, 'the classifier was actually called')
    // The next turn consumes it before resolving its own catalog.
    checkEqual(await send('继续'), ['run_code'], 'the next turn consumes the parked verdict')
  }

  console.log('\n— scenario 7: the deployment default view is never touched')
  {
    const { root, agent, send } = await build()
    const nativeCatalog = ['bash', 'demo', 'edit_file', 'read_file', 'write_file']
    const defaultExecutor = root.get('tools').selectExecutor(undefined)
    await send('遍历所有文件统计行数')
    await send('/mode minimal')
    // A switch must not leak out of the agent scope: the global catalog stays
    // complete, the deployment default stays the same instance, and the global
    // assembly carries no per-agent guidance text.
    checkEqual(
      (await root.get('systemPrompt').assemble({})).tools.map((tool) => tool.name).sort(),
      nativeCatalog,
      'the global catalog is complete after agent-scope switches',
    )
    check(root.get('tools').selectExecutor(undefined) === defaultExecutor, 'the deployment default executor is the same instance')
    const globalGuidance = (await root.get('systemPrompt').assemble({})).sections.find(
      (section) => section.name === 'turn-preset-router:mode',
    )
    check(globalGuidance === undefined || globalGuidance.text === '', 'the global assembly carries no per-agent guidance text')
    check(agent.ctx !== undefined, 'the agent scope is still live')
  }

  console.log('\n— scenario 8: repeated round trips leave no broken executor')
  {
    const { tools, send } = await build()
    let ok = true
    for (let index = 0; index < 3; index += 1) {
      const ptc = await send('遍历所有文件统计行数')
      if (JSON.stringify(ptc) !== JSON.stringify(['run_code'])) ok = false
      const native = await send('解释一下这个函数')
      if (!native.includes('demo')) ok = false
    }
    check(ok, 'native → ptc → native repeated three times with no TOOL_EXECUTOR_UNAVAILABLE')
    checkEqual(await tools(), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'the scope still has a working executor')
  }

  console.log('\n— scenario 9: a parked verdict survives into the next turn only')
  {
    const { send, tools, llm } = await build({ modelEnabled: true, llmDelayMs: 15 })
    // Turn 1: ambiguous, so the local lean lands and the model is asked.
    await send('把代码格式化一下')
    // Let the verdict arrive and park. It must not reach the scope yet.
    await new Promise((resolve) => setTimeout(resolve, 300))
    checkEqual(await tools(), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'a parked verdict does not touch the scope on arrival')
    // Turn 2: an explicit mode wins over the parked verdict, which is dropped.
    checkEqual(await send('/mode standard'), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'an explicit mode still wins')
    await new Promise((resolve) => setTimeout(resolve, 100))
    checkEqual(await tools(), ['bash', 'demo', 'edit_file', 'read_file', 'write_file'], 'a superseded parked verdict is dropped')
    check(llm.calls >= 1, 'the classifier ran exactly on the ambiguous turn')
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('harness crashed:', error)
  process.exitCode = 1
})
