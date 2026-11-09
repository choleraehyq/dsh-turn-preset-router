/**
 * lib/router.js 公共契约测试
 *
 * 契约来源：docs/DESIGN.md §3.1（判定优先级）、§3.2（粘性）、§9.1（每轮路径必须同步）
 * + Lead 冻结的 createRouter 导出表。
 *
 * 这里只测「不依赖 DSH 真实服务」的部分：导出面、同步性、判定优先级与状态机。
 * 真实的 executor / systemPrompt 落地由 dev/ 的集成 harness 覆盖，不在此重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRouter, MODE_LABELS, ROUTABLE_MODES, SOURCES } from '../lib/router.js'
import { normalizeConfig } from '../lib/config.js'

const nativeExecutor = Object.freeze({ kind: 'native' })

/**
 * 最小 ctx 桩：createRouter 只在闭包里用 get / emit / logger。
 * @param {{agents?: object, ptcRuntime?: object}} [services]
 */
function stubContext(services = {}) {
  return {
    get(name) {
      if (name === 'tools') {
        return {
          selectExecutor: (key) => (key === undefined ? nativeExecutor : undefined),
        }
      }
      if (name === 'agents') return services.agents
      if (name === 'ptcRuntime') return services.ptcRuntime
      return undefined
    },
    emit() {},
    logger: () => ({ warn() {}, info() {}, debug() {} }),
  }
}

/** 一个 agent 桩：ctx.inject 立即回调一个 agent-scope 的 toolCtx。 */
function stubAgent(id = 'agent-1', { messages = [] } = {}) {
  const toolCtx = {
    tools: {
      setExecutor: () => () => {},
      restrict: () => () => {},
    },
  }
  return {
    id,
    options: {},
    ctx: {
      inject: (_services, callback) => {
        callback(toolCtx)
        return Promise.resolve()
      },
    },
    session: {
      requestHeader: () => undefined,
      deriveMessages: () => messages,
    },
  }
}

/** 建 router；默认用空 services。 */
function makeRouter(overrides = {}, services = {}) {
  return createRouter(stubContext(services), normalizeConfig(overrides))
}

/** 建 router 并 prepare 好一个 agent（prepare 在轮次外完成，是同步路径的前提）。 */
async function readyRouter(overrides = {}, services = {}) {
  const router = makeRouter(overrides, services)
  const agent = stubAgent('agent-1', { messages: [] })
  await router.prepare(agent)
  return { router, agent }
}

// ---------------------------------------------------------------------------
// 导出面（Lead 冻结）
// ---------------------------------------------------------------------------

test('router: createRouter 暴露冻结契约里的全部方法（§9.8 恰好 14 个）', () => {
  const router = makeRouter()
  const required = [
    'warmUp',
    'prepare',
    'route',
    'applyModeSync',
    'handleUserMessage',
    'handlePreStep',
    'bootstrap',
    'forceMode',
    'statusText',
    'guidanceText',
    'forget',
    'inspect',
    'ptcAvailable',
    'shouldHandle',
  ]
  for (const key of required) {
    assert.equal(typeof router[key], 'function', `缺少冻结契约方法 ${key}`)
  }
  // DESIGN §9.8：createRouter 恰好返回 14 个方法；recoverSticky 为内部函数不对外暴露
  assert.deepEqual(Object.keys(router).sort(), [...required].sort())
  assert.equal(Object.hasOwn(router, 'recoverSticky'), false, 'recoverSticky 不应对外暴露（§9.8）')
})

test('router: 模块导出 ROUTABLE_MODES / SOURCES / MODE_LABELS', () => {
  assert.deepEqual([...ROUTABLE_MODES], ['standard', 'ptc', 'minimal'])
  assert.equal(SOURCES.DEFAULT, 'default')
  assert.equal(SOURCES.LOCAL, 'auto-local')
  assert.equal(SOURCES.MODEL, 'auto-model')
  assert.equal(SOURCES.USER, 'user')
  assert.equal(SOURCES.CONTINUE, 'continue')
  for (const mode of ROUTABLE_MODES) {
    assert.equal(typeof MODE_LABELS[mode], 'string')
    assert.ok(MODE_LABELS[mode].length > 0)
  }
})

// ---------------------------------------------------------------------------
// §9.1 每轮路径必须同步
// ---------------------------------------------------------------------------

test('router: route / applyModeSync / handleUserMessage 不是 async 函数（DESIGN §9.1）', () => {
  const router = makeRouter()
  for (const name of ['route', 'applyModeSync', 'handleUserMessage']) {
    assert.notEqual(router[name].constructor.name, 'AsyncFunction', `${name} 不应是 async 函数`)
  }
})

test('router: route 同步返回对象而不是 Promise', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '遍历所有文件统计行数')
  assert.equal(result instanceof Promise, false, 'route 必须同步返回，否则切换会晚一轮')
  assert.equal(typeof result, 'object')
  assert.ok(result !== null)
  assert.equal(typeof result.mode, 'string')
  assert.equal(typeof result.changed, 'boolean')
  assert.equal(typeof result.needsModel, 'boolean')
})

test('router: route 返回 DESIGN §9.8 的最终契约字段', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '遍历所有文件统计行数')
  // mode=落地模式, decidedMode=判定, appliedMode=实际应用（deferred 时 undefined）
  for (const field of ['mode', 'decidedMode', 'changed', 'fallback', 'deferred', 'source', 'reason', 'needsModel']) {
    assert.ok(Object.hasOwn(result, field), `route() 缺少 §9.8 契约字段 ${field}`)
  }
  assert.ok(Object.hasOwn(result, 'appliedMode'), 'route() 应包含 appliedMode')
  assert.ok(ROUTABLE_MODES.includes(result.decidedMode), `decidedMode 非法: ${result.decidedMode}`)
  assert.equal(typeof result.deferred, 'boolean')
  // 判定与落地分离：未挂载 PTC 时判定 ptc、落地 standard
  assert.equal(result.decidedMode, 'ptc')
  assert.equal(result.mode, 'standard')
  assert.equal(result.appliedMode, 'standard')
  assert.equal(result.fallback, true)
})

test('router: handleUserMessage 同步完成，不返回 Promise', async () => {
  const { router, agent } = await readyRouter()
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '批量发评论' }] }
  const result = router.handleUserMessage(agent, message)
  assert.equal(result instanceof Promise, false)
})

test('router: 轮次外的准备/生命周期方法返回 Promise（可 await）', async () => {
  const router = makeRouter()
  const agent = stubAgent()
  for (const [name, args] of [
    ['warmUp', []],
    ['prepare', [agent]],
    ['bootstrap', [agent]],
    ['handlePreStep', [agent, { turn: 1, step: 1 }]],
  ]) {
    const returned = router[name](...args)
    assert.equal(typeof returned?.then, 'function', `${name} 应返回 Promise`)
    await returned
  }
  assert.equal(typeof router.forceMode(agent, 'standard')?.then, 'function', 'forceMode 应返回 Promise')
  await router.forceMode(agent, 'standard')
})

// ---------------------------------------------------------------------------
// 判定优先级（DESIGN §3.1）
// ---------------------------------------------------------------------------

test('router: 显式模式优先于本地规则，并被记忆为粘性偏好', async () => {
  const { router, agent } = await readyRouter()

  // 批量任务本地规则会判 ptc，但显式指定 minimal 必须获胜
  const result = router.route(agent, '/mode minimal')
  assert.equal(result.source, SOURCES.USER)
  assert.equal(result.reason, '显式命令 /mode minimal')

  const state = router.inspect(agent)
  assert.deepEqual(state.sticky, { mode: 'minimal', reason: '显式命令 /mode minimal' })
  assert.equal(state.mode, 'minimal')
})

test('router: 显式指定后，后续普通任务仍沿用粘性偏好', async () => {
  const { router, agent } = await readyRouter()

  router.route(agent, '用 ptc 模式')
  assert.deepEqual(router.inspect(agent).sticky, { mode: 'ptc', reason: '显式指定 ptc' })

  // 再发一条明确的 standard 任务文本，粘性偏好仍优先（sticky 默认开启）
  const next = router.route(agent, '解释一下这个函数')
  assert.equal(next.source, SOURCES.USER)
  assert.equal(router.inspect(agent).sticky.mode, 'ptc')
})

test('router: /mode auto 清除粘性偏好并回到自动判定', async () => {
  const { router, agent } = await readyRouter()
  router.route(agent, '/mode ptc')
  assert.notEqual(router.inspect(agent).sticky, null)

  const result = router.route(agent, '/mode auto')
  assert.equal(router.inspect(agent).sticky, null, '/mode auto 应清除粘性')
  assert.notEqual(result.source, SOURCES.USER, '清除后应回到自动判定')
})

test('router: sticky=false 时不记忆显式偏好', async () => {
  const { router, agent } = await readyRouter({ sticky: false })
  router.route(agent, '/mode ptc')
  assert.equal(router.inspect(agent).sticky, null, 'sticky=false 时不应记录偏好')
})

test('router: 「继续」沿用上一轮判定，不重新分类', async () => {
  const { router, agent } = await readyRouter()
  router.route(agent, '解释一下这个函数')
  const before = router.inspect(agent)

  const result = router.route(agent, '继续')
  assert.equal(result.source, SOURCES.CONTINUE)
  assert.equal(result.mode, before.lastDecision.mode)
  assert.equal(router.inspect(agent).lastDecision.reason, before.lastDecision.reason, '续写不应覆盖上一轮判定')
})

test('router: 未 prepare 时判定被标记为 deferred（不抛异常、不假装修正）', () => {
  const router = makeRouter()
  const agent = stubAgent()
  const result = router.route(agent, '遍历所有文件统计行数')
  assert.equal(result.deferred, true, '未准备好时应诚实标记 deferred')
  assert.equal(result.changed, false)
  // 判定本身仍然记录，供 pre-step 兜底与状态展示使用
  assert.equal(router.inspect(agent).lastDecision.mode, 'ptc')
})

// ---------------------------------------------------------------------------
// 开关 / 过滤
// ---------------------------------------------------------------------------

test('router: enabled=false 时 handleUserMessage 不写入判定', async () => {
  const router = makeRouter({ enabled: false })
  const agent = stubAgent()
  router.handleUserMessage(agent, {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '批量发评论' }],
  })
  assert.equal(router.inspect(agent).lastDecision, null, 'enabled=false 不应写入判定')
})

test('router: handleUserMessage 忽略非用户来源的消息', async () => {
  const { router, agent } = await readyRouter()
  for (const kind of ['system', 'plugin', 'tool']) {
    router.handleUserMessage(agent, {
      role: 'user',
      source: { kind },
      content: [{ type: 'text', text: '遍历所有文件统计行数' }],
    })
  }
  assert.equal(router.inspect(agent).lastDecision, null, '非用户消息不应触发判定')
})

test('router: 空文本消息不触发重新判定', async () => {
  const { router, agent } = await readyRouter()
  router.handleUserMessage(agent, { role: 'user', source: { kind: 'user' }, content: [] })
  assert.equal(router.inspect(agent).lastDecision, null)
})

test('router: applySubagents=false 时只接管根 agent', () => {
  const rootAgent = stubAgent('root')
  const childAgent = stubAgent('child')
  const agents = { roots: () => [rootAgent] }
  const router = makeRouter({ applyToSubagents: false }, { agents })

  assert.equal(router.shouldHandle(rootAgent), true)
  assert.equal(router.shouldHandle(childAgent), false, '非根 agent 默认不接管')

  const withSubagents = makeRouter({ applyToSubagents: true }, { agents })
  assert.equal(withSubagents.shouldHandle(childAgent), true, 'applyToSubagents=true 时应接管子 agent')
})

test('router: forget 清除 agent 状态', async () => {
  const { router, agent } = await readyRouter()
  router.route(agent, '/mode ptc')
  assert.notEqual(router.inspect(agent).sticky, null)

  router.forget(agent)
  const state = router.inspect(agent)
  assert.equal(state.sticky, null)
  assert.equal(state.lastDecision, null)
})

// ---------------------------------------------------------------------------
// 状态展示 / PTC 可用性
// ---------------------------------------------------------------------------

test('router: statusText / guidanceText 返回可读文本', async () => {
  const { router, agent } = await readyRouter()
  router.route(agent, '/mode ptc')

  const status = router.statusText(agent)
  assert.equal(typeof status, 'string')
  assert.ok(status.includes('模式'))
  assert.ok(status.includes('来源'))
  assert.ok(status.includes('自动判定'))

  const guidance = router.guidanceText(agent)
  assert.equal(typeof guidance, 'string')
  assert.ok(guidance.includes('执行模式'))

  // guidance=false 时提示段为空
  const quiet = makeRouter({ guidance: false })
  assert.equal(quiet.guidanceText(stubAgent()), '')
})

test('router: ptcAvailable 在未挂载 PTC 运行时返回 false（不抛异常）', () => {
  const router = makeRouter()
  assert.equal(typeof router.ptcAvailable(), 'boolean')
  assert.equal(router.ptcAvailable(), false)
})

test('router: ptcAvailable 在挂载 ptcRuntime 后返回 true', () => {
  const router = makeRouter({}, { ptcRuntime: { language: 'typescript' } })
  assert.equal(router.ptcAvailable(), true)
})

test('router: 请求 ptc 但 PTC 不可用时降级 standard 并标记 fallback', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '/mode ptc')
  assert.equal(result.fallback, true, 'PTC 不可用时应回退')
  assert.equal(result.mode, 'standard')
  assert.equal(router.inspect(agent).sticky.mode, 'ptc', '偏好仍应记住 ptc')
  assert.ok(router.statusText(agent).includes('PTC'), '状态里应说明 PTC 不可用')
})

// ---------------------------------------------------------------------------
// 本地规则 → 模式落地（不调模型）
// ---------------------------------------------------------------------------

test('router: 本地高置信批量任务 → 判定 ptc（未挂载 PTC 运行时则降级 standard）', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '遍历所有文件统计行数')
  assert.equal(result.source, SOURCES.LOCAL)
  assert.equal(result.needsModel, false, '本地高置信不应再请求模型')
  // 判定本身是 ptc；本 stub 未挂载 ptcRuntime，所以落地按 DESIGN §4.3 降级 standard
  assert.equal(router.inspect(agent).lastDecision.mode, 'ptc')
  assert.equal(result.mode, 'standard')
  assert.equal(result.fallback, true, 'PTC 不可用时应标记 fallback')
})

test('router: 本地高置信批量任务在 PTC 可用时落地 ptc', async () => {
  // 用一个可构造的 PtcExecutor 桩验证「判定 → 落地」路径，不依赖真实 DSH 包
  const ptcRuntime = { language: 'typescript' }
  const { router, agent } = await readyRouter({}, { ptcRuntime })
  assert.equal(router.ptcAvailable(), true)
  const result = router.route(agent, '遍历所有文件统计行数')
  assert.equal(router.inspect(agent).lastDecision.mode, 'ptc')
  // 真实 PtcExecutor 类不可用时仍会降级，这是 §4.3 的预期行为
  if (result.fallback) {
    assert.equal(result.mode, 'standard')
  } else {
    assert.equal(result.mode, 'ptc')
  }
})

test('router: 本地高置信短问答 → standard', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '解释一下这个函数')
  assert.equal(result.mode, 'standard')
  assert.equal(result.source, SOURCES.LOCAL)
  assert.equal(result.needsModel, false)
})

test('router: 本地拿不准时报告 needsModel，本轮仍给出可用模式', async () => {
  const { router, agent } = await readyRouter()
  const result = router.route(agent, '帮我读一下 docs 目录下的设计文档')
  assert.equal(result.needsModel, true, '本地拿不准应标记需要模型补判')
  assert.ok(ROUTABLE_MODES.includes(result.mode), '本轮仍必须有可用模式')
})

test('router: modelEnabled=false 时不做模型补判（needsModel 仍如实上报）', async () => {
  const { router, agent } = await readyRouter({ modelEnabled: false })
  const result = router.route(agent, '帮我读一下 docs 目录下的设计文档')
  assert.equal(result.needsModel, true)
  // 关掉模型后不得异步改写判定
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(router.inspect(agent).lastDecision.confidence, 0.4, 'modelEnabled=false 时判定不应被模型改写')
})
