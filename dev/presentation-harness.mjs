/**
 * Minimal round-trip spike for the executor swap.
 *
 * The router's whole design rests on one property: an Agent scope can move
 * between the deployment's default executor and a PTC executor repeatedly,
 * synchronously, without ever being observable without an executor. This spike
 * isolates exactly that property — no routing, no messages, no model — so a
 * Harness upgrade that breaks it fails here first, with a clear message.
 *
 * Run: node dev/presentation-harness.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as SP from '@deepseek-ai/dsh-system-prompt'
import * as T from '@deepseek-ai/dsh-tools'
import * as NAT from '@deepseek-ai/dsh-tool-executor-native'
import * as PTC from '@deepseek-ai/dsh-tool-executor-ptc'
import { createScope } from '@deepseek-ai/dsh-scope'

let failures = 0
function check(condition, message) {
  if (condition) {
    console.log(`ok   - ${message}`)
  } else {
    failures += 1
    console.error(`FAIL - ${message}`)
  }
}

class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'spike' }
  }
  resolve(request) {
    return { ...request, cwd: process.cwd() }
  }
  async run() {
    return { value: null, logs: [], error: undefined }
  }
}

const DEMO = {
  name: 'demo_tool',
  description: 'A demo tool.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async () => ({ ok: true }),
}

async function main() {
  const root = new Context()
  root.logger = { warn: (message) => console.log(`[warn] ${message}`) }

  await root.plugin(SP.SystemPrompt, { personaPrefix: '' })
  await root.plugin(FakePtcRuntime)
  await root.plugin(T.ToolsService, {})
  await root.plugin(NAT)
  const tools = root.get('tools')
  tools.register(DEMO)

  const agent = { id: 'spike-agent', session: { deriveMessages: () => [] } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx

  // The router's own preparation step: a child context that can see tools.
  let toolCtx
  await agent.ctx.inject(['tools', 'systemPrompt'], (scoped) => {
    toolCtx = scoped
  })
  check(toolCtx !== undefined, 'the agent scope exposes tools and systemPrompt')

  // Capture the deployment default once, exactly like the router does.
  const deploymentDefault = tools.selectExecutor(undefined)
  const defaultKind = deploymentDefault?.constructor?.name
  // The round trip is only meaningful when the deployment default is native.
  // A profile that mounts the PTC executor as its default would make
  // "native → ptc → native" a ptc → ptc → ptc no-op, so every assertion below
  // would pass without proving anything. Skip loudly rather than report a
  // false positive.
  if (defaultKind !== 'NativeToolExecutor') {
    console.error(
      `SKIP - the deployment default is ${String(defaultKind)}, not NativeToolExecutor; ` +
        'the native↔ptc round trip cannot be proven in this composition. ' +
        'Mount @deepseek-ai/dsh-tool-executor-native as the default to run this spike.',
    )
    process.exitCode = 2
    return
  }
  check(defaultKind === 'NativeToolExecutor', 'the deployment default is the native executor')

  const view = async () => (await root.get('systemPrompt').assemble({ agent, scope: agent })).tools.map((tool) => tool.name)
  check(JSON.stringify(await view()) === JSON.stringify(['demo_tool']), 'native mode lists the real tool')

  let disposer
  for (let round = 1; round <= 3; round += 1) {
    // native → ptc. The previous selection must be disposed first: one
    // executor per scope is a hard invariant of the tools service.
    disposer?.()
    disposer = toolCtx.tools.setExecutor(new PTC.PtcExecutor(toolCtx, {}))
    const ptcView = await view()
    check(JSON.stringify(ptcView) === JSON.stringify(['run_code']), `round ${round}: ptc lists only run_code`)

    // ptc → native, by re-selecting the captured deployment default rather than
    // constructing a second native executor.
    disposer?.()
    disposer = toolCtx.tools.setExecutor(deploymentDefault)
    const nativeView = await view()
    check(nativeView.includes('demo_tool'), `round ${round}: native lists the real tool again`)

    // No window where the scope has no executor: reading the selected executor
    // right after the swap must always succeed.
    let selected
    try {
      selected = tools.selectExecutor(agent)
      check(selected !== undefined, `round ${round}: the scope always has an executor`)
    } catch (error) {
      check(false, `round ${round}: selecting the executor threw ${String(error)}`)
    }
  }

  disposer?.()
  await scope.dispose()
  console.log(failures === 0 ? '\nspike passed' : `\n${failures} spike failure(s)`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('spike crashed:', error)
  process.exitCode = 1
})
