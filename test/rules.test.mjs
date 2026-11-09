/**
 * lib/rules.js 单元测试
 *
 * 契约来源：docs/DESIGN.md §4.1（本地快速规则）+ task-2 冻结契约。
 * 每类信号都断言 mode 与 confidence 两件事，并覆盖短问答 / 长任务描述两条关键启发式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyLocal } from '../lib/rules.js'

const ROUTABLE = ['standard', 'ptc', 'minimal']
const CONFIDENCE = ['high', 'medium', 'low']

/**
 * 断言一次本地判定的完整形状，并返回结果便于追加断言。
 * @param {string} text
 * @param {{mode: string, confidence: string}} expected
 * @param {object} [options]
 */
function expectDecision(text, expected, options) {
  const result = classifyLocal(text, options)
  assert.deepEqual(Object.keys(result).sort(), ['confidence', 'mode', 'reasons', 'score'], '返回结构必须是 {mode, confidence, score, reasons}')
  assert.ok(ROUTABLE.includes(result.mode), `非法 mode: ${result.mode}`)
  assert.ok(CONFIDENCE.includes(result.confidence), `非法 confidence: ${result.confidence}`)
  assert.equal(typeof result.score, 'number')
  assert.ok(Array.isArray(result.reasons))
  for (const reason of result.reasons) assert.equal(typeof reason, 'string')
  assert.equal(result.mode, expected.mode, `mode 不符: ${JSON.stringify(text)}，reasons=${JSON.stringify(result.reasons)}`)
  if (expected.confidence !== undefined) {
    assert.equal(
      result.confidence,
      expected.confidence,
      `confidence 不符: ${JSON.stringify(text)}，reasons=${JSON.stringify(result.reasons)}`,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// 明确 PTC（DESIGN §4.1 第一组信号）
// ---------------------------------------------------------------------------

test('rules: 批量/遍历信号 → ptc', () => {
  expectDecision('请遍历所有文件，统计每个文件的行数并汇总成表格', { mode: 'ptc', confidence: 'high' })
  expectDecision('请帮我批量处理这些数据，处理完之后把结果整理成报告', { mode: 'ptc' })
  expectDecision('请把所有文件都检查一遍，把不符合规范的地方都改掉', { mode: 'ptc' })
  expectDecision('请逐个处理这些文件，每个文件都要加上统一的头部注释', { mode: 'ptc' })
  expectDecision('请逐一检查每个接口的返回值，把不一致的地方都列出来', { mode: 'ptc' })
  expectDecision('请对每一个模块都做一次代码审查，并记录发现的问题', { mode: 'ptc' })
})

test('rules: 批处理 / 批量发评论 等批量写操作 → ptc high', () => {
  // task-2 与 DESIGN §4.1 都点名的关键样例
  expectDecision('批量发评论给这些用户', { mode: 'ptc', confidence: 'high' })
  expectDecision('请批量提交这些表单，提交完成后统计成功率', { mode: 'ptc', confidence: 'high' })
  expectDecision('请批量创建用户账号，创建完成后把密码导出', { mode: 'ptc', confidence: 'high' })
  expectDecision('请批量更新这些记录的状态字段', { mode: 'ptc', confidence: 'high' })
  expectDecision('请批处理这些图片，统一压缩到指定尺寸之后再上传', { mode: 'ptc' })
})

test('rules: 并行/并发信号 → ptc high（DESIGN §4.1 明确 PTC）', () => {
  expectDecision('请并行执行这三个任务，全部完成之后把结果合并起来', { mode: 'ptc', confidence: 'high' })
  expectDecision('请并发请求这些接口，然后把返回的数据合并成一份', { mode: 'ptc', confidence: 'high' })
  expectDecision('请同时执行所有步骤，最后汇总每一步的耗时', { mode: 'ptc', confidence: 'high' })
  expectDecision('please run these tasks in parallel and merge the results', { mode: 'ptc', confidence: 'high' })
  expectDecision('please run the jobs concurrently and collect the output', { mode: 'ptc', confidence: 'high' })
})

test('rules: 英文并行信号不被「单个动作」规则吃掉（DESIGN §9.7 修正 1）', () => {
  // 回归：这些文本曾因 STANDARD_RULES 的「单个动作」动词开头命中而跌到 standard/low
  for (const text of [
    'run these in parallel',
    'run the jobs concurrently',
    'run in parallel',
    'read these files in parallel',
  ]) {
    expectDecision(text, { mode: 'ptc', confidence: 'high' })
  }
  // 回归：无并行信号时单动作仍必须 standard，不能被负向前瞻误伤
  for (const text of ['run the tests', 'read this file', 'open the file', 'list the files']) {
    expectDecision(text, { mode: 'standard', confidence: 'high' })
  }
})

test('rules: 短指令惩罚不抵消强 PTC 信号（DESIGN §9.7 修正 2）', () => {
  // 'run these in parallel' 只有 20 字符；短文本惩罚曾把它从 high 拉成 medium
  const result = classifyLocal('run these in parallel')
  assert.equal(result.mode, 'ptc')
  assert.equal(result.confidence, 'high', `强 PTC 信号不应被短指令惩罚拉低: reasons=${JSON.stringify(result.reasons)}`)
  // 但短疑问句仍应保留 standard high（短问答惩罚是 standard 场景，不是误伤）
  assert.equal(classifyLocal('为什么报错').confidence, 'high')
  assert.equal(classifyLocal('什么是闭包').mode, 'standard')
})

test('rules: 大量循环/重复执行信号 → ptc', () => {
  expectDecision('请大量循环处理这些数据，直到所有记录都处理完成', { mode: 'ptc' })
  expectDecision('请循环 1000 次执行这个操作，并记录每次的结果', { mode: 'ptc' })
  expectDecision('请把这个脚本跑 100 遍，看看平均耗时是多少', { mode: 'ptc' })
  expectDecision('请重复执行这个命令，直到返回成功为止', { mode: 'ptc' })
})

test('rules: 脚本化/流水线/编排信号 → ptc', () => {
  expectDecision('请写个脚本自动化这个流程，以后每天定时跑一次', { mode: 'ptc' })
  expectDecision('请把整个流程编排成一个 pipeline，按顺序执行', { mode: 'ptc' })
})

test('rules: 全仓/全库范围信号 → ptc', () => {
  expectDecision('请在全仓范围内搜索这个符号，找出所有引用位置', { mode: 'ptc' })
  expectDecision('请把整个仓库重构一遍，统一代码风格', { mode: 'ptc' })
  expectDecision('please rename this symbol across the whole repo', { mode: 'ptc' })
  expectDecision('please search the entire repo for this pattern', { mode: 'ptc' })
})

test('rules: 数据加工强信号 → ptc', () => {
  expectDecision('请解析这些日志文件，统计汇总每个接口的调用次数', { mode: 'ptc' })
  expectDecision('请把这些文件批量转换成新的格式并校验结果', { mode: 'ptc' })
})

test('rules: 英文批量信号（batch/bulk/for each/iterate/loop over）→ ptc', () => {
  expectDecision('please batch process all the files and then report the results', { mode: 'ptc' })
  expectDecision('please bulk update these records in the database', { mode: 'ptc' })
  expectDecision('for each item in the list, fetch the details and merge them', { mode: 'ptc' })
  expectDecision('every file needs a license header added at the top', { mode: 'ptc' })
  expectDecision('iterate over the list and collect the failures', { mode: 'ptc' })
  expectDecision('loop over all records and aggregate the totals', { mode: 'ptc' })
})

// ---------------------------------------------------------------------------
// 明确 standard（DESIGN §4.1 第二组信号）
// ---------------------------------------------------------------------------

test('rules: 解释型 → standard high', () => {
  // task-2 点名的关键样例
  expectDecision('解释一下这个函数', { mode: 'standard', confidence: 'high' })
  expectDecision('解释一下这个函数的作用', { mode: 'standard', confidence: 'high' })
  expectDecision('解释一下这个函数的作用，顺便说说为什么这么写', { mode: 'standard', confidence: 'high' })
  expectDecision('说明一下这段代码的实现思路和可能的边界情况', { mode: 'standard', confidence: 'high' })
  expectDecision('介绍一下这个项目的整体架构，以及各个模块的职责', { mode: 'standard', confidence: 'high' })
  expectDecision('这两个函数有什么区别，分别适合什么场景', { mode: 'standard', confidence: 'high' })
})

test('rules: 寒暄 → standard high', () => {
  // task-2 点名的关键样例
  expectDecision('你好', { mode: 'standard', confidence: 'high' })
  expectDecision('谢谢', { mode: 'standard', confidence: 'high' })
  expectDecision('hi', { mode: 'standard', confidence: 'high' })
  expectDecision('thanks', { mode: 'standard', confidence: 'high' })
  expectDecision('hello', { mode: 'standard', confidence: 'high' })
  expectDecision('好的', { mode: 'standard', confidence: 'high' })
  expectDecision('ok', { mode: 'standard', confidence: 'high' })
})

test('rules: 短文本 + 疑问词 → standard high', () => {
  // DESIGN §4.1：短文本 + 疑问词是明确 standard 信号
  for (const text of ['什么是闭包', '这个函数为什么这么写', '为什么报错', '这是怎么回事', '这个怎么改']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'standard', `应判 standard: ${text}`)
    assert.equal(result.confidence, 'high', `短问答应为 high: ${text}，reasons=${JSON.stringify(result.reasons)}`)
  }
  for (const text of ['how does this work', 'what is a closure', 'what is this']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'standard', `应判 standard: ${text}`)
    assert.equal(result.confidence, 'high', `英文短问答应为 high: ${text}`)
  }
})

test('rules: 单动作（帮我看下/读一下/打开）→ standard', () => {
  for (const text of ['帮我看下 README 第一段', '读一下 docs 目录下的设计文档', '打开这个文件', '运行一下这个测试']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'standard', `单动作应判 standard: ${text}`)
    assert.ok(['high', 'medium'].includes(result.confidence), `单动作至少 medium: ${text}`)
  }
})

// ---------------------------------------------------------------------------
// minimal（medium）
// ---------------------------------------------------------------------------

test('rules: minimal 关键词 → minimal medium', () => {
  for (const text of ['最小模式', '极简模式', '用最小模式', 'minimal mode', 'minimal toolset', '只要一个工具', '最少工具']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'minimal', `应判 minimal: ${text}`)
    assert.equal(result.confidence, 'medium', `minimal 应为 medium: ${text}`)
  }
  expectDecision('请用最小模式处理，只需要跑一条命令就行', { mode: 'minimal', confidence: 'medium' })
})

test('rules: 「只跑一条命令」等 minimal 表述（DESIGN §4.1 + §9.7 修正 3）', () => {
  // 回归：DESIGN §4.1 明确写了「或『只跑一条命令』」，实现曾漏掉
  for (const text of [
    '只跑一条命令',
    '只需要跑一条命令',
    '只执行一条命令',
    '只运行一条命令',
    'just one command',
    'one command only',
  ]) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'minimal', `应判 minimal: ${text}，实际 ${result.mode}/${result.confidence}`)
    assert.equal(result.confidence, 'medium', `minimal 应为 medium: ${text}`)
  }
})

test('rules: 「用 minimal 模式」等中英混写也命中 minimal（DESIGN §9.7 修正 3）', () => {
  for (const text of ['用 minimal 模式', 'minimal 模式', '使用 minimal 模式']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'minimal', `应判 minimal: ${text}，实际 ${result.mode}/${result.confidence}`)
  }
})

// ---------------------------------------------------------------------------
// 长任务描述倾向 ptc
// ---------------------------------------------------------------------------

test('rules: ≥180 字符长任务描述倾向 ptc', () => {
  // 无任何 PTC 关键词的纯叙述型长文本，仅靠长度启发式也应倾向 ptc
  const longNeutral =
    '我正在准备一个关于分布式系统的技术分享，想请你帮我把思路整理得更清楚一些。分享的听众主要是刚入职的工程师，' +
    '他们大概了解一些基础概念，但对实际工程中的取舍还不太熟悉。希望你能够先给出一个整体的讲述框架，再针对每个部分补充一些具体例子，' +
    '例子的难度要适中，不要过于学术。另外，如果某些概念容易混淆，也请顺手做一点对比说明，让听众能够快速建立直觉，' +
    '最好还能在结尾留一点时间回答提问，并且提前准备几个常见的追问。'
  assert.ok([...longNeutral].length >= 180, `测试样本长度不足 180: ${[...longNeutral].length}`)
  const result = classifyLocal(longNeutral)
  assert.equal(result.mode, 'ptc', `长任务描述应倾向 ptc，实际 ${result.mode}/${result.confidence}，reasons=${JSON.stringify(result.reasons)}`)
  assert.notEqual(result.confidence, 'high', '仅靠长度启发式不应直接 high')
})

test('rules: 短文本（≤30 字符）无信号 → 至少 medium，绝不 low', () => {
  const result = classifyLocal('帮我处理一下这个')
  assert.equal(result.mode, 'standard')
  assert.notEqual(result.confidence, 'low', '短文本不应是 low，否则会白跑模型')
})

// ---------------------------------------------------------------------------
// 兜底 / 边界
// ---------------------------------------------------------------------------

test('rules: 空文本 → low + standard；无信号文本 → standard（medium/low）', () => {
  const empty = expectDecision('', { mode: 'standard', confidence: 'low' })
  assert.deepEqual(empty.reasons, [])
  assert.equal(empty.score, 0)

  // 无明确信号时不直接下结论，交给上层（本地倾向 + 可选模型）
  for (const text of ['我想先了解一下这个项目', '我这边有个想法，回头再具体说说']) {
    const result = classifyLocal(text)
    assert.equal(result.mode, 'standard', `无信号文本应回落 standard: ${text}`)
    assert.ok(['medium', 'low'].includes(result.confidence), `无信号文本应为 medium/low: ${text}`)
  }
})

test('rules: 非字符串入参不抛异常', () => {
  for (const input of [undefined, null, 42, {}, []]) {
    const result = classifyLocal(input)
    assert.ok(ROUTABLE.includes(result.mode))
    assert.ok(CONFIDENCE.includes(result.confidence))
  }
})

// ---------------------------------------------------------------------------
// extraPtc / extraStandard 自定义关键词
// ---------------------------------------------------------------------------

test('rules: extraPtc 命中会加分并倾向 ptc', () => {
  const baseline = classifyLocal('部署到 staging 环境')
  const tuned = classifyLocal('部署到 staging 环境', { extraPtc: ['部署'] })
  assert.ok(tuned.score > baseline.score, `extraPtc 应加分: ${baseline.score} → ${tuned.score}`)
  assert.ok(tuned.reasons.some((reason) => reason.includes('部署')), 'reasons 应记录自定义关键词')
  assert.equal(tuned.mode, 'ptc')

  const strong = classifyLocal('部署到 staging 环境并验证', { extraPtc: ['部署', '验证'] })
  assert.equal(strong.mode, 'ptc')
  assert.equal(strong.confidence, 'high', '两个自定义 PTC 关键词应达到 high')
})

test('rules: extraStandard 命中会加分并倾向 standard', () => {
  const baseline = classifyLocal('部署到 staging 环境')
  const tuned = classifyLocal('部署到 staging 环境', { extraStandard: ['部署'] })
  assert.ok(tuned.score < baseline.score, `extraStandard 应减分: ${baseline.score} → ${tuned.score}`)
  assert.equal(tuned.mode, 'standard')
  assert.ok(tuned.reasons.some((reason) => reason.includes('部署')))
})

test('rules: extraPtc 非法项被忽略（空串/非字符串）', () => {
  const baseline = classifyLocal('部署到 staging 环境')
  for (const bad of [[''], [null], [42], [{}], [[]]]) {
    const result = classifyLocal('部署到 staging 环境', { extraPtc: bad })
    assert.equal(result.score, baseline.score, `非法 extraPtc 不应影响打分: ${JSON.stringify(bad)}`)
  }
})

test('rules: options 缺省 / 空对象等价', () => {
  const text = '请遍历所有文件，统计每个文件的行数并汇总成表格'
  assert.deepEqual(classifyLocal(text), classifyLocal(text, {}))
  assert.deepEqual(classifyLocal(text, {}), classifyLocal(text, undefined))
})

// ---------------------------------------------------------------------------
// 优先级：批量信号强于解释/单动作词
// ---------------------------------------------------------------------------

test('rules: 同时含 standard 与 PTC 词时以更强信号为准', () => {
  const result = classifyLocal('请解释一下这个函数，然后遍历所有文件把每个文件里调用它的地方都改掉')
  assert.equal(result.mode, 'ptc', `PTC 强信号应压过解释词，实际 reasons=${JSON.stringify(result.reasons)}`)
})
