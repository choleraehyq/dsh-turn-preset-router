/**
 * bin/classify.mjs 验收测试
 *
 * 契约来源：docs/DESIGN.md §8.2（离线 CLI 验收）+ task-2 交付项 5。
 * 用子进程真实执行 CLI，断言 stdout 是可解析 JSON、以及两个验收样例的 mode。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const cli = resolve(root, 'bin/classify.mjs')

/**
 * Run the CLI and capture its result.
 * @param {string[]} args
 * @param {{input?: string}} [options]
 */
function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout: 20_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Parse the CLI's JSON stdout. */
function runJson(args, options) {
  const result = runCli(args, options)
  assert.equal(result.status, 0, `CLI 退出码非 0: ${result.status}\nstderr=${result.stderr}`)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(`CLI stdout 不是合法 JSON: ${error.message}\nstdout=${result.stdout.slice(0, 500)}`)
  }
}

// ---------------------------------------------------------------------------
// DESIGN §8.2 验收样例
// ---------------------------------------------------------------------------

test('cli: 「遍历所有文件统计行数」输出 ptc', () => {
  const report = runJson(['遍历所有文件统计行数'])
  assert.equal(report.mode, 'ptc')
  assert.equal(report.local.mode, 'ptc')
  assert.equal(report.local.confidence, 'high')
})

test('cli: 「解释一下这个函数」输出 standard', () => {
  const report = runJson(['解释一下这个函数'])
  assert.equal(report.mode, 'standard')
  assert.equal(report.local.mode, 'standard')
  assert.equal(report.local.confidence, 'high')
})

test('cli: 「批量发评论」输出 ptc', () => {
  const report = runJson(['批量发评论'])
  assert.equal(report.mode, 'ptc')
})

// ---------------------------------------------------------------------------
// 输入方式
// ---------------------------------------------------------------------------

test('cli: 无参数时从 stdin 读取', () => {
  const report = runJson([], { input: '批量发评论\n' })
  assert.equal(report.text, '批量发评论')
  assert.equal(report.mode, 'ptc')
})

test('cli: 位置参数支持多段拼接', () => {
  const report = runJson(['遍历', '所有文件'])
  assert.equal(report.text, '遍历 所有文件')
  assert.equal(report.mode, 'ptc')
})

test('cli: 无输入时报错并以非 0 退出', () => {
  const result = runCli([], { input: '' })
  assert.notEqual(result.status, 0, '无输入应非 0 退出')
  assert.ok(result.stderr.length > 0, '无输入应有 stderr 提示')
})

test('cli: 纯空白输入报错', () => {
  const result = runCli([], { input: '   \n\t\n' })
  assert.notEqual(result.status, 0)
})

// ---------------------------------------------------------------------------
// 输出结构
// ---------------------------------------------------------------------------

test('cli: 默认输出合法 JSON 且含完整判定字段', () => {
  const report = runJson(['帮我看下 README 第一段'])
  assert.equal(typeof report.text, 'string')
  assert.ok(['standard', 'ptc', 'minimal'].includes(report.mode))
  assert.ok(['user', 'continue', 'local', 'local-lean'].includes(report.decidedBy))
  assert.equal(typeof report.reason, 'string')
  assert.ok(report.local && typeof report.local === 'object')
  assert.ok(['high', 'medium', 'low'].includes(report.local.confidence))
  assert.equal(typeof report.local.score, 'number')
  assert.ok(Array.isArray(report.local.reasons))
  assert.equal(report.explicit, null)
  assert.equal(report.continuation, false)
  assert.equal(typeof report.config.defaultMode, 'string')
})

test('cli: 显式模式优先于本地规则', () => {
  const report = runJson(['/mode ptc'])
  assert.equal(report.mode, 'ptc')
  assert.equal(report.decidedBy, 'user')
  assert.equal(report.explicit.mode, 'ptc')
})

test('cli: 续写文本被标记为 continue 且不重判', () => {
  const report = runJson(['继续'])
  assert.equal(report.decidedBy, 'continue')
  assert.equal(report.continuation, true)
  assert.equal(report.mode, null, '续写时 mode 由上一轮决定，CLI 不臆造')
})

test('cli: 疑问句不会被误判为显式模式', () => {
  const report = runJson(['解释一下 ptc 模式是什么'])
  assert.equal(report.explicit, null)
  assert.notEqual(report.decidedBy, 'user')
})

// ---------------------------------------------------------------------------
// --model 占位
// ---------------------------------------------------------------------------

test('cli: --model 是占位说明，不调用模型', () => {
  const report = runJson(['--model', '帮我读一下 docs 目录下的设计文档'])
  assert.ok(report.model, '--model 应输出 model 占位字段')
  assert.equal(report.model.requested, true)
  assert.equal(report.model.used, false, '离线 CLI 不得调用模型')
  assert.equal(typeof report.model.note, 'string')
  assert.ok(report.model.note.length > 0)
})

test('cli: 不带 --model 时输出中没有 model 字段', () => {
  const report = runJson(['你好'])
  assert.equal(Object.hasOwn(report, 'model'), false)
})

// ---------------------------------------------------------------------------
// --text / --defaults / --help
// ---------------------------------------------------------------------------

test('cli: --text 输出人类可读文本且仍以 0 退出', () => {
  const result = runCli(['--text', '你好'])
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes('standard'), `人类可读输出应含判定: ${result.stdout}`)
  assert.throws(() => JSON.parse(result.stdout), '--text 输出不应是 JSON')
})

test('cli: --defaults 输出归一化默认配置', () => {
  const config = runJson(['--defaults'])
  assert.equal(config.defaultMode, 'standard')
  assert.equal(config.modelEnabled, true)
  assert.deepEqual(config.minimalAllowlist, ['bash', 'read_file', 'write_file', 'edit_file'])
  assert.equal(Object.hasOwn(config, 'blockOnModel'), false)
})

test('cli: --help 输出用法并以 0 退出', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes('用法'))
})

test('cli: 未知参数以非 0 退出并给出提示', () => {
  const result = runCli(['--bogus', 'x'])
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes('--bogus'))
})
