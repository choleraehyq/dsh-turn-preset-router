/**
 * dsh-turn-preset-router — per-turn agent preset routing for DeepSeek Harness.
 *
 * The Harness picks an Agent's preset composition once, when the session
 * starts, and refuses to change it after the first turn. A real session rarely
 * stays one shape though: a batched migration is followed by "why did that
 * fail?", and a programmatic fan-out is followed by a one-line question.
 *
 * This plugin adds what the composition cannot: a decision, made before every
 * turn, about how that turn's tools should be presented, applied by swapping
 * the Agent scope's tool executor and its prompt guidance. The decision itself
 * has four tiers, in strict priority order:
 *
 *   1. An explicit user choice (`/mode ptc`, "用 ptc 模式") — used and remembered.
 *   2. A continuation ("继续", "ok") — inherits the previous turn's decision.
 *   3. Local rules — high-confidence shapes decide for free, no model call.
 *   4. A small model — only when the local rules are unsure.
 *
 * Every failure path degrades to the configured `defaultMode`; the router never
 * blocks or breaks a turn because classification failed.
 *
 * @module dsh-turn-preset-router
 */

import { normalizeConfig } from './config.js'
import { createRouter, MODE_LABELS, ROUTABLE_MODES, SOURCES, normalizeModeWord } from './router.js'

/** Cordis plugin name. */
export const name = 'dsh-turn-preset-router'

/**
 * Required services. `tools` is what actually carries a mode change; the rest
 * are optional and each is injected where it is needed, so the plugin still
 * loads in a composition that lacks prompts or commands.
 */
export const inject = ['tools']

/** Prompt section carrying the current mode, ordered before plan policy. */
const GUIDANCE_SECTION = 'turn-preset-router:mode'

/** Fallback order used when a deployment names no section to sit before. */
const FALLBACK_SECTION_ORDER = 0

/**
 * Install the router in one composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const router = createRouter(ctx, config)

  const warn = (message) => {
    try {
      ctx.logger?.('turn-preset-router')?.warn?.(message)
    } catch {
      /* logging is best effort */
    }
  }

  // Resolve the PTC executor class once, off the turn path. The turn path is
  // synchronous by design, so this import must not happen there.
  void router.warmUp()

  // ── per-turn entry points ─────────────────────────────────────────────────

  // `inserted` fires from `send()`, which also runs while a step is in flight
  // (a steer, or a followup queued mid-turn), so this is a *decision* point:
  // it records the intent and the optional model refinement, never swaps the
  // executor. Committing here would break the step that is already running —
  // `ToolsService.execute()` re-selects the executor at dispatch time, so the
  // in-flight step would dispatch its fixed catalog against the wrong one.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      router.handleUserMessage(agent, message)
    } catch (error) {
      warn(`inbox routing failed: ${String(error)}`)
    }
  })

  // `claimed` fires from `preStep()` immediately before `tools.resolve()`, so
  // it is the one commit point that is guaranteed to affect the step about to
  // run and unable to affect one already running.
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    try {
      router.handleClaimed(agent)
    } catch (error) {
      warn(`commit failed: ${String(error)}`)
    }
  })

  // Safety net: this runs after the step's tools are fixed, so it can only
  // prepare later turns and cover an Agent the inbox path missed.
  ctx.on('agent/pre-step', (payload, next) => {
    void router
      .handlePreStep(payload.agent, { turn: payload.turn, step: payload.step })
      .catch((error) => warn(`pre-step routing failed: ${String(error)}`))
    return next()
  })

  ctx.on('agent/created', ({ agent }) => {
    void router.bootstrap(agent).catch((error) => warn(`bootstrap failed: ${String(error)}`))
  })

  ctx.on('agent/disposed', ({ agent }) => {
    router.forget(agent)
  })

  // ── prompt guidance ──────────────────────────────────────────────────────

  if (config.guidance) {
    ctx.inject(['systemPrompt'], (scope) => {
      const order =
        typeof scope.systemPrompt.getSectionOrder === 'function'
          ? (scope.systemPrompt.getSectionOrder('PLAN_POLICY') ?? FALLBACK_SECTION_ORDER)
          : FALLBACK_SECTION_ORDER
      scope.systemPrompt.section({
        name: GUIDANCE_SECTION,
        order: Number.isFinite(order) ? order - 1 : FALLBACK_SECTION_ORDER,
        interpolate: false,
        // Re-rendered on every assembly, so the text always describes the mode
        // the current turn is actually running. The assembly context carries
        // the Agent in the real driver path (`assembleContextFor`), and a bare
        // scope-only call simply renders nothing.
        text: (assemble) => {
          const agent = assemble?.agent
          return agent === undefined ? '' : router.guidanceText(agent)
        },
      })
    })
  }

  // ── /mode command ────────────────────────────────────────────────────────

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'mode',
      description:
        '查看或切换本轮执行模式（标准 / PTC / 最小 / 自动）。不带参数查看状态；/mode auto 恢复自动判定。',
      input: { hint: '[standard|ptc|minimal|auto]' },
      handler: async ({ agent, rawInput }) => {
        if (agent === undefined) return { kind: 'error', text: '这个命令需要在一个会话中执行。' }
        const argument = String(rawInput ?? '').trim().toLowerCase()
        if (argument === '') return { kind: 'success', text: router.statusText(agent) }

        const normalized = normalizeModeWord(argument)
        if (normalized === null) {
          return {
            kind: 'error',
            text: '用法：/mode 查看状态；/mode standard|ptc|minimal 手动指定；/mode auto 恢复自动判定。',
          }
        }
        try {
          const result = await router.forceMode(agent, normalized)
          if (normalized === 'auto') {
            return {
              kind: 'success',
              text: `已恢复自动判定：${MODE_LABELS[result.mode] ?? result.mode}\n判定依据：${result.reason}`,
            }
          }
          // Report what actually happened: a parked change has not taken
          // effect yet, and a degraded `minimal` did not narrow anything.
          if (result.deferred === true) {
            return {
              kind: 'success',
              text: `已记录${MODE_LABELS[result.mode] ?? result.mode}：当前步骤仍在执行，将在下一步开始前生效。`,
            }
          }
          const notes = []
          if (result.fallback) notes.push('当前 profile 未挂载 PTC 运行时，已回退为标准模式')
          if (normalized === 'minimal') {
            const degraded = router.inspect(agent).minimalDegraded === true
            if (degraded) notes.push('工具集未能收窄，实际仍可使用完整工具（详见 /mode 状态）')
          }
          const suffix = notes.length > 0 ? `（${notes.join('；')}）` : ''
          return {
            kind: 'success',
            text: `已切换到${MODE_LABELS[result.mode] ?? result.mode}${suffix}，从本轮生效。`,
          }
        } catch (error) {
          return { kind: 'error', text: `切换模式失败：${String(error)}` }
        }
      },
    })
  })

  // ── adopt agents that were already live when the plugin mounted ──────────

  try {
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        void router.bootstrap(agent).catch((error) => warn(`adoption failed: ${String(error)}`))
      }
    }
  } catch {
    // A composition without a live agent registry simply has nothing to adopt.
  }
}

export { MODE_LABELS, ROUTABLE_MODES, SOURCES }
