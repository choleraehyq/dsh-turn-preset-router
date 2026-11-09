/**
 * lib/classifier.js 单元测试
 *
 * 契约来源：docs/DESIGN.md §4.2（模型慢速判定）+ task-2 冻结契约。
 * 只测试纯函数部分（system prompt 与回复解析）；`classifyWithModel` 依赖 ctx.llm，
 * 由 dev harness 覆盖，这里不 mock。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildClassifierSystem, parseClassification } from '../lib/classifier.js'

const ROUTABLE = ['standard', 'ptc', 'minimal']

/** 断言解析结果的完整形状。 */
function expectShape(result) {
  assert.equal(typeof result, 'object')
  assert.ok(result !== null)
  assert.deepEqual(Object.keys(result).sort(), ['confidence', 'mode', 'reason'])
  assert.ok(ROUTABLE.includes(result.mode), `mode 非法: ${result.mode}`)
  assert.equal(typeof result.reason, 'string')
  assert.equal(typeof result.confidence, 'number')
  assert.ok(Number.isFinite(result.confidence))
  assert.ok(result.confidence >= 0 && result.confidence <= 1, `confidence 越界: ${result.confidence}`)
  return result
}

// ---------------------------------------------------------------------------
// buildClassifierSystem
// ---------------------------------------------------------------------------

test('classifier: system prompt 要求只输出 JSON 且含三个模式说明', () => {
  const system = buildClassifierSystem()
  assert.equal(typeof system, 'string')
  assert.ok(system.length > 0)

  // 必须要求 JSON 输出并给出字段契约
  assert.match(system, /JSON/i)
  assert.ok(system.includes('mode'), 'system prompt 应说明 mode 字段')
  assert.ok(system.includes('reason'), 'system prompt 应说明 reason 字段')
  assert.ok(system.includes('confidence'), 'system prompt 应说明 confidence 字段')

  // 三种模式都必须解释
  for (const mode of ROUTABLE) {
    assert.ok(system.includes(mode), `system prompt 缺少模式说明: ${mode}`)
  }

  // 判定规则要点（DESIGN §4.2 / §4.1）
  assert.match(system, /批量|遍历|并行|循环|批处理/)
  assert.match(system, /简单问答|寒暄|解释|单个/)
})

test('classifier: system prompt 明确禁止 markdown 围栏', () => {
  const system = buildClassifierSystem()
  assert.match(system, /不要用 markdown|不要输出.*代码围栏|代码围栏/i)
})

// ---------------------------------------------------------------------------
// parseClassification：正常 JSON
// ---------------------------------------------------------------------------

test('classifier: 解析裸 JSON', () => {
  const result = expectShape(parseClassification('{"mode":"ptc","reason":"批量任务","confidence":0.9}', 'standard'))
  assert.deepEqual(result, { mode: 'ptc', reason: '批量任务', confidence: 0.9 })
})

test('classifier: 三种合法 mode 都能解析', () => {
  for (const mode of ROUTABLE) {
    const result = expectShape(
      parseClassification(JSON.stringify({ mode, reason: '理由', confidence: 0.6 }), 'standard'),
    )
    assert.equal(result.mode, mode)
  }
})

test('classifier: 剥 ```json 围栏', () => {
  const text = '```json\n{"mode":"minimal","reason":"最小工具集","confidence":0.4}\n```'
  const result = expectShape(parseClassification(text, 'standard'))
  assert.deepEqual(result, { mode: 'minimal', reason: '最小工具集', confidence: 0.4 })
})

test('classifier: 剥无语言标记的 ``` 围栏', () => {
  const text = '```\n{"mode":"standard","reason":"简单问答","confidence":1}\n```'
  const result = expectShape(parseClassification(text, 'ptc'))
  assert.deepEqual(result, { mode: 'standard', reason: '简单问答', confidence: 1 })
})

test('classifier: 围栏前后有说明文字也能解析', () => {
  const text = '判定结果如下：\n```json\n{"mode":"ptc","reason":"并行 fan-out","confidence":0.8}\n```\n希望有帮助。'
  const result = expectShape(parseClassification(text, 'standard'))
  assert.equal(result.mode, 'ptc')
  assert.equal(result.reason, '并行 fan-out')
  assert.equal(result.confidence, 0.8)
})

test('classifier: 裸 JSON 前后有散文也能解析（抓第一个 {...}）', () => {
  const leading = '判定结果如下：\n{"mode":"minimal","reason":"a","confidence":0.2}'
  assert.equal(expectShape(parseClassification(leading, 'standard')).mode, 'minimal')

  const trailing = '{"mode":"minimal","reason":"a","confidence":0.2}\n\n以上。'
  assert.equal(expectShape(parseClassification(trailing, 'standard')).mode, 'minimal')
})

test('classifier: mode 大小写不敏感、容忍前后空白', () => {
  assert.equal(expectShape(parseClassification('{"mode":"PTC","confidence":0.5}', 'standard')).mode, 'ptc')
  assert.equal(expectShape(parseClassification('{"mode":"  Standard  ","confidence":0.5}', 'standard')).mode, 'standard')
})

// ---------------------------------------------------------------------------
// parseClassification：非法 mode 回落
// ---------------------------------------------------------------------------

test('classifier: 非法 mode 回落 fallbackMode', () => {
  for (const fallback of ROUTABLE) {
    const result = expectShape(parseClassification('{"mode":"bogus","reason":"x","confidence":0.5}', fallback))
    assert.equal(result.mode, fallback, `非法 mode 应回落 ${fallback}`)
    assert.equal(result.reason, 'x', 'mode 非法时 reason 仍应保留')
    assert.equal(result.confidence, 0.5)
  }
})

test('classifier: 缺失 mode 回落 fallbackMode', () => {
  for (const fallback of ROUTABLE) {
    const result = expectShape(parseClassification('{"reason":"x","confidence":0.5}', fallback))
    assert.equal(result.mode, fallback)
  }
})

test('classifier: mode 非字符串回落 fallbackMode', () => {
  for (const bad of [1, null, {}, [], true]) {
    const result = expectShape(parseClassification(JSON.stringify({ mode: bad, confidence: 0.5 }), 'minimal'))
    assert.equal(result.mode, 'minimal', `mode 非字符串应回落: ${JSON.stringify(bad)}`)
  }
})

test('classifier: fallbackMode 本身非法时回落 standard', () => {
  for (const bad of ['bogus', 'auto', '', null, undefined, 42]) {
    const result = expectShape(parseClassification('{"mode":"bogus"}', bad))
    assert.equal(result.mode, 'standard', `非法 fallbackMode 应回落 standard: ${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// parseClassification：confidence clamp
// ---------------------------------------------------------------------------

test('classifier: confidence 越界被 clamp 到 [0,1]', () => {
  assert.equal(parseClassification('{"mode":"ptc","confidence":5}', 'standard').confidence, 1)
  assert.equal(parseClassification('{"mode":"ptc","confidence":1.5}', 'standard').confidence, 1)
  assert.equal(parseClassification('{"mode":"ptc","confidence":-3}', 'standard').confidence, 0)
  assert.equal(parseClassification('{"mode":"ptc","confidence":0}', 'standard').confidence, 0)
  assert.equal(parseClassification('{"mode":"ptc","confidence":1}', 'standard').confidence, 1)
  assert.equal(parseClassification('{"mode":"ptc","confidence":0.42}', 'standard').confidence, 0.42)
})

test('classifier: 缺失/非数字 confidence 视为 0', () => {
  for (const bad of ['"0.7"', 'null', 'true', '{}', '[]']) {
    const result = expectShape(parseClassification(`{"mode":"ptc","confidence":${bad}}`, 'standard'))
    assert.equal(result.confidence, 0, `非法 confidence 应视为 0: ${bad}`)
  }
  assert.equal(parseClassification('{"mode":"ptc"}', 'standard').confidence, 0)
})

// ---------------------------------------------------------------------------
// parseClassification：reason 截断
// ---------------------------------------------------------------------------

test('classifier: reason 超长被截断（保留前 300 字符）', () => {
  const longReason = 'y'.repeat(500)
  const result = expectShape(
    parseClassification(JSON.stringify({ mode: 'ptc', reason: longReason, confidence: 0.5 }), 'standard'),
  )
  assert.ok(result.reason.startsWith('y'.repeat(300)), '截断应保留前 300 字符')
  assert.ok(result.reason.length <= 301, `截断后长度应约 300，实际 ${result.reason.length}`)
})

test('classifier: reason 未超长时原样保留', () => {
  const reason = '这是一个长度正常的理由'
  assert.equal(parseClassification(JSON.stringify({ mode: 'ptc', reason, confidence: 0.5 }), 'standard').reason, reason)
  // 恰好 300 字符也不应被截断
  const exact = 'z'.repeat(300)
  assert.equal(parseClassification(JSON.stringify({ mode: 'ptc', reason: exact }), 'standard').reason, exact)
})

test('classifier: 缺失/非字符串 reason 视为空串', () => {
  assert.equal(parseClassification('{"mode":"ptc"}', 'standard').reason, '')
  assert.equal(parseClassification('{"mode":"ptc","reason":42}', 'standard').reason, '')
  assert.equal(parseClassification('{"mode":"ptc","reason":null}', 'standard').reason, '')
})

// ---------------------------------------------------------------------------
// parseClassification：不可解析输入
// ---------------------------------------------------------------------------

test('classifier: 不可解析输入返回 fallbackMode + confidence 0', () => {
  const inputs = ['not json at all', '', '   ', 'no braces here', '[1,2,3]', 'null', '42', '{}']
  for (const input of inputs) {
    for (const fallback of ROUTABLE) {
      const result = expectShape(parseClassification(input, fallback))
      assert.equal(result.mode, fallback, `不可解析输入应回落 ${fallback}: ${JSON.stringify(input)}`)
      assert.equal(result.confidence, 0, `不可解析输入 confidence 应为 0: ${JSON.stringify(input)}`)
    }
  }
})

test('classifier: 非字符串入参不抛异常', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    const result = expectShape(parseClassification(input, 'ptc'))
    assert.equal(result.mode, 'ptc')
    assert.equal(result.confidence, 0)
  }
})

test('classifier: 截断的 JSON 不抛异常，回落 fallback', () => {
  const truncated = '{"mode":"ptc","reason":"未闭合'
  const result = expectShape(parseClassification(truncated, 'standard'))
  assert.equal(result.mode, 'standard')
  assert.equal(result.confidence, 0)
})
