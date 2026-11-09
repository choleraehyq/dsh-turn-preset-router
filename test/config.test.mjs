/**
 * lib/config.js 单元测试
 *
 * 契约来源：docs/DESIGN.md §6（配置表）+ §9.2（`blockOnModel` → `modelEnabled`）+ task-2 冻结契约。
 *
 * 注意：DESIGN §6 初稿列出的 `blockOnModel` 已由 §9.2 删除（DSH 的组装顺序下无法实现），
 * 因此本文件断言的是 `modelEnabled`，并显式断言 `blockOnModel` 不再出现在归一化结果里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, normalizeConfig, CONFIG_FIELDS, MODES } from '../lib/config.js'

/** DESIGN §6 + §9.2 规定的默认值。 */
const EXPECTED_DEFAULTS = {
  enabled: true,
  defaultMode: 'standard',
  provider: '',
  model: 'deepseek-v4-flash',
  modelEnabled: true,
  modelMaxTokens: 256,
  modelTemperature: 0,
  modelTimeoutMs: 8000,
  minimalAllowlist: ['bash', 'read_file', 'write_file', 'edit_file'],
  applyToSubagents: false,
  guidance: true,
  extraPtc: [],
  extraStandard: [],
  sticky: true,
}

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

test('config: DEFAULTS 覆盖 DESIGN §6 + §9.2 的全部字段与默认值', () => {
  for (const [key, expected] of Object.entries(EXPECTED_DEFAULTS)) {
    assert.ok(Object.hasOwn(DEFAULTS, key), `DEFAULTS 缺少字段 ${key}`)
    assert.deepEqual(DEFAULTS[key], expected, `DEFAULTS.${key} 不符`)
  }
})

test('config: DEFAULTS 不包含已删除的 blockOnModel', () => {
  assert.equal(Object.hasOwn(DEFAULTS, 'blockOnModel'), false, 'blockOnModel 已由 DESIGN §9.2 删除')
  assert.equal(Object.hasOwn(DEFAULTS, 'modelEnabled'), true, 'modelEnabled 应存在')
})

test('config: DEFAULTS 与 CONFIG_FIELDS 字段集合一致（无漏配/多配）', () => {
  assert.deepEqual([...CONFIG_FIELDS].sort(), Object.keys(DEFAULTS).sort())
  assert.equal(new Set(CONFIG_FIELDS).size, CONFIG_FIELDS.length, 'CONFIG_FIELDS 不应重复')
})

test('config: DEFAULTS 是冻结的，避免调用方误改全局默认', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true)
  assert.throws(() => {
    'use strict'
    DEFAULTS.enabled = false
  }, TypeError)
})

test('config: MODES 只包含三种可路由模式', () => {
  assert.deepEqual([...MODES], ['standard', 'ptc', 'minimal'])
})

// ---------------------------------------------------------------------------
// normalizeConfig：补默认
// ---------------------------------------------------------------------------

test('config: normalizeConfig() 空入参返回完整默认值', () => {
  const expected = { ...EXPECTED_DEFAULTS, minimalAllowlist: [...DEFAULTS.minimalAllowlist], extraPtc: [], extraStandard: [] }
  assert.deepEqual(normalizeConfig(), expected)
  assert.deepEqual(normalizeConfig(null), expected)
  assert.deepEqual(normalizeConfig(undefined), expected)
  assert.deepEqual(normalizeConfig({}), expected)
})

test('config: normalizeConfig 非对象入参回落默认值', () => {
  const expected = normalizeConfig()
  for (const input of [null, undefined, [], 'x', 42, true]) {
    assert.deepEqual(normalizeConfig(input), expected, `非对象入参应回落默认值: ${JSON.stringify(input)}`)
  }
})

test('config: normalizeConfig 结果恒为完整字段集（不含未知字段）', () => {
  const normalized = normalizeConfig({ unknownField: 1, blockOnModel: true })
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(DEFAULTS).sort())
  assert.equal(Object.hasOwn(normalized, 'blockOnModel'), false, '未知/已删字段不应透传')
  assert.equal(Object.hasOwn(normalized, 'unknownField'), false, '未知字段不应透传')
})

// ---------------------------------------------------------------------------
// normalizeConfig：合法值保留
// ---------------------------------------------------------------------------

test('config: 合法值被原样保留', () => {
  const normalized = normalizeConfig({
    enabled: false,
    defaultMode: 'ptc',
    provider: 'deepseek',
    model: 'deepseek-v4',
    modelEnabled: false,
    modelMaxTokens: 512,
    modelTemperature: 0.7,
    modelTimeoutMs: 3000,
    minimalAllowlist: ['bash', 'read_file'],
    applyToSubagents: true,
    guidance: false,
    extraPtc: ['批量'],
    extraStandard: ['解释'],
    sticky: false,
  })
  assert.deepEqual(normalized, {
    enabled: false,
    defaultMode: 'ptc',
    provider: 'deepseek',
    model: 'deepseek-v4',
    modelEnabled: false,
    modelMaxTokens: 512,
    modelTemperature: 0.7,
    modelTimeoutMs: 3000,
    minimalAllowlist: ['bash', 'read_file'],
    applyToSubagents: true,
    guidance: false,
    extraPtc: ['批量'],
    extraStandard: ['解释'],
    sticky: false,
  })
})

test('config: defaultMode 接受三种模式', () => {
  for (const mode of MODES) {
    assert.equal(normalizeConfig({ defaultMode: mode }).defaultMode, mode)
  }
})

// ---------------------------------------------------------------------------
// normalizeConfig：非法值回落默认
// ---------------------------------------------------------------------------

test('config: 非法 defaultMode 回落默认（含大小写/auto/空值）', () => {
  for (const bad of ['bogus', 'PTC', 'auto', '', ' ptc ', null, 42, {}, []]) {
    assert.equal(
      normalizeConfig({ defaultMode: bad }).defaultMode,
      DEFAULTS.defaultMode,
      `非法 defaultMode 应回落: ${JSON.stringify(bad)}`,
    )
  }
})

test('config: 非法布尔值回落默认', () => {
  for (const field of ['enabled', 'modelEnabled', 'applyToSubagents', 'guidance', 'sticky']) {
    for (const bad of ['true', 1, 0, null, {}, []]) {
      assert.equal(
        normalizeConfig({ [field]: bad })[field],
        DEFAULTS[field],
        `非法布尔 ${field} 应回落默认: ${JSON.stringify(bad)}`,
      )
    }
    assert.equal(normalizeConfig({ [field]: false })[field], false, `${field} 应接受 false`)
  }
})

test('config: 非法字符串回落默认', () => {
  for (const bad of [42, null, {}, [], true]) {
    assert.equal(normalizeConfig({ provider: bad }).provider, DEFAULTS.provider)
    assert.equal(normalizeConfig({ model: bad }).model, DEFAULTS.model)
  }
  // 空/纯空白 model 不可用，回落默认
  for (const blank of ['', '   ']) {
    assert.equal(normalizeConfig({ model: blank }).model, DEFAULTS.model, `空白 model 应回落默认: ${JSON.stringify(blank)}`)
  }
})

test('config: 非有限数字回落默认（NaN/Infinity/字符串/null）', () => {
  for (const field of ['modelMaxTokens', 'modelTemperature', 'modelTimeoutMs']) {
    for (const bad of [NaN, Infinity, -Infinity, '256', null, {}, []]) {
      assert.equal(
        normalizeConfig({ [field]: bad })[field],
        DEFAULTS[field],
        `非法数字 ${field} 应回落默认: ${JSON.stringify(bad)}`,
      )
    }
  }
})

test('config: 越界数字回落默认', () => {
  // modelMaxTokens 合理范围 1..8192
  assert.equal(normalizeConfig({ modelMaxTokens: 0 }).modelMaxTokens, DEFAULTS.modelMaxTokens)
  assert.equal(normalizeConfig({ modelMaxTokens: -5 }).modelMaxTokens, DEFAULTS.modelMaxTokens)
  assert.equal(normalizeConfig({ modelMaxTokens: 8193 }).modelMaxTokens, DEFAULTS.modelMaxTokens)
  assert.equal(normalizeConfig({ modelMaxTokens: 1 }).modelMaxTokens, 1)
  assert.equal(normalizeConfig({ modelMaxTokens: 8192 }).modelMaxTokens, 8192)

  // modelTemperature 合理范围 0..2
  assert.equal(normalizeConfig({ modelTemperature: -0.1 }).modelTemperature, DEFAULTS.modelTemperature)
  assert.equal(normalizeConfig({ modelTemperature: 2.1 }).modelTemperature, DEFAULTS.modelTemperature)
  assert.equal(normalizeConfig({ modelTemperature: 2 }).modelTemperature, 2)

  // modelTimeoutMs 合理范围 100..120000
  assert.equal(normalizeConfig({ modelTimeoutMs: 99 }).modelTimeoutMs, DEFAULTS.modelTimeoutMs)
  assert.equal(normalizeConfig({ modelTimeoutMs: 120001 }).modelTimeoutMs, DEFAULTS.modelTimeoutMs)
  assert.equal(normalizeConfig({ modelTimeoutMs: 100 }).modelTimeoutMs, 100)
})

// ---------------------------------------------------------------------------
// normalizeConfig：数组字段
// ---------------------------------------------------------------------------

test('config: extraPtc 过滤非字符串与空串并 trim', () => {
  const normalized = normalizeConfig({ extraPtc: ['批量', '', '  ', 42, null, {}, [], '  deploy  '] })
  assert.deepEqual(normalized.extraPtc, ['批量', 'deploy'])
})

test('config: extraStandard 过滤非字符串与空串并 trim', () => {
  const normalized = normalizeConfig({ extraStandard: ['解释', 0, false, null, '  说明  ', ''] })
  assert.deepEqual(normalized.extraStandard, ['解释', '说明'])
})

test('config: 数组字段非数组时回落默认空数组', () => {
  for (const bad of ['批量', 42, {}, null, true]) {
    assert.deepEqual(normalizeConfig({ extraPtc: bad }).extraPtc, [])
    assert.deepEqual(normalizeConfig({ extraStandard: bad }).extraStandard, [])
  }
})

test('config: minimalAllowlist 过滤非字符串并 trim', () => {
  const normalized = normalizeConfig({ minimalAllowlist: ['bash', 42, null, '', '  read_file  ', {}] })
  assert.deepEqual(normalized.minimalAllowlist, ['bash', 'read_file'])
})

test('config: 空 minimalAllowlist 回落默认（空 allowlist 会隐藏所有工具）', () => {
  assert.deepEqual(normalizeConfig({ minimalAllowlist: [] }).minimalAllowlist, [...DEFAULTS.minimalAllowlist])
  assert.deepEqual(
    normalizeConfig({ minimalAllowlist: [42, '', null] }).minimalAllowlist,
    [...DEFAULTS.minimalAllowlist],
  )
  assert.deepEqual(normalizeConfig({ minimalAllowlist: 'bash' }).minimalAllowlist, [...DEFAULTS.minimalAllowlist])
})

// ---------------------------------------------------------------------------
// 不可变性：归一化结果不共享 DEFAULTS 的数组引用
// ---------------------------------------------------------------------------

test('config: 归一化结果是独立数组，修改它不会污染 DEFAULTS', () => {
  const first = normalizeConfig({})
  first.minimalAllowlist.push('polluted')
  first.extraPtc.push('polluted')
  assert.deepEqual([...DEFAULTS.minimalAllowlist], ['bash', 'read_file', 'write_file', 'edit_file'])
  assert.deepEqual([...DEFAULTS.extraPtc], [])
  assert.deepEqual(normalizeConfig({}).minimalAllowlist, ['bash', 'read_file', 'write_file', 'edit_file'])
})
