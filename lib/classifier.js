/**
 * The slow half of the router: one small model call that picks a mode.
 *
 * The local rules handle the obvious turns for free, so this classifier only
 * runs when they are unsure. It asks a cheap model for a single JSON object and
 * treats *every* failure — no provider, timeout, API error, unparsable reply —
 * as "no opinion", never as a routing decision. The caller falls back to the
 * configured default, which keeps a broken classifier from breaking a session.
 *
 * @module dsh-turn-preset-router/classifier
 */

/** Modes the classifier may return. */
const ROUTABLE_MODES = Object.freeze(['standard', 'ptc', 'minimal'])

/** Longest reason kept from the model's reply. */
const MAX_REASON_CHARS = 300

/** Longest task text sent to the classifier. */
const MAX_TASK_CHARS = 8000

/**
 * Build the classifier system prompt.
 *
 * Kept short on purpose: a small model with a tight, explicit output contract
 * is more reliable than a long rubric. This call never blocks a turn — its
 * verdict lands after the turn that asked for it — so latency matters less than
 * the reply being reliably parseable.
 * @returns {string}
 */
export function buildClassifierSystem() {
  return [
    '你是 DeepSeek Harness 的模式路由器。根据用户这一轮的任务，选择最适合的执行模式。',
    '',
    '可选模式（必须严格使用下列 id）：',
    '- standard: 标准模式。原生函数调用，每个工具一份 schema。适合简单问答、解释、单个动作、少量工具调用、需要人机来回确认的任务。',
    '- ptc: 程序化工具调用。模型写一段 TypeScript 程序，程序内通过生成的 SDK 调用任意工具。适合批量/遍历/逐项处理、并行 fan-out、大量循环、批处理写操作（如批量发评论）、脚本化流水线、需要在大结果集上加工筛选的任务。',
    '- minimal: 极简模式。只暴露极少数工具。适合只需跑一条命令或做一次极小改动的请求。',
    '',
    '判断规则：',
    '- 明显是批量、遍历、并行、大量循环、批处理、脚本化 → ptc',
    '- 单个简单问答、寒暄、解释、单次读写、一次命令 → standard',
    '- 明确要求最小工具集，或只要跑一条命令 → minimal',
    '- 拿不准时选 standard',
    '',
    '只输出一个 JSON 对象，不要输出任何其他内容、不要用 markdown 代码围栏：',
    '{"mode":"standard|ptc|minimal","reason":"一句话中文理由","confidence":0到1的数字}',
  ].join('\n')
}

/**
 * Strip a surrounding markdown code fence from a model reply.
 * @param {string} text
 * @returns {string}
 */
function stripFence(text) {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

/**
 * Parse the classifier's reply into a decision.
 *
 * Tolerates markdown fences and surrounding prose. An unknown or missing mode
 * falls back to `fallbackMode`; a malformed reply yields a decision with
 * `confidence: 0` so the caller can tell it was a guess.
 * @param {string} text Raw model reply.
 * @param {string} fallbackMode Mode to use when the reply names none.
 * @returns {{mode: string, reason: string, confidence: number}}
 */
export function parseClassification(text, fallbackMode) {
  const fallback = ROUTABLE_MODES.includes(fallbackMode) ? fallbackMode : 'standard'
  const cleaned = stripFence(String(text ?? ''))
  if (cleaned === '') return { mode: fallback, reason: '', confidence: 0 }

  // Prefer the first balanced-looking JSON object in the reply.
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) {
    return { mode: fallback, reason: '', confidence: 0 }
  }
  let value
  try {
    value = JSON.parse(cleaned.slice(first, last + 1))
  } catch {
    return { mode: fallback, reason: '', confidence: 0 }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { mode: fallback, reason: '', confidence: 0 }
  }

  const rawMode = typeof value.mode === 'string' ? value.mode.trim().toLowerCase() : ''
  const mode = ROUTABLE_MODES.includes(rawMode) ? rawMode : fallback
  const rawReason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const reason = rawReason.length > MAX_REASON_CHARS ? `${rawReason.slice(0, MAX_REASON_CHARS)}…` : rawReason
  const rawConfidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? value.confidence : 0
  const confidence = Math.min(1, Math.max(0, rawConfidence))
  return { mode, reason, confidence }
}

/**
 * Resolve the provider/model route for the classifier call.
 *
 * Preference order, most specific first:
 *   1. explicit plugin config,
 *   2. the agent's own options,
 *   3. the session's current request header,
 *   4. the deployment default model selection,
 *   5. the first registered provider (last resort).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agent
 * @param {{provider?: string, model?: string}} config
 * @returns {{provider: string, model: string}}
 */
export function resolveRoute(ctx, agent, config) {
  let provider = typeof config.provider === 'string' ? config.provider : ''
  let model = typeof config.model === 'string' ? config.model : ''

  const readAgent = () => {
    try {
      const header = agent?.session?.requestHeader?.()?.config
      return { header, options: agent?.options ?? {} }
    } catch {
      return { header: undefined, options: {} }
    }
  }

  if (provider === '' || model === '') {
    const { header, options } = readAgent()
    if (provider === '') provider = options.provider ?? header?.provider ?? ''
    if (model === '') model = options.model ?? header?.model ?? ''
  }

  if (provider === '') {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (typeof selection?.provider === 'string') provider = selection.provider
      if (model === '' && typeof selection?.model === 'string') model = selection.model
    } catch {
      // agentDefaultModel is optional in minimal compositions
    }
  }

  if (provider === '') {
    try {
      const providers = ctx.llm?.listProviders?.() ?? []
      provider = providers[0]?.id ?? ''
    } catch {
      // the registry may be absent while the deployment is still starting
    }
  }

  return { provider, model }
}

/**
 * Run one classifier call.
 *
 * Returns `null` — never throws — when the call cannot produce a usable
 * verdict, so the caller can apply its own fallback policy.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   task: string,
 *   provider: string,
 *   model: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{mode: string, reason: string, confidence: number} | null>}
 */
export async function classifyWithModel(ctx, options) {
  const { provider, model } = options
  if (provider === '' || model === '') return null
  const task = String(options.task ?? '').slice(0, MAX_TASK_CHARS)
  if (task.trim() === '') return null

  const createUserMessage = await loadCreateUserMessage()
  if (createUserMessage === null) return null

  let text = ''
  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      system: buildClassifierSystem(),
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: task }],
          source: { kind: 'plugin', plugin: 'dsh-turn-preset-router' },
        }),
      ],
      temperature: typeof options.temperature === 'number' ? options.temperature : 0,
      maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 256,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') return null
        break
      }
    }
  } catch {
    return null
  }

  if (text.trim() === '') return null
  return parseClassification(text, 'standard')
}

/**
 * Load the harness's `createUserMessage` helper without a static import.
 *
 * A profile bundle is loaded by the Harness runtime resolver, not by a package
 * manager, so a static `@deepseek-ai/dsh-llm` import would fail outside that
 * resolver. The message shape is also trivially constructible, so the fallback
 * keeps the classifier working even when the module cannot be reached.
 * @returns {Promise<((input: object) => object) | null>}
 */
async function loadCreateUserMessage() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') return mod.createUserMessage
  } catch {
    // fall through to the structural message below
  }
  return (input) => ({ role: 'user', content: input.content, source: input.source })
}

export { ROUTABLE_MODES, MAX_REASON_CHARS, MAX_TASK_CHARS }
