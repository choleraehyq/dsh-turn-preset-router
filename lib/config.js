/**
 * Configuration normalization for the turn preset router.
 *
 * Every field is optional in the bundle row, so this module's job is to turn an
 * untrusted YAML object into a complete, validated config without ever letting
 * a malformed value reach the router. Invalid values fall back to their default
 * rather than throwing: a typo in one field must not stop a session from
 * routing, and the defaults are safe.
 *
 * @module dsh-turn-preset-router/config
 */

/** Modes the router can select. */
const MODES = Object.freeze(['standard', 'ptc', 'minimal'])

/**
 * Defaults for every supported field.
 *
 * `defaultMode` is `standard` because it is the composition every deployment
 * is guaranteed to run: PTC needs a mounted runtime, and minimal deliberately
 * hides tools the model may need.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  defaultMode: 'standard',
  provider: '',
  model: 'deepseek-v4-flash',
  modelEnabled: true,
  modelMaxTokens: 256,
  modelTemperature: 0,
  modelTimeoutMs: 8000,
  minimalAllowlist: Object.freeze(['bash', 'read_file', 'write_file', 'edit_file']),
  applyToSubagents: false,
  guidance: true,
  extraPtc: Object.freeze([]),
  extraStandard: Object.freeze([]),
  sticky: true,
})

/** Fields whose value must be one of the three modes. */
const MODE_FIELDS = Object.freeze(['defaultMode'])

/**
 * Read a boolean field.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read a mode field.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function mode(value, fallback) {
  return typeof value === 'string' && MODES.includes(value) ? value : fallback
}

/**
 * Read a string field.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function str(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a positive finite number, falling back when the value is unusable.
 * @param {unknown} value
 * @param {number} fallback
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {number}
 */
function number(value, fallback, bounds = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const min = bounds.min ?? Number.NEGATIVE_INFINITY
  const max = bounds.max ?? Number.POSITIVE_INFINITY
  if (value < min || value > max) return fallback
  return value
}

/**
 * Read a list of non-empty strings.
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @returns {string[]}
 */
function list(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/**
 * Normalize one bundle row config.
 * @param {Record<string, unknown> | undefined | null} raw
 * @returns {{
 *   enabled: boolean,
 *   defaultMode: string,
 *   provider: string,
 *   model: string,
 *   modelEnabled: boolean,
 *   modelMaxTokens: number,
 *   modelTemperature: number,
 *   modelTimeoutMs: number,
 *   minimalAllowlist: string[],
 *   applyToSubagents: boolean,
 *   guidance: boolean,
 *   extraPtc: string[],
 *   extraStandard: string[],
 *   sticky: boolean,
 * }}
 */
export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const normalized = {
    enabled: bool(value.enabled, DEFAULTS.enabled),
    defaultMode: mode(value.defaultMode, DEFAULTS.defaultMode),
    provider: str(value.provider, DEFAULTS.provider),
    model: str(value.model, DEFAULTS.model),
    modelEnabled: bool(value.modelEnabled, DEFAULTS.modelEnabled),
    modelMaxTokens: Math.round(number(value.modelMaxTokens, DEFAULTS.modelMaxTokens, { min: 1, max: 8192 })),
    modelTemperature: number(value.modelTemperature, DEFAULTS.modelTemperature, { min: 0, max: 2 }),
    modelTimeoutMs: Math.round(number(value.modelTimeoutMs, DEFAULTS.modelTimeoutMs, { min: 100, max: 120000 })),
    minimalAllowlist: list(value.minimalAllowlist, DEFAULTS.minimalAllowlist),
    applyToSubagents: bool(value.applyToSubagents, DEFAULTS.applyToSubagents),
    guidance: bool(value.guidance, DEFAULTS.guidance),
    extraPtc: list(value.extraPtc, DEFAULTS.extraPtc),
    extraStandard: list(value.extraStandard, DEFAULTS.extraStandard),
    sticky: bool(value.sticky, DEFAULTS.sticky),
  }
  // An empty allowlist would hide every tool; treat it as "unset".
  if (normalized.minimalAllowlist.length === 0) normalized.minimalAllowlist = [...DEFAULTS.minimalAllowlist]
  // A blank model name is not a valid request; keep the default.
  if (normalized.model.trim() === '') normalized.model = DEFAULTS.model
  return normalized
}

/** Fields this plugin understands, exported for diagnostics and docs parity. */
export const CONFIG_FIELDS = Object.freeze([
  'enabled',
  'defaultMode',
  'provider',
  'model',
  'modelEnabled',
  'modelMaxTokens',
  'modelTemperature',
  'modelTimeoutMs',
  'minimalAllowlist',
  'applyToSubagents',
  'guidance',
  'extraPtc',
  'extraStandard',
  'sticky',
])

export { MODES, MODE_FIELDS }
