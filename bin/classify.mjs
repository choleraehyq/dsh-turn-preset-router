#!/usr/bin/env node
/**
 * Offline classifier CLI — inspect what the router would decide for one turn,
 * without booting a Harness.
 *
 *   node bin/classify.mjs "遍历所有文件统计行数"
 *   node bin/classify.mjs --model "解释一下这个函数"
 *   echo "批量发评论" | node bin/classify.mjs
 *
 * It only exercises the *local* half of the router (the same pure rules the
 * plugin runs on every turn). The model half needs a live `ctx.llm`, so it is
 * never called here: `--model` only records that a real session would consult
 * the classifier, which keeps the CLI strictly offline and deterministic.
 */
import { readFileSync } from 'node:fs'

import { classifyLocal, describeLocal } from '../lib/rules.js'
import { isContinuation, parseExplicitMode } from '../lib/messages.js'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

const USAGE = `用法：
  node bin/classify.mjs "任务文本"        打印 JSON 判定（--json 为默认，可省略）
  node bin/classify.mjs --model "任务文本" 附加「真实会话会走模型慢判」的占位说明（本 CLI 不调模型）
  echo "任务文本" | node bin/classify.mjs  从 stdin 读取
  node bin/classify.mjs --text "任务文本"  人类可读输出
  node bin/classify.mjs --defaults        打印归一化后的默认配置
  node bin/classify.mjs --help            显示本帮助

只做本地规则判定，不调用模型、不访问网络。`

const argv = process.argv.slice(2)
const flags = new Set()
const positional = []

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--') {
    positional.push(...argv.slice(index + 1))
    break
  }
  if (arg.startsWith('-') && arg !== '-') {
    flags.add(arg)
  } else {
    positional.push(arg)
  }
}

const knownFlags = new Set([
  '--help',
  '-h',
  '--json',
  '--text',
  '--model',
  '--defaults',
])

for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    console.error(`错误：未知参数 ${flag}\n\n${USAGE}`)
    process.exit(2)
  }
}

if (flags.has('--help') || flags.has('-h')) {
  console.log(USAGE)
  process.exit(0)
}

if (flags.has('--defaults')) {
  console.log(JSON.stringify(normalizeConfig({}), null, 2))
  process.exit(0)
}

/** Read the task text from argv, or from stdin when no positional arg is given. */
function readText() {
  if (positional.length > 0) return positional.join(' ')
  if (process.stdin.isTTY === true) {
    console.error(`错误：没有输入文本。\n\n${USAGE}`)
    process.exit(1)
  }
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const rawText = String(readText() ?? '')
const text = rawText.trim()

if (text === '') {
  console.error(`错误：没有输入文本。\n\n${USAGE}`)
  process.exit(1)
}

const explicit = parseExplicitMode(text)
const continuation = isContinuation(text)
const local = classifyLocal(text, {
  extraPtc: DEFAULTS.extraPtc,
  extraStandard: DEFAULTS.extraStandard,
})
const config = normalizeConfig({})
const modelRequested = flags.has('--model')

// What the plugin would actually land for this turn, in priority order:
// explicit user choice > continuation inheritance > local high confidence >
// local lean (the model refines later, offline we stop at the lean).
const decidedBy =
  explicit !== null ? 'user' : continuation ? 'continue' : local.confidence === 'high' ? 'local' : 'local-lean'
const mode = explicit !== null ? explicit.mode : continuation ? null : local.mode
const reason =
  explicit !== null
    ? explicit.reason
    : continuation
      ? '续写：沿用上一轮判定，不重判、不调模型'
      : describeLocal(local)

const report = {
  text,
  mode,
  decidedBy,
  confidence: explicit !== null ? 'high' : continuation ? null : local.confidence,
  reason,
  local: {
    mode: local.mode,
    confidence: local.confidence,
    score: local.score,
    reasons: local.reasons,
  },
  explicit,
  continuation,
  ...(modelRequested
    ? {
        model: {
          requested: true,
          used: false,
          note: '离线 CLI 只跑本地规则；真实会话中本地不确定时会调用 Flash 慢判，此处不调模型。',
        },
      }
    : {}),
  config: {
    defaultMode: config.defaultMode,
    modelEnabled: config.modelEnabled,
    minimalAllowlist: config.minimalAllowlist,
  },
}

if (flags.has('--text')) {
  console.log(`文本：${report.text}`)
  if (explicit !== null) {
    console.log(`判定：用户显式指定 → ${explicit.mode}（${explicit.reason}）`)
  } else if (continuation) {
    console.log('判定：续写 → 沿用上一轮判定（不重判、不调模型）')
  } else {
    console.log(`本地规则：${describeLocal(local)}`)
    console.log(
      local.confidence === 'high'
        ? `判定：${local.mode}（本地高置信，不调用模型）`
        : `判定：本轮先按 ${local.mode} 落地，慢判结果会改进后续轮次`,
    )
  }
  if (modelRequested) {
    console.log('模型慢判：本次不调用（离线 CLI），真实会话会在本地不确定时调用。')
  }
} else {
  console.log(JSON.stringify(report, null, 2))
}
