/**
 * lib/messages.js 单元测试
 *
 * 契约来源：docs/DESIGN.md §3.1 / §5.3 + task-2 中冻结的模块契约。
 * 测试先行：lib/ 可能尚未落地，此时本文件会在 import 阶段失败，属预期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  messageText,
  isContinuation,
  latestTaskText,
  isUserMessage,
  parseExplicitMode,
} from '../lib/messages.js'

const textPart = (t) => ({ type: 'text', text: t })

/** 带 source.kind 的用户消息 */
const userMessage = (t, kind = 'user') => ({
  role: 'user',
  source: { kind },
  content: [textPart(t)],
})

/** 没有 source 的用户消息（source.kind === undefined 也应视为用户） */
const bareUserMessage = (t) => ({ role: 'user', content: [textPart(t)] })

const assistantMessage = (t) => ({ role: 'assistant', content: [textPart(t)] })

// ---------------------------------------------------------------------------
// messageText
// ---------------------------------------------------------------------------

test('messageText: 拼接 text 片段并 trim', () => {
  assert.equal(messageText({ content: [textPart('  hello  ')] }), 'hello')
  assert.equal(messageText({ content: [textPart('\n遍历所有文件\n')] }), '遍历所有文件')
})

test('messageText: 忽略非 text 片段', () => {
  const message = {
    content: [
      { type: 'image', url: 'x.png' },
      textPart('第一段'),
      { type: 'tool_use', name: 'demo' },
    ],
  }
  assert.equal(messageText(message), '第一段')
})

test('messageText: 多段 text 都保留（拼接分隔符未在契约中固定，只断言内容与 trim）', () => {
  const joined = messageText({ content: [textPart('alpha'), textPart('beta')] })
  assert.ok(joined.includes('alpha'), `多段文本丢失 alpha: ${JSON.stringify(joined)}`)
  assert.ok(joined.includes('beta'), `多段文本丢失 beta: ${JSON.stringify(joined)}`)
  assert.equal(joined, joined.trim())
})

test('messageText: 空 content / 无 text 片段返回空串', () => {
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText({ content: [{ type: 'image' }] }), '')
})

// ---------------------------------------------------------------------------
// isContinuation
// ---------------------------------------------------------------------------

test('isContinuation: 空串视为续写', () => {
  assert.equal(isContinuation(''), true)
  assert.equal(isContinuation('   '), true)
})

test('isContinuation: 中文续写词（含尾部标点、前后空白）', () => {
  const positives = [
    '继续',
    '继续。',
    '继续！',
    '接着',
    '然后呢',
    '好的',
    '好的。',
    '好',
    '嗯',
    '嗯嗯',
    '可以',
    '行',
    '开始',
    '执行吧',
    '下一步',
    '  继续  ',
  ]
  for (const input of positives) {
    assert.equal(isContinuation(input), true, `应判为续写: ${JSON.stringify(input)}`)
  }
})

test('isContinuation: 英文续写词', () => {
  const positives = ['go on', 'continue', 'ok', 'okay', 'yes', 'sure', 'next', 'do it']
  for (const input of positives) {
    assert.equal(isContinuation(input), true, `应判为续写: ${JSON.stringify(input)}`)
  }
})

test('isContinuation: 长度边界（≤16 字符且整串匹配续写词）', () => {
  // 契约是「整串匹配」，不是「包含」：长度在 16 字符内、且整串就是一个续写词才命中。
  assert.equal(isContinuation('继续'), true)
  assert.equal(isContinuation('continue'), true)
  assert.equal(isContinuation('go on'), true)
  assert.equal(isContinuation('ok'), true)
  // 去掉尾部标点后整串匹配，所以 "继续，" 命中
  assert.equal(isContinuation('继续，'), true)

  // 重复的续写词不是一句续写指令（整串不匹配正则）
  assert.equal(isContinuation('继续'.repeat(8)), false, '重复续写词不应判为续写')

  // 以续写开头但后面还有实际任务内容 → 不是续写
  assert.equal(isContinuation('继续然后帮我遍历所有文件并统计行数'), false)

  // 超过 16 字符即使整串是英文续写短语也不命中
  assert.equal(isContinuation('continue please now'), false, '19 字符不应判为续写')
})

test('isContinuation: 正常任务/长句不是续写', () => {
  const negatives = [
    '帮我遍历所有文件并统计每个文件的行数',
    '帮我看下这个文件',
    '好的，现在帮我写一个函数来解析配置',
    'continue with the next step please',
    '解释一下这个函数',
    '请继续把剩下的所有文件都处理完成吧', // 17 字符，超长
  ]
  for (const input of negatives) {
    assert.equal(isContinuation(input), false, `不应判为续写: ${JSON.stringify(input)}`)
  }
})

// ---------------------------------------------------------------------------
// isUserMessage
// ---------------------------------------------------------------------------

test('isUserMessage: role 与 source.kind 判定', () => {
  assert.equal(isUserMessage(userMessage('你好')), true)
  assert.equal(isUserMessage(bareUserMessage('你好')), true, 'source 缺失应视为用户消息')
  assert.equal(isUserMessage(assistantMessage('你好')), false)
  assert.equal(isUserMessage(userMessage('系统注入', 'agent')), false)
  assert.equal(isUserMessage({ role: 'user', source: { kind: 'system' }, content: [] }), false)
})

// ---------------------------------------------------------------------------
// latestTaskText
// ---------------------------------------------------------------------------

test('latestTaskText: 跳过"继续"，返回最近的实质任务文本', () => {
  const longTask = '遍历所有文件并统计每个文件的行数'
  const messages = [
    userMessage(longTask),
    assistantMessage('好的，我来处理。'),
    userMessage('继续'),
  ]
  assert.equal(latestTaskText(messages), longTask)
})

test('latestTaskText: 倒序查找，最近一条实质任务优先', () => {
  const messages = [
    userMessage('帮我读一下 docs 目录下的设计文档'),
    assistantMessage('读完了。'),
    userMessage('然后呢'),
  ]
  assert.equal(latestTaskText(messages), '帮我读一下 docs 目录下的设计文档')
})

test('latestTaskText: 优先长度 ≥16 的文本，而不是更近的短句', () => {
  const longTask = '遍历所有文件并统计每个文件的行数'
  const messages = [
    userMessage(longTask),
    userMessage('读一下 docs'),
  ]
  assert.equal(latestTaskText(messages), longTask)
})

test('latestTaskText: 没有 ≥16 的实质文本时回退到最近一条非续写文本', () => {
  assert.equal(latestTaskText([userMessage('读一下 docs')]), '读一下 docs')
})

test('latestTaskText: 只有续写/空文本时返回空串', () => {
  assert.equal(latestTaskText([]), '')
  assert.equal(latestTaskText([userMessage('继续'), userMessage('好的')]), '')
  assert.equal(latestTaskText([userMessage(''), userMessage('继续')]), '')
})

test('latestTaskText: 忽略 assistant 与 source.kind 非 user 的消息', () => {
  const messages = [
    assistantMessage('这是一条足够长的助手消息，绝不应该被当成任务文本返回'),
    userMessage('这是系统注入的足够长的内容，也不应该被当成任务文本', 'system'),
    userMessage('继续'),
  ]
  assert.equal(latestTaskText(messages), '')
})

test('latestTaskText: lookback 限制扫描窗口', () => {
  const longTask = '遍历所有文件并统计每个文件的行数'
  const messages = [userMessage(longTask)]
  for (let i = 0; i < 7; i += 1) messages.push(userMessage('继续'))

  // 默认 lookback=6 只看最后 6 条（都是"继续"），长任务落在窗口外
  assert.equal(latestTaskText(messages), '')
  // 显式放大 lookback 后能看到长任务
  assert.equal(latestTaskText(messages, 8), longTask)
  assert.equal(latestTaskText(messages, 2), '')
})

// ---------------------------------------------------------------------------
// parseExplicitMode — 正例
// ---------------------------------------------------------------------------

const EXPLICIT_POSITIVES = [
  // /mode 命令（DESIGN §3.1）
  ['/mode ptc', 'ptc'],
  ['/mode standard', 'standard'],
  ['/mode minimal', 'minimal'],
  ['/mode auto', 'auto'],
  ['  /mode ptc  ', 'ptc'],
  ['/mode PTC', 'ptc'],
  // 中文祈使式
  ['用ptc', 'ptc'],
  ['用 ptc 模式', 'ptc'],
  ['切到ptc', 'ptc'],
  ['切到 ptc', 'ptc'],
  ['ptc模式', 'ptc'],
  ['用ptc模式', 'ptc'],
  ['用标准', 'standard'],
  ['用标准模式', 'standard'],
  ['标准模式', 'standard'],
  ['切到标准', 'standard'],
  ['用最小', 'minimal'],
  ['最小模式', 'minimal'],
  ['极简模式', 'minimal'],
  ['minimal 模式', 'minimal'],
  // 英文
  ['use ptc', 'ptc'],
  ['Use PTC', 'ptc'],
  ['switch to ptc', 'ptc'],
  ['ptc mode', 'ptc'],
  ['standard mode', 'standard'],
  ['minimal mode', 'minimal'],
  ['auto mode', 'auto'],
]

test('parseExplicitMode: 识别显式模式指令', () => {
  for (const [input, expectedMode] of EXPLICIT_POSITIVES) {
    const result = parseExplicitMode(input)
    assert.ok(result, `应识别为显式模式: ${JSON.stringify(input)}`)
    assert.equal(result.mode, expectedMode, `模式错误: ${JSON.stringify(input)}`)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, `reason 不应为空: ${JSON.stringify(input)}`)
  }
})

test('parseExplicitMode: 整句就是一个模式名也算显式指定（判据见 task-2）', () => {
  const result = parseExplicitMode('ptc')
  assert.ok(result, '整句只是模式名 "ptc" 应判为显式指定')
  assert.equal(result.mode, 'ptc')
})

test('parseExplicitMode: DESIGN §3.1 的 /preset ptc 命令', () => {
  // docs/DESIGN.md §3.1 明确列出 `/preset ptc`，与 task-2 的 /mode 清单存在轻微差异，
  // 这里按 DESIGN（唯一设计事实源）断言；若实现只支持 /mode，请 Lead 裁决。
  const result = parseExplicitMode('/preset ptc')
  assert.ok(result, '/preset ptc 应判为显式指定（DESIGN §3.1）')
  assert.equal(result.mode, 'ptc')
})

// ---------------------------------------------------------------------------
// parseExplicitMode — 反例
// ---------------------------------------------------------------------------

const EXPLICIT_NEGATIVES = [
  // 关键反例：疑问句 / 解释型，不是显式指定
  '解释一下 ptc 模式是什么',
  'ptc 模式是什么',
  '什么是 minimal 模式',
  '怎么切换到 ptc',
  '如何用标准模式',
  '为什么要用 ptc',
  'what is ptc mode',
  'why use standard mode',
  'how do I switch to ptc',
  'ptc 模式和 standard 模式有什么区别',
  // 普通任务文本
  '解释一下这个函数',
  '帮我遍历所有文件',
  '用代码实现一下',
  // 否定/非指令开头
  '我不想要 ptc 模式',
  '不要用 ptc',
  // 空与非法命令
  '',
  '   ',
  '/mode',
  '/mode foo',
]

test('parseExplicitMode: 疑问句与普通文本返回 null', () => {
  for (const input of EXPLICIT_NEGATIVES) {
    const result = parseExplicitMode(input)
    assert.equal(result, null, `不应识别为显式模式: ${JSON.stringify(input)}，实际得到 ${JSON.stringify(result)}`)
  }
})

test('parseExplicitMode: 关键反例「解释一下 ptc 模式是什么」必须为 null', () => {
  assert.equal(parseExplicitMode('解释一下 ptc 模式是什么'), null)
})
