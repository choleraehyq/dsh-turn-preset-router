/**
 * Per-turn mode state and the mechanism that applies it.
 *
 * ## Why this module is shaped the way it is
 *
 * The Harness fixes an Agent's preset composition when the session starts, and
 * `agentPresets.select()` refuses to change it once the first turn has begun.
 * What *can* change between turns is the tool executor an Agent scope selects
 * and the prompt sections that describe it. This module owns exactly that pair,
 * so a mode change costs one executor swap rather than a new composition.
 *
 * ## The one window that matters
 *
 * A turn's tool catalog is fixed by `preStep`, which resolves the tool set and
 * assembles the system prompt *before* it runs the awaited `agent/pre-step`
 * waterfall. The only point where a mode change still lands in the current turn
 * is therefore **synchronously inside `agent/inbox/inserted`**, which the inbox
 * emits from `mutate()` before the driver is woken.
 *
 * Two consequences follow, and they explain most of this file's structure:
 *
 * 1. **The turn path is fully synchronous.** Nothing on it awaits: the Agent
 *    scope is prepared ahead of time (`prepare`), the PTC executor class is
 *    pre-imported (`warmUp`), and `applyModeSync` swaps in the same tick. A
 *    single `await` would push the swap past the driver's `preStep` and the
 *    decision would silently apply one turn late.
 * 2. **A model verdict cannot decide its own turn.** `emit` does not await
 *    listeners, so a classifier call necessarily settles after the turn it was
 *    asked for has been assembled. The model therefore refines the *next*
 *    turn, and the local rules own the current one. That is a real limitation,
 *    not an implementation detail, and the docs say so.
 *
 * ## Modes onto mechanism
 *
 * - `standard` selects the deployment's own default executor (normally the
 *   native one). Reusing the captured default instead of constructing a second
 *   native executor keeps the deployment in charge of its own defaults.
 * - `ptc` selects a PTC executor, built from a pre-imported class because the
 *   package is only reachable through the Harness runtime resolver.
 * - `minimal` keeps the default executor and narrows the visible tool set with
 *   `tools.restrict({ allow })`.
 *
 * Every executor swap is a Cordis effect scoped to the Agent, so it unwinds
 * automatically when the Agent is disposed.
 *
 * @module dsh-turn-preset-router/router
 */

import { classifyLocal } from './rules.js'
import { classifyWithModel, resolveRoute } from './classifier.js'
import {
  isContinuation,
  latestTaskText,
  messageText,
  parseExplicitMode,
} from './messages.js'

/** Modes this router can apply, in preference order for diagnostics. */
export const ROUTABLE_MODES = Object.freeze(['standard', 'ptc', 'minimal'])

/** Where the current turn's mode came from, for `/mode` and the logs. */
export const SOURCES = Object.freeze({
  DEFAULT: 'default',
  LOCAL: 'auto-local',
  MODEL: 'auto-model',
  USER: 'user',
  CONTINUE: 'continue',
})

/** Human-readable labels used by `/mode` and the prompt section. */
export const MODE_LABELS = Object.freeze({
  standard: '标准（原生函数调用）',
  ptc: 'PTC（run_code 程序化调用）',
  minimal: '最小（极简工具集）',
})

/**
 * Specifiers tried, in order, when resolving the PTC executor class.
 *
 * A profile bundle reaches `@deepseek-ai/*` through the Harness runtime
 * resolver, which serves the packages this bundle declares as peers. The bare
 * specifier is therefore the normal path; the absolute fallbacks cover a
 * resolver that is not installed (a bare `node` harness in development).
 */
const PTC_SPECIFIERS = Object.freeze(['@deepseek-ai/dsh-tool-executor-ptc'])

/** How long `warmUp` waits for `ptcRuntime` to mount before giving up. */
const PTC_RUNTIME_WAIT_ATTEMPTS = 40
/** Interval between those `ptcRuntime` checks, in milliseconds. */
const PTC_RUNTIME_WAIT_INTERVAL_MS = 100

/** Local-rule confidence that is strong enough to decide a turn without help. */
const CONFIDENT = 'high'

/**
 * Create one router bound to a Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function createRouter(ctx, config) {
  /** Per-Agent state; a WeakMap so disposed Agents are collected. */
  const states = new WeakMap()

  /** The PTC executor class, pre-imported by `warmUp`. */
  let ptcExecutorClass
  /** The in-flight warm-up, so concurrent callers share one import. */
  let ptcWarmUp

  const warn = (message) => {
    try {
      ctx.logger?.('turn-preset-router')?.warn?.(message)
    } catch {
      /* logging is best effort */
    }
  }

  /** Create the empty state record for one Agent. */
  function createState() {
    return {
      /** @type {import('@deepseek-ai/cordis').Context | undefined} */
      toolCtx: undefined,
      /** @type {(() => void) | undefined} */
      disposeExecutor: undefined,
      /** @type {(() => void) | undefined} */
      disposeRestrict: undefined,
      /** @type {string | undefined} */
      appliedMode: undefined,
      /** @type {string} */
      mode: config.defaultMode,
      /** @type {string} */
      source: SOURCES.DEFAULT,
      /** @type {{mode: string, reason: string, confidence: number} | null} */
      lastDecision: null,
      /** @type {{mode: string, reason: string} | null} */
      sticky: null,
      /** @type {{mode: string, reason: string, confidence: number, revision: number} | null} */
      pendingMode: null,
      /**
       * Monotonic counter, bumped by every substantive user task. A verdict or
       * parked mode carries the revision it was decided under, so a result that
       * arrives after a newer task has superseded it can be dropped instead of
       * polluting that newer task's routing.
       */
      taskRevision: 0,
      /**
       * The mode the user asked for, which may differ from `appliedMode` while
       * a change is parked. Reported by `/mode` so the requested and applied
       * states are never conflated.
       */
      requestedMode: undefined,
      /** Why `minimal` could not narrow the tool set, when it could not. */
      minimalDegraded: false,
      /** @type {string | undefined} */
      minimalDegradedReason: undefined,
      /** @type {number | undefined} */
      routedTurn: undefined,
      /** @type {Promise<unknown> | undefined} */
      setup: undefined,
      ready: false,
      failed: false,
      /** @type {Promise<unknown> | undefined} */
      refining: undefined,
    }
  }

  /**
   * Read (and lazily create) one Agent's state.
   * @param {object} agent
   */
  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = createState()
      states.set(agent, state)
    }
    return state
  }

  /** Whether the deployment can run PTC at all. */
  function ptcAvailable() {
    try {
      return ctx.get('ptcRuntime') !== undefined
    } catch {
      return false
    }
  }

  /**
   * Whether this Agent is one the router should manage.
   * @param {object} agent
   */
  function shouldHandle(agent) {
    if (config.applyToSubagents) return true
    try {
      const agents = ctx.get('agents')
      if (agents === undefined) return true
      return agents.roots().some((candidate) => candidate.id === agent.id)
    } catch {
      return true
    }
  }

  /** Read the Agent's derived messages, tolerating a partially built session. */
  function readMessages(agent) {
    try {
      return agent?.session?.deriveMessages?.() ?? []
    } catch {
      return []
    }
  }

  /**
   * Pre-import the PTC executor class once, off the turn path.
   *
   * The class lives in a package that only the Harness runtime resolver can
   * reach from a profile bundle, and resolving it costs an async import. Doing
   * that here keeps `applyModeSync` free of awaits. A failure is recorded and
   * simply makes `ptc` unavailable for the process.
   * @returns {Promise<void>}
   */
  async function warmUp() {
    if (ptcExecutorClass !== undefined) return
    if (ptcWarmUp !== undefined) return ptcWarmUp
    // Do NOT latch a "resolved" flag before the import succeeds, and do NOT
    // bail out when `ptcRuntime` is still absent: a bundle row activates before
    // its sibling services finish mounting, so the very first `apply()` almost
    // always sees the runtime missing. Waiting for it is what makes `ptc` work
    // at all; a runtime this deployment never mounts simply leaves the wait
    // pending, which is harmless because the class is only read on the turn
    // path after `ptcAvailable()` has already returned true.
    const work = (async () => {
      const ready = await waitForPtcRuntime()
      if (!ready) return
      for (const specifier of PTC_SPECIFIERS) {
        try {
          const mod = await import(specifier)
          if (typeof mod.PtcExecutor === 'function') {
            ptcExecutorClass = mod.PtcExecutor
            return
          }
        } catch {
          // try the next specifier; the last failure is reported below
        }
      }
      warn(
        `cannot pre-import the PTC executor (tried ${PTC_SPECIFIERS.join(', ')}); ` +
          'ptc will degrade to standard',
      )
    })()
    ptcWarmUp = work
    try {
      await work
    } finally {
      if (ptcExecutorClass === undefined) ptcWarmUp = undefined
    }
  }

  /**
   * Resolve once `ptcRuntime` is mounted, or after a bounded wait.
   *
   * Polls rather than subscribing because the service registry exposes no
   * "service added" hook a profile bundle can rely on. The bound keeps a
   * deployment without the PTC runtime from holding a pending promise forever
   * in a way that would confuse later diagnostics.
   * @returns {Promise<boolean>} Whether the runtime became available.
   */
  async function waitForPtcRuntime() {
    if (ptcAvailable()) return true
    for (let attempt = 0; attempt < PTC_RUNTIME_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, PTC_RUNTIME_WAIT_INTERVAL_MS))
      if (ptcAvailable()) return true
    }
    return false
  }

  /**
   * Create the Agent-scoped context that owns the executor selection.
   *
   * A bare `agent.ctx` has no service access, so the selection has to be made
   * from a child context that injected `tools` (plus `systemPrompt`, which the
   * PTC executor reads at construction). Idempotent, and always awaited off the
   * turn path: `applyModeSync` requires the result to already exist.
   *
   * `ptcRuntime` is deliberately *not* listed in `inject`: `inject` only fires
   * once every named service exists, and a deployment without the PTC runtime
   * must still route in `standard` mode. The PTC executor's own inject check
   * fails loudly at construction instead, which `buildPtcExecutor` contains.
   * @param {object} agent
   * @returns {Promise<object>} The state record, ready or failed.
   */
  async function prepare(agent) {
    const state = stateOf(agent)
    if (state.ready || state.failed) return state
    if (state.setup !== undefined) return state.setup
    state.setup = (async () => {
      try {
        let injected
        const fiber = agent.ctx.inject(['tools', 'systemPrompt'], (scoped) => {
          injected = scoped
        })
        await fiber
        if (injected === undefined) throw new Error('the tools service is unavailable in the agent scope')
        state.toolCtx = injected
        state.ready = true
      } catch (error) {
        state.failed = true
        warn(`cannot prepare agent ${String(agent?.id)}: ${String(error)}`)
      }
      return state
    })()
    return state.setup
  }

  /**
   * Capture the deployment's default executor.
   *
   * Reused whenever the router returns to `standard`: it is the executor the
   * deployment already chose, and reusing the instance avoids a second native
   * executor drifting from the configured one.
   * @returns {object | undefined}
   */
  function defaultExecutor() {
    try {
      return ctx.get('tools')?.selectExecutor?.(undefined)
    } catch {
      return undefined
    }
  }

  /** Notify other registries that the tool catalog changed. */
  function emitToolsChange() {
    try {
      ctx.emit('tools/change')
    } catch {
      /* notification is best effort */
    }
  }

  /**
   * Tear down the previous selection.
   *
   * Order matters: the restriction is removed before the executor so a scope is
   * never left with a restriction but no executor to apply it to.
   * @param {object} state
   */
  function teardown(state) {
    try {
      state.disposeRestrict?.()
    } catch (error) {
      warn(`disposing the previous tool restriction failed: ${String(error)}`)
    }
    state.disposeRestrict = undefined
    try {
      state.disposeExecutor?.()
    } catch (error) {
      warn(`disposing the previous executor failed: ${String(error)}`)
    }
    state.disposeExecutor = undefined
  }

  /**
   * Build the PTC executor for one Agent scope, or `null` when it cannot be.
   *
   * Callers must have awaited `warmUp` first: this function stays synchronous so
   * it can be used from the turn path.
   * @param {object} state
   * @returns {object | null}
   */
  function buildPtcExecutor(state) {
    if (!ptcAvailable() || ptcExecutorClass === undefined) return null
    try {
      return new ptcExecutorClass(state.toolCtx, {})
    } catch (error) {
      warn(`cannot build the PTC executor: ${String(error)}`)
      return null
    }
  }

  /**
   * Whether a step is currently in flight.
   *
   * `ToolsService.execute()` selects the executor at *dispatch* time rather than
   * reusing the one a step was assembled with, so swapping mid-step makes that
   * step dispatch its already-fixed catalog against the wrong executor
   * (`UNKNOWN_TOOL` in both directions). The turn-boundary projection records
   * the last `step/start` or `step/end`, which is exactly the distinction this
   * needs; `openTurnStartSeq !== null` scopes it to an open turn.
   * @param {object} agent
   * @returns {boolean} True when a step has started and not yet ended.
   */
  function isMidStep(agent) {
    try {
      const agents = ctx.get('agents')
      if (agents === undefined) return false
      const boundary = agents.turnBoundaryOf(agent.session)
      if (boundary === undefined || boundary === null) return false
      return boundary.openTurnStartSeq !== null && boundary.lastStepBoundary?.kind === 'start'
    } catch {
      // Without a readable projection, assume the safe reading is "not mid-step":
      // a missed deferral only delays a mode change by one turn, while a wrong
      // swap breaks an in-flight step.
      return false
    }
  }

  /**
   * Swap the Agent scope's executor (and restriction) to one mode.
   *
   * Fully synchronous, and the caller must have ensured `state.ready`. The next
   * executor is built *before* the current one is torn down, so the scope is
   * never observable without an executor — a concurrent `assemble()` or the
   * driver's own tool resolution would otherwise throw
   * `TOOL_EXECUTOR_UNAVAILABLE`.
   * @param {object} agent
   * @param {string} desired
   * @param {string} source
   * @param {{mode: string, reason: string, confidence: number} | null} decision
   * @returns {{mode: string, changed: boolean, fallback: boolean, deferred: boolean}}
   */
  function applyModeSync(agent, desired, source, decision = null) {
    const state = stateOf(agent)
    const target = ROUTABLE_MODES.includes(desired) ? desired : config.defaultMode
    let fallback = false
    let mode = target
    if (mode === 'ptc' && buildPtcExecutorAvailable() === false) {
      mode = 'standard'
      fallback = true
    }

    state.source = source
    if (decision !== null) state.lastDecision = decision
    state.mode = mode

    // The turn path cannot await, so an unprepared scope simply keeps whatever
    // the composition gave it. Bootstrap prepares every Agent ahead of time;
    // this only bites a turn that races Agent creation.
    if (state.failed || !state.ready || state.toolCtx === undefined) {
      return { mode, changed: false, fallback, deferred: true }
    }

    // `appliedMode` records the *mode*, not the executor kind: `standard` and
    // `minimal` share the default executor but differ by their restriction, so
    // comparing executor kinds would miss the minimal → standard transition and
    // leave the allowlist stuck on the scope.
    if (state.appliedMode === mode) {
      if (mode === 'minimal' && state.disposeRestrict === undefined) applyRestriction(state)
      return { mode, changed: false, fallback, deferred: false }
    }

    // Build first, tear down second: see the method comment.
    let nextExecutor
    if (mode === 'ptc') {
      nextExecutor = buildPtcExecutor(state)
      if (nextExecutor === null) {
        mode = 'standard'
        state.mode = 'standard'
        fallback = true
        if (state.appliedMode === 'standard') return { mode, changed: false, fallback, deferred: false }
      }
    }

    teardown(state)
    try {
      if (nextExecutor !== undefined) {
        state.disposeExecutor = state.toolCtx.tools.setExecutor(nextExecutor)
        state.appliedMode = 'ptc'
      } else {
        applyDefaultExecutor(state)
        if (mode === 'minimal') applyRestriction(state)
        state.appliedMode = mode
      }
      emitToolsChange()
    } catch (error) {
      warn(`applying mode "${mode}" failed for agent ${String(agent?.id)}: ${String(error)}`)
      // Never leave the scope without an executor: restore the default.
      try {
        applyDefaultExecutor(state)
        state.appliedMode = 'standard'
        state.mode = 'standard'
        fallback = true
      } catch (nested) {
        warn(`the default executor could not be restored: ${String(nested)}`)
        state.appliedMode = undefined
      }
    }
    return { mode: state.mode, changed: true, fallback, deferred: false }
  }

  /** Whether a PTC executor can be built right now. */
  function buildPtcExecutorAvailable() {
    return ptcAvailable() && ptcExecutorClass !== undefined
  }

  /**
   * Select the deployment default executor on one Agent scope.
   * @param {object} state
   */
  function applyDefaultExecutor(state) {
    const executor = defaultExecutor()
    if (executor === undefined) throw new Error('the deployment has no default tool executor')
    state.disposeExecutor = state.toolCtx.tools.setExecutor(executor)
  }

  /**
   * Narrow the visible tools for `minimal` mode.
   *
   * An allowlist naming a tool this deployment does not have is a configuration
   * problem, not a routing failure: log it and keep the mode.
   * @param {object} state
   */
  function applyRestriction(state) {
    // `tools.restrict()` rejects an allowlist that names a tool this deployment
    // does not have, which would silently leave the full tool set in place while
    // `/mode minimal` still reports success. Filter to the tools the scope
    // actually knows, and say so, so the mode is never a silent no-op.
    const configured = config.minimalAllowlist
    let allowed = configured
    try {
      const known = state.toolCtx.tools.view?.(state.toolCtx)?.restrictableNames
      if (known instanceof Set) {
        allowed = configured.filter((name) => known.has(name))
        const missing = configured.filter((name) => !known.has(name))
        if (missing.length > 0) {
          warn(`minimal-mode allowlist names unknown tool(s) ${missing.join(', ')}; using [${allowed.join(', ')}]`)
        }
      }
    } catch {
      // A deployment whose view cannot be inspected keeps the configured list.
    }
    if (allowed.length === 0) {
      const reason = `白名单 ${JSON.stringify(configured)} 未匹配到任何工具，工具集未收窄`
      warn(`minimal-mode allowlist matches no tool in this deployment; keeping the full tool set`)
      state.minimalDegraded = true
      state.minimalDegradedReason = reason
      state.disposeRestrict = undefined
      return
    }
    try {
      state.disposeRestrict = state.toolCtx.tools.restrict({ allow: allowed })
      state.minimalDegraded = false
      state.minimalDegradedReason = undefined
    } catch (error) {
      const reason = `工具限制被拒绝：${String(error)}`
      warn(`minimal-mode allowlist was rejected: ${String(error)}`)
      state.minimalDegraded = true
      state.minimalDegradedReason = reason
      state.disposeRestrict = undefined
    }
  }

  /**
   * Decide one turn and apply it, synchronously.
   *
   * Priority order is the product contract:
   *
   *   1. an explicit user choice, which also becomes sticky;
   *   2. a continuation, which inherits the previous decision;
   *   3. the local rules, which decide every turn the model cannot.
   *
   * A model verdict is never awaited here: see the module header for why it
   * cannot decide its own turn. When the local rules are unsure, `needsModel`
   * reports that a background refinement is worth making for the next turn.
   *
   * The result separates the two facts a caller may care about: `mode` is what
   * the router *decided* for this turn, while `appliedMode` is what actually
   * reached the scope. They differ only when the deployment cannot honour the
   * decision (no PTC runtime, or an Agent whose scope was not ready), which
   * `fallback`/`deferred` report.
   * @param {object} agent
   * @param {string} text
   * @returns {{
   *   mode: string, appliedMode: string | undefined, source: string, reason: string,
   *   fallback: boolean, deferred: boolean, changed: boolean, needsModel: boolean,
   * }}
   */
  function route(agent, text) {
    // A disabled router must not write any state: `/mode` and the status
    // command still read the defaults, but automatic routing stands down.
    if (!config.enabled) {
      return {
        mode: config.defaultMode,
        appliedMode: undefined,
        changed: false,
        fallback: false,
        deferred: true,
        source: SOURCES.DEFAULT,
        reason: '路由器已关闭',
        needsModel: false,
      }
    }
    const state = stateOf(agent)

    // 1. An explicit user choice wins outright for this turn.
    //
    // `sticky` controls only whether the choice is *remembered* for later
    // turns; it never suppresses the choice itself. Gating the whole branch on
    // it made `sticky: false` silently ignore "/mode minimal", which reads as a
    // routing bug rather than a preference setting.
    {
      const explicit = parseExplicitMode(text)
      if (explicit !== null) {
        if (explicit.mode === 'auto') {
          state.sticky = null
          const decision = decideLocally(text)
          return finish(commit(agent, decision.mode, decision.source, decision.decision), decision)
        }
        if (config.sticky) state.sticky = { mode: explicit.mode, reason: explicit.reason }
        const applied = commit(agent, explicit.mode, SOURCES.USER, {
          mode: explicit.mode,
          reason: explicit.reason,
          confidence: 1,
        })
        return { ...applied, decidedMode: explicit.mode, source: SOURCES.USER, reason: explicit.reason, needsModel: false }
      }
      if (config.sticky && state.sticky !== null) {
        const applied = commit(agent, state.sticky.mode, SOURCES.USER, {
          mode: state.sticky.mode,
          reason: `沿用用户偏好：${state.sticky.reason}`,
          confidence: 1,
        })
        return { ...applied, decidedMode: state.sticky.mode, source: SOURCES.USER, reason: state.sticky.reason, needsModel: false }
      }
    }

    // 2. A continuation inherits the previous turn's decision.
    //
    // The guard is `lastDecision`, not `appliedMode`: a previous turn may have
    // recorded a decision without a live scope to apply it to (a resume, or a
    // composition whose executor was unavailable), and a continuation must
    // still inherit that decision rather than re-classifying "继续" from scratch.
    if (isContinuation(text) && state.lastDecision !== null) {
      const inherited = state.lastDecision
      return {
        mode: state.appliedMode ?? inherited.mode,
        decidedMode: inherited.mode,
        appliedMode: state.appliedMode,
        changed: false,
        fallback: false,
        deferred: false,
        source: SOURCES.CONTINUE,
        reason: `延续上一轮：${inherited.reason || inherited.mode}`,
        needsModel: false,
      }
    }

    // 3. The local rules decide.
    const decision = decideLocally(text)
    return finish(commit(agent, decision.mode, decision.source, decision.decision), decision)
  }

  /**
   * Apply a mode now, or park it when a step is in flight.
   *
   * This is the single gate every mode change passes through. Parking is not a
   * fallback — it is the correct behaviour for a mid-step decision, because the
   * running step already committed to a tool catalog. The parked mode is
   * committed by the next `agent/inbox/claimed`, which always precedes that
   * step's tool resolution.
   * @param {object} agent
   * @param {string} desired
   * @param {string} source
   * @param {{mode: string, reason: string, confidence: number} | null} decision
   * @returns {{mode: string, changed: boolean, fallback: boolean, deferred: boolean}}
   */
  function commit(agent, desired, source, decision = null) {
    const state = stateOf(agent)
    const target = ROUTABLE_MODES.includes(desired) ? desired : config.defaultMode
    state.requestedMode = target

    if (isMidStep(agent)) {
      state.pendingMode = {
        mode: target,
        reason: decision?.reason ?? '',
        confidence: decision?.confidence ?? 0.5,
        revision: state.taskRevision,
      }
      state.source = source
      if (decision !== null) state.lastDecision = decision
      return { mode: state.appliedMode ?? state.mode, changed: false, fallback: false, deferred: true }
    }
    return applyModeSync(agent, target, source, decision)
  }

  /**
   * Combine an application result with the decision that produced it.
   *
   * `mode` is what actually landed on the scope (so a PTC decision degrades to
   * `standard` when no runtime is mounted, with `fallback: true`), while
   * `decidedMode` keeps the router's own intent. `state.lastDecision` records
   * the decision, so `inspect()` reports intent and `route()` reports effect.
   * @param {{mode: string, changed: boolean, fallback: boolean, deferred: boolean}} applied
   * @param {{mode: string, source: string, reason: string, needsModel: boolean}} decision
   */
  function finish(applied, decision) {
    return {
      mode: applied.mode,
      decidedMode: decision.mode,
      appliedMode: applied.deferred ? undefined : applied.mode,
      changed: applied.changed,
      fallback: applied.fallback,
      deferred: applied.deferred,
      source: decision.source,
      reason: decision.reason,
      needsModel: decision.needsModel,
    }
  }

  /**
   * Apply the local rules to one text.
   *
   * A high-confidence match is final. Anything else still gets a decision — the
   * local lean — but reports `needsModel` so the caller can refine later. A
   * low-confidence result with no evidence at all falls to `defaultMode`, which
   * is the composition the deployment is most likely to have tuned.
   * @param {string} text
   * @returns {{mode: string, source: string, reason: string, decision: object, needsModel: boolean}}
   */
  function decideLocally(text) {
    const local = classifyLocal(text, {
      extraPtc: config.extraPtc,
      extraStandard: config.extraStandard,
    })
    if (local.confidence === CONFIDENT) {
      const reason = local.reasons.join('，') || local.mode
      return {
        mode: local.mode,
        source: SOURCES.LOCAL,
        reason: `本地规则：${reason}`,
        decision: { mode: local.mode, reason, confidence: 0.9 },
        needsModel: false,
      }
    }
    // A neutral text carries no signal at all; the deployment's default is a
    // better guess than an arbitrary local lean.
    const mode = local.confidence === 'low' ? config.defaultMode : local.mode
    const reason = local.reasons.join('，') || '无明显信号'
    return {
      mode,
      source: mode === config.defaultMode && local.confidence === 'low' ? SOURCES.DEFAULT : SOURCES.LOCAL,
      reason: `本地规则（拿不准）：${reason}`,
      decision: { mode, reason, confidence: 0.4 },
      needsModel: true,
    }
  }

  /**
   * Refine the next turn with a model verdict.
   *
   * Runs off the turn path. A verdict is dropped when the user pinned a mode
   * meanwhile, when a newer turn already routed, or when it agrees with what is
   * already applied.
   * @param {object} agent
   * @param {string} text The text the verdict belongs to.
   * @returns {Promise<void>}
   */
  /**
   * Ask the model for a verdict and park it for the next turn.
   *
   * The verdict must **not** be applied here. `ToolsService.execute()` selects
   * the executor at *dispatch* time rather than reusing the one a step was
   * assembled with, so swapping mid-step makes the in-flight step dispatch its
   * already-fixed catalog against the wrong executor — a native catalog then
   * fails with `UNKNOWN_TOOL` because the PTC executor only admits `run_code`,
   * and vice versa. A verdict that arrives while the turn is still streaming is
   * therefore parked in `state.pendingMode` and consumed by the next
   * `agent/inbox/inserted`, which runs before that turn's tool resolution.
   * @param {object} agent
   * @param {string} text The text the verdict belongs to.
   * @returns {Promise<void>}
   */
  async function refine(agent, text, revision) {
    const state = stateOf(agent)
    if (state.refining !== undefined) return
    const work = (async () => {
      const verdict = await askModel(agent, text)
      if (verdict === null) return
      // A user preference or a newer turn may have superseded this verdict.
      // The revision is the load-bearing check: a slow classifier can return
      // after the user has moved on to a different task, and applying its
      // answer would route that newer task by an older task's text.
      if (state.sticky !== null) return
      if (state.taskRevision !== revision) return
      if (state.appliedMode === verdict.mode) return
      state.pendingMode = {
        mode: verdict.mode,
        reason: verdict.reason,
        confidence: verdict.confidence,
        revision,
      }
    })()
    state.refining = work
    try {
      await work
    } finally {
      if (state.refining === work) state.refining = undefined
    }
  }

  /**
   * Consume a parked model verdict, if any.
   *
   * Called at the start of a turn, before its tool catalog is resolved. Returns
   * whether a verdict was applied.
   * @param {object} agent
   * @returns {boolean}
   */
  function consumePendingMode(agent) {
    const state = stateOf(agent)
    const pending = state.pendingMode
    if (pending === undefined || pending === null) return false
    state.pendingMode = null
    if (state.sticky !== null) return false
    // A parked mode decided under an older task is stale by definition: the
    // user has since stated a different task, so its text no longer describes
    // what is about to run.
    if (typeof pending.revision === 'number' && pending.revision !== state.taskRevision) return false
    const applied = applyModeSync(agent, pending.mode, SOURCES.MODEL, {
      mode: pending.mode,
      reason: pending.reason,
      confidence: pending.confidence,
    })
    return applied.changed
  }

  /**
   * Ask the model classifier for one verdict.
   * @param {object} agent
   * @param {string} text
   * @returns {Promise<{mode: string, reason: string, confidence: number} | null>}
   */
  async function askModel(agent, text) {
    const route = resolveRoute(ctx, agent, config)
    if (route.provider === '' || route.model === '') {
      warn('no model route is available; the classifier is skipped')
      return null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs)
    try {
      return await classifyWithModel(ctx, {
        task: text,
        provider: route.provider,
        model: route.model,
        maxTokens: config.modelMaxTokens,
        temperature: config.modelTemperature,
        signal: controller.signal,
      })
    } catch (error) {
      warn(`the model classifier failed: ${String(error)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Handle one new user message.
   *
   * Called from `agent/inbox/inserted`. The decision and the swap both happen
   * synchronously, so they land before the driver wakes; only the optional
   * refinement is deferred.
   * @param {object} agent
   * @param {object} message
   */
  function handleUserMessage(agent, message) {
    if (!config.enabled) return
    if (!agent || !message) return
    if (message.source?.kind !== 'user') return
    if (!shouldHandle(agent)) return
    const text = messageText(message)
    // A message with no text still opens a turn; let it inherit rather than
    // classifying an empty string.
    if (text === '') return

    // `agent/inbox/inserted` fires from `send()`, which also runs while a step
    // is in flight (a steer, or a followup queued mid-turn). It is therefore a
    // *decision* point, not a commit point: record the intent here and let
    // `handleClaimed` apply it when the next step begins.
    const state = stateOf(agent)
    const explicit = config.sticky ? parseExplicitMode(text) : null
    const continuation = explicit === null && isContinuation(text) && state.lastDecision !== null
    if (explicit === null && !continuation) {
      // A substantive new task supersedes anything parked for an older one.
      state.taskRevision += 1
    }

    let result
    try {
      result = route(agent, text)
    } catch (error) {
      warn(`routing failed: ${String(error)}`)
      return
    }
    if (result.needsModel && config.modelEnabled) {
      void refine(agent, text, state.taskRevision).catch((error) =>
        warn(`deferred model routing failed: ${String(error)}`),
      )
    }
  }

  /**
   * Commit a parked mode at the start of a step.
   *
   * `agent/inbox/claimed` fires from `preStep()` immediately before
   * `tools.resolve()`, which is the one moment a mode change is guaranteed to
   * affect the step about to run and cannot affect one already running. Every
   * commit path funnels through here.
   * @param {object} agent
   */
  function handleClaimed(agent) {
    if (!config.enabled) return
    if (!agent || !shouldHandle(agent)) return
    try {
      consumePendingMode(agent)
    } catch (error) {
      warn(`applying a parked mode failed: ${String(error)}`)
    }
  }

  /**
   * Safety net for `agent/pre-step`.
   *
   * This runs after the step's tools are already fixed, so it can only prepare
   * state for later turns and cover an Agent the inbox path missed.
   * @param {object} agent
   * @param {{turn: number, step: number}} position
   * @returns {Promise<void>}
   */
  /**
   * Safety net for `agent/pre-step`.
   *
   * This runs *after* the step's tool catalog is resolved and assembled, and
   * `tools.execute()` selects the executor at dispatch — so swapping here would
   * make the step that this listener is rescuing dispatch its already-fixed
   * catalog against a different executor (`UNKNOWN_TOOL` in both directions).
   * The safety net therefore only *records* a decision; the executor swap
   * happens at the next turn's inbox event, the one point that precedes tool
   * resolution.
   * @param {object} agent
   * @param {{turn: number, step: number}} position
   * @returns {Promise<void>}
   */
  async function handlePreStep(agent, position) {
    if (!config.enabled) return
    if (!shouldHandle(agent)) return
    const state = stateOf(agent)
    if (state.routedTurn === position.turn) return
    state.routedTurn = position.turn
    await prepare(agent)
    if (state.appliedMode !== undefined) return
    const text = latestTaskText(readMessages(agent))
    if (text === '') {
      state.pendingMode = { mode: config.defaultMode, reason: '默认模式（无历史）', confidence: 0 }
      return
    }
    const decision = decideLocally(text)
    state.pendingMode = { ...decision.decision, mode: decision.mode }
    if (decision.needsModel && config.modelEnabled) {
      void refine(agent, text).catch((error) => warn(`deferred model routing failed: ${String(error)}`))
    }
  }

  /**
   * First routing for an Agent that was just created or adopted.
   *
   * Awaits preparation because it is not on a turn's critical path, which is
   * what lets the turn path stay synchronous afterwards.
   * @param {object} agent
   * @returns {Promise<void>}
   */
  async function bootstrap(agent) {
    if (!config.enabled) return
    if (!shouldHandle(agent)) return
    const state = stateOf(agent)
    if (state.ready || state.failed) return
    await prepare(agent)
    // A resumed or forked session must not lose the user's pinned mode. The
    // router's own state is a WeakMap keyed by the Agent object, which a resume
    // replaces; the session log outlives it. Recover from the logged `/mode`
    // commands first so an explicit choice survives the restart.
    const recovered = recoverSticky(agent)
    if (recovered !== null) {
      state.sticky = recovered
      applyModeSync(agent, recovered.mode, SOURCES.USER, {
        mode: recovered.mode,
        reason: `恢复用户偏好：${recovered.reason}`,
        confidence: 1,
      })
      return
    }
    const text = latestTaskText(readMessages(agent))
    if (text === '') {
      applyModeSync(agent, config.defaultMode, SOURCES.DEFAULT)
      return
    }
    route(agent, text)
  }

  /**
   * Recover a sticky mode from the session log.
   *
   * The user's `/mode <value>` choices are logged as `command/run` events, which
   * survive resume and fork. Reading the last one back is what makes the
   * "pinned until /mode auto" promise hold across a restart.
   * @param {object} agent
   * @returns {{mode: string, reason: string} | null}
   */
  function recoverSticky(agent) {
    if (!config.sticky) return null
    let events
    try {
      events = agent?.session?.ownEvents?.() ?? agent?.session?.snapshotEvents?.() ?? []
    } catch {
      return null
    }
    if (!Array.isArray(events)) return null
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'command/run') continue
      const name = event.data?.name
      if (name !== 'mode' && name !== 'preset') continue
      const args = String(event.data?.args ?? '').trim().toLowerCase()
      const mode = normalizeModeWord(args)
      if (mode === null) continue
      if (mode === 'auto') return null
      return { mode, reason: `历史 /mode ${args}` }
    }
    return null
  }

  /**
   * Force a mode from the `/mode` command.
   * @param {object} agent
   * @param {string} mode
   * @returns {Promise<{mode: string, fallback: boolean, reason: string}>}
   */
  async function forceMode(agent, mode) {
    const state = stateOf(agent)
    await prepare(agent)
    if (mode === 'auto') {
      state.sticky = null
      const text = latestTaskText(readMessages(agent))
      const decision = decideLocally(text)
      const applied = applyModeSync(agent, decision.mode, decision.source, decision.decision)
      return { ...applied, reason: decision.reason }
    }
    // Same rule as the text path: `/mode <x>` always applies to this turn, and
    // `sticky` decides only whether it is remembered. Writing the preference
    // unconditionally made `sticky: false` mean two different things depending
    // on which entry point the user took.
    if (config.sticky) state.sticky = { mode, reason: '手动 /mode 指定' }
    const applied = commit(agent, mode, SOURCES.USER, {
      mode,
      reason: '手动 /mode 指定',
      confidence: 1,
    })
    return { ...applied, reason: '手动 /mode 指定' }
  }

  /**
   * A human-readable status block for `/mode` and the logs.
   * @param {object} agent
   * @returns {string}
   */
  function statusText(agent) {
    const state = stateOf(agent)
    const mode = state.appliedMode ?? state.mode ?? config.defaultMode
    const sourceLabel =
      state.source === SOURCES.USER
        ? '用户指定'
        : state.source === SOURCES.LOCAL
          ? '本地规则'
          : state.source === SOURCES.MODEL
            ? '模型判定'
            : state.source === SOURCES.CONTINUE
              ? '延续上一轮'
              : '默认'
    const lines = [
      `模式：${MODE_LABELS[mode] ?? mode}`,
      `来源：${sourceLabel}`,
      `自动判定：${config.enabled ? '开启' : '关闭'}`,
    ]
    // A parked mode is not in effect yet; saying so prevents `/mode` from
    // reporting a switch the next step has not made.
    if (state.pendingMode !== null && state.pendingMode.mode !== mode) {
      lines.push(`待生效：${MODE_LABELS[state.pendingMode.mode] ?? state.pendingMode.mode}（下一步开始前提交）`)
    }
    if (state.sticky !== null) {
      lines.push(`用户偏好：${MODE_LABELS[state.sticky.mode] ?? state.sticky.mode}（/mode auto 恢复自动）`)
    }
    if (state.lastDecision !== null) {
      lines.push(`最近判定：${state.lastDecision.reason || state.lastDecision.mode}`)
    }
    // `minimal` can fail to narrow the tool set; the mode label alone would then
    // claim a restriction that is not in force.
    if (mode === 'minimal' && state.minimalDegraded === true) {
      lines.push(`降级：${state.minimalDegradedReason ?? '工具集未能收窄'}（实际仍是完整工具集）`)
    }
    if (!ptcAvailable()) lines.push('注意：当前 profile 未挂载 PTC 运行时，ptc 会回退为标准模式。')
    return lines.join('\n')
  }

  /**
   * Prompt text describing the current mode, or `''` when guidance is off.
   * @param {object} agent
   * @returns {string}
   */
  function guidanceText(agent) {
    if (!config.guidance) return ''
    const state = stateOf(agent)
    const mode = state.appliedMode ?? state.mode ?? config.defaultMode
    const label = MODE_LABELS[mode] ?? mode
    // The tool-visibility sentence must match reality: a degraded `minimal`
    // still exposes every tool, and telling the model otherwise makes it plan
    // around a restriction that does not exist.
    const toolShape =
      mode === 'ptc'
        ? '当前只暴露 run_code 一个直接工具：把多步、批量或并行的工具调用写成一段程序。'
        : mode === 'minimal'
          ? state.minimalDegraded === true
            ? '注意：minimal 模式未能收窄工具集，当前仍可看到并使用完整工具。'
            : '当前只暴露极少数工具；如果任务需要更多能力，先完成最小目标或提示用户切换模式。'
          : ''
    return (
      `当前执行模式：${label}。该模式由 dsh-turn-preset-router 按任务自动选择，` +
      '用户可以用 /mode 指定，也可以用 /mode auto 恢复自动判定。' +
      toolShape
    )
  }

  /** Forget one Agent's state. */
  function forget(agent) {
    states.delete(agent)
  }

  /** Read-only state snapshot, for tests and diagnostics. */
  function inspect(agent) {
    // Read without creating: inspecting a forgotten Agent must report "nothing
    // known" rather than resurrecting a fresh default state.
    const state = states.get(agent)
    if (state === undefined) {
      return { mode: undefined, source: undefined, sticky: null, lastDecision: null, ready: false, failed: false }
    }
    return {
      mode: state.appliedMode ?? state.mode,
      source: state.source,
      sticky: state.sticky,
      lastDecision: state.lastDecision,
      ready: state.ready,
      failed: state.failed,
      // Requested vs applied, and the degradation flag, are what let `/mode`
      // report a parked change or a failed restriction instead of claiming a
      // switch that did not happen.
      requestedMode: state.requestedMode,
      pendingMode: state.pendingMode === null ? null : { ...state.pendingMode },
      minimalDegraded: state.minimalDegraded === true,
      minimalDegradedReason: state.minimalDegradedReason,
      taskRevision: state.taskRevision,
    }
  }

  return {
    warmUp,
    prepare,
    route,
    applyModeSync,
    handleUserMessage,
    handleClaimed,
    handlePreStep,
    bootstrap,
    forceMode,
    statusText,
    guidanceText,
    forget,
    inspect,
    ptcAvailable,
    shouldHandle,
  }
}

/**
 * Map a `/mode` argument to a mode id, accepting the Chinese names too.
 * @param {string} argument
 * @returns {string | null}
 */
export function normalizeModeWord(argument) {
  const value = String(argument ?? '').trim().toLowerCase()
  if (ROUTABLE_MODES.includes(value)) return value
  switch (value) {
    case 'auto':
    case '自动':
      return 'auto'
    case '标准':
    case '原生':
    case 'native':
      return 'standard'
    case '程序化':
      return 'ptc'
    case '最小':
    case '极简':
      return 'minimal'
    default:
      return null
  }
}
