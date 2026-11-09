/**
 * Text extraction and per-turn intent parsing for the turn preset router.
 *
 * Everything here is a pure function of message shapes and strings so the
 * routing decisions stay cheap to test and to reason about. Nothing in this
 * module touches a Cordis context, a model, or the filesystem.
 *
 * @module dsh-turn-preset-router/messages
 */

/** Modes this plugin can select for one turn. */
export const MODES = Object.freeze(['standard', 'ptc', 'minimal'])

/**
 * Short replies that continue the open task instead of stating a new one.
 *
 * Kept deliberately narrow: a continuation inherits the previous turn's
 * decision, so a false positive silently skips re-classification for a real
 * new request. The length gate below is the second guard.
 */
const CONTINUATION =
  /^(?:继续|接着|然后呢?|然后|好的?|好|嗯+|可以|行|开始|执行吧?|下一步|来吧|go on|go ahead|continue|ok|okay|yes|yep|sure|next|do it|proceed)$/i

/** Trailing punctuation stripped before the continuation match. */
const TRAILING_PUNCTUATION = /[。.!！?？~～,，、;；:：\s]+$/g

/** Longest text that may still count as a continuation. */
const CONTINUATION_MAX_CHARS = 16

/**
 * Concatenate the text blocks of one message.
 * @param {{content?: readonly unknown[]} | undefined | null} message
 * @returns {string} The trimmed text, or `''` when the message carries none.
 */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Whether a reply continues the open task instead of restating it.
 *
 * An empty reply counts as a continuation: a message with no text (an image
 * attachment, for example) does not restate the task either.
 * @param {string} text
 * @returns {boolean}
 */
export function isContinuation(text) {
  const value = String(text ?? '').trim().replace(TRAILING_PUNCTUATION, '')
  if (value === '') return true
  if ([...value].length > CONTINUATION_MAX_CHARS) return false
  return CONTINUATION.test(value)
}

/**
 * Whether a message is something the user typed (as opposed to an injected
 * plugin note or a tool-produced message).
 * @param {{role?: string, source?: {kind?: string}} | undefined | null} message
 * @returns {boolean}
 */
export function isUserMessage(message) {
  if (!message || message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Pick the task text that best represents what this session is working on.
 *
 * The newest substantive user message wins; short continuations ("继续") fall
 * back to the previous substantive message so a resume keeps the task shape.
 * @param {readonly unknown[]} messages
 * @param {number} [lookback] How many user messages to scan back through.
 * @returns {string} The task text, or `''` when the history holds none.
 */
export function latestTaskText(messages, lookback = 6) {
  if (!Array.isArray(messages)) return ''
  const limit = Number.isFinite(lookback) && lookback > 0 ? Math.floor(lookback) : 6
  const texts = []
  for (let index = messages.length - 1; index >= 0 && texts.length < limit; index -= 1) {
    const message = messages[index]
    if (!isUserMessage(message)) continue
    const text = messageText(message)
    if (text !== '') texts.push(text)
  }
  if (texts.length === 0) return ''
  // A history of nothing but continuations states no task: return `''` so the
  // caller falls back to its own default instead of classifying "继续" as one.
  const substantive = texts.filter((text) => !isContinuation(text))
  if (substantive.length === 0) return ''
  return substantive.find((text) => [...text].length >= 16) ?? substantive[0]
}

/** Imperative verbs that turn a mode mention into an explicit selection. */
const IMPERATIVE_PREFIX =
  /^(?:请|帮我|麻烦|给我)?\s*(?:用|使用|切到|切换到|换到|换成|改成|改到|设为|设置成|设成|开启|启动|进入|走|use|switch\s+to|switch|set\s+to|set|enable|start|go\s+with|go|enter|run\s+in|run)\s*/i

/** A whole-reply mode name, optionally followed by a mode suffix. */
const BARE_MODE =
  /^(standard|ptc|minimal|auto|标准|原生|最小|极简|自动)\s*(?:模式|mode)?$/i

/** Words that mark a question rather than an instruction. */
const QUESTION_MARKER = /(?:什么|为什么|为啥|怎么|如何|多少|哪个|哪些|是否|能不能|可不可以|是不是|吗|呢|\?|？)/i
const QUESTION_MARKER_EN = /\b(?:what|why|how|which|whether|explain|difference|mean)\b/i

/** Mode words mapped to the mode they select. */
const MODE_WORDS = Object.freeze({
  standard: 'standard',
  标准: 'standard',
  原生: 'standard',
  ptc: 'ptc',
  程序化: 'ptc',
  minimal: 'minimal',
  最小: 'minimal',
  极简: 'minimal',
  auto: 'auto',
  自动: 'auto',
})

/** `/mode <value>` and `/preset <value>` command forms. */
const MODE_COMMAND = /^\/(?:mode|preset|router)\s+(\S+)\s*$/i

/** How much text may still count as a bare mode instruction. */
const EXPLICIT_MAX_CHARS = 40

/**
 * Whether a text asks about a mode rather than asking to use it.
 * @param {string} text
 * @returns {boolean}
 */
function isQuestion(text) {
  return QUESTION_MARKER.test(text) || QUESTION_MARKER_EN.test(text)
}

/**
 * Detect an explicit mode selection in one user message.
 *
 * This is the highest-priority routing signal: when the user names a mode, the
 * router uses it and remembers it as a sticky preference. Questions *about* a
 * mode ("解释一下 ptc 模式是什么") are deliberately not selections, which is why
 * the question markers are checked before the imperative forms.
 * @param {string} text
 * @returns {{mode: 'standard'|'ptc'|'minimal'|'auto', reason: string} | null}
 */
export function parseExplicitMode(text) {
  const value = String(text ?? '').trim()
  if (value === '') return null

  // `/mode ptc` is unambiguous: it is a command, never a question.
  const command = MODE_COMMAND.exec(value)
  if (command) {
    const word = command[1].toLowerCase()
    const mode = MODE_WORDS[word]
    if (mode !== undefined) return { mode, reason: `显式命令 /mode ${word}` }
    return null
  }

  if ([...value].length > EXPLICIT_MAX_CHARS) return null
  if (isQuestion(value)) return null

  // A whole reply that is only a mode name ("ptc", "标准模式").
  const bare = BARE_MODE.exec(value.replace(TRAILING_PUNCTUATION, ''))
  if (bare) {
    const mode = MODE_WORDS[bare[1].toLowerCase()]
    if (mode !== undefined) return { mode, reason: `显式指定 ${bare[1]}` }
  }

  // An imperative that names a mode ("用 ptc", "切到标准模式").
  const imperative = IMPERATIVE_PREFIX.exec(value)
  if (imperative) {
    const rest = value.slice(imperative[0].length).replace(TRAILING_PUNCTUATION, '')
    const named = BARE_MODE.exec(rest)
    if (named) {
      const mode = MODE_WORDS[named[1].toLowerCase()]
      if (mode !== undefined) return { mode, reason: `显式指定 ${named[1]}` }
    }
  }

  return null
}
