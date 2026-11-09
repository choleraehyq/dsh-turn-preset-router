/**
 * Local, zero-cost task-shape rules for the turn preset router.
 *
 * The router runs these rules before it ever considers a model call: a
 * high-confidence match decides the turn outright, which keeps the common
 * cases (a plain question, an obviously batched job) instant and free. Only a
 * low-confidence result is escalated to the model classifier.
 *
 * The three modes differ in what the model can do in one step:
 *
 * - `standard` presents every tool schema as a native function call. Best for
 *   conversation, single actions, and short answers.
 * - `ptc` presents one `run_code` program whose generated SDK exposes every
 *   tool. It pays off when one step needs many calls — loops, batches, fan-out
 *   — because those stay inside one program instead of one round-trip each.
 * - `minimal` exposes a deliberately small toolset for one-shot requests.
 *
 * Keep this module pure and dependency-free: it is the part deployments tune,
 * so it must be cheap to test and to read.
 *
 * @module dsh-turn-preset-router/rules
 */

/** @typedef {'standard' | 'ptc' | 'minimal'} Mode */
/** @typedef {'high' | 'medium' | 'low'} Confidence */

/**
 * Signals that one step is likely to need many tool calls.
 *
 * Each entry is scored by its weight and records a human-readable reason, so
 * `/mode` and the logs can explain why a turn was routed where it was.
 */
const PTC_RULES = Object.freeze([
  {
    re: /(?:批量|全量|逐个|逐一|逐行|遍历|每一个|每个文件|每个模块|每个接口|每个用户|所有文件|全部文件|所有项目|所有接口|批处理)/i,
    weight: 3,
    label: '批量/逐项处理',
  },
  {
    re: /\b(?:batch|bulk|for each|every file|each file|all files|iterate|loop over|loop through)\b/i,
    weight: 3,
    label: 'batch/each-item',
  },
  {
    re: /(?:并行|并发|同时执行|同时运行|同时处理|同时发|parallel|concurrently|in parallel|fan[- ]?out)/i,
    weight: 3,
    label: '并行执行',
  },
  {
    re: /(?:大量循环|循环\s*\d+|跑\s*\d+\s*遍|重复执行|反复执行|多次调用|上千次|上百次)/i,
    weight: 3,
    label: '大量循环/重复调用',
  },
  {
    re: /(?:批量发(?:送)?(?:评论|消息|通知|邮件)|批量提交|批量创建|批量更新|批量删除|批量导入|批量上传|批量下载|批量改名|批量替换|批量修改)/i,
    weight: 3,
    label: '批量写操作',
  },
  {
    re: /(?:脚本|自动化|流水线|编排|pipeline|automation|orchestrat|scripted)/i,
    weight: 2,
    label: '脚本化/流水线',
  },
  {
    re: /(?:整个仓库|全仓|全库|全项目|整个项目|代码库|仓库里|项目里|目录下|workspace|codebase|whole repo|entire repo|across the repo)/i,
    weight: 2,
    label: '全仓范围',
  },
  {
    re: /(?:解析|提取|抽取|统计|汇总|合并|去重|转换|格式化|比对|遍历).{0,12}(?:文件|目录|条目|记录|日志|数据|结果|所有)/i,
    weight: 2,
    label: '数据加工',
  },
  {
    re: /(?:多步骤|分步骤|分成.{0,6}步|第一步|第二步|步骤\s*\d|step by step|step 1|first,|then,)/i,
    weight: 1,
    label: '多步流程',
  },
  {
    re: /(?:审查|审计|全面检查|迁移|重构|批量修改|跑一遍测试|全量测试|audit|review all|migrate|refactor)/i,
    weight: 1,
    label: '审查/迁移',
  },
])

/**
 * Signals that a single conversational step is enough.
 *
 * These are scored as strongly as the PTC signals so an obviously simple turn
 * is never dragged into a program by an incidental keyword.
 */
const STANDARD_RULES = Object.freeze([
  {
    re: /^(?:你好|您好|谢谢|多谢|好的|收到|嗯+|哈+|ok|okay|hi|hello|hey|thanks|thank you)[啊呀。.!！~～]*$/i,
    weight: 4,
    label: '寒暄/确认',
  },
  {
    re: /(?:解释|说明一下|介绍一下|讲讲|是什么意思|有什么区别|为什么|原理是什么|explain|difference|what is|how do|how does|why )/i,
    weight: 3,
    label: '解释型问答',
  },
  {
    // A leading imperative verb normally means one action — but only when the
    // same sentence does not also ask for a batch, a loop, or a fan-out. The
    // negative lookahead keeps "run these in parallel" on the PTC side instead
    // of letting the verb cancel the parallel signal.
    re: /^(?:请|帮我|麻烦)?\s*(?:打开|查看|读一下|看一下|显示|列出|运行一下|执行一下|删掉|改一下|修一下|重命名|移动|复制|截图|截个图|search|open|read|show|list|run|rename|move|copy)\s(?![\s\S]*(?:并行|并发|同时执行|同时处理|parallel|concurrently|in parallel|批量|batch|遍历|每个|所有文件|all files|each file))/i,
    weight: 2,
    label: '单个动作',
  },
  {
    re: /(?:单个文件|一个文件|这一处|这个函数|这行|这个方法|这个文件|这段代码|this function|this file|this line)/i,
    weight: 1,
    label: '局部对象',
  },
])

/** Explicit request for the smallest possible toolset. */
const MINIMAL_RULE =
  /(?:最小模式|极简模式|最少工具|minimal\s*(?:mode|toolset|模式)|only one tool|只要一个工具|只(?:需要?|需|要)?\s*(?:跑|执行|运行|用)\s*(?:一|1)\s*条?\s*命令|one command only|just (?:one|a single) command)/i

/** Weighted question words, used together with a short-text gate below. */
const QUESTION_WORD = /(?:什么|为什么|为啥|怎么|如何|多少|哪个|哪些|是否|能不能|可不可以|吗|呢|\?|？|\b(?:what|why|how|which|whether|can you|could you)\b)/i

/** A short reply is rarely worth a program. */
const SHORT_TEXT_CHARS = 30

/** A long brief usually enumerates several things to do. */
const LONG_TEXT_CHARS = 180

/** A very long brief is almost always multi-step work. */
const VERY_LONG_TEXT_CHARS = 500

/** Character count of a string, counting code points rather than UTF-16 units. */
function charCount(text) {
  return [...text].length
}

/**
 * Classify one task text with the local rules only.
 *
 * The result separates the decision from its confidence: `high` means the
 * router applies the mode immediately, `medium` means it is a reasonable
 * default but the model may be consulted, and `low` means the router should
 * escalate to the model classifier.
 *
 * @param {string} text The turn's task text.
 * @param {{extraPtc?: readonly string[], extraStandard?: readonly string[]}} [options]
 *   Deployment keyword tuning; each match adds weight to its side.
 * @returns {{mode: Mode, confidence: Confidence, score: number, reasons: string[]}}
 */
export function classifyLocal(text, options = {}) {
  const value = String(text ?? '')
  const reasons = []
  let ptcScore = 0
  let standardScore = 0
  let minimalScore = 0

  for (const rule of PTC_RULES) {
    if (rule.re.test(value)) {
      ptcScore += rule.weight
      reasons.push(`+${rule.weight} ${rule.label}`)
    }
  }
  for (const rule of STANDARD_RULES) {
    if (rule.re.test(value)) {
      standardScore += rule.weight
      reasons.push(`-${rule.weight} ${rule.label}`)
    }
  }
  if (MINIMAL_RULE.test(value)) {
    minimalScore += 4
    reasons.push('+4 明确要求最小工具集')
  }

  const length = charCount(value.trim())

  // Length is a coarse but reliable proxy. Short prompts are rarely worth a
  // program; long briefs usually enumerate several things to do.
  if (length >= LONG_TEXT_CHARS) {
    ptcScore += 1
    reasons.push('+1 长任务描述')
  }
  if (length >= VERY_LONG_TEXT_CHARS) {
    ptcScore += 1
    reasons.push('+1 超长任务描述')
  }

  // A short question is the single most common "obviously standard" turn. The
  // plain short-text penalty, however, must not fire when a strong batch or
  // fan-out signal is already present: "run these in parallel" is short and
  // imperative but unambiguously a PTC task, so penalising its length would
  // cancel the very signal that identifies it.
  const strongPtc = ptcScore >= 3
  if (length > 0 && length <= SHORT_TEXT_CHARS && QUESTION_WORD.test(value)) {
    standardScore += 3
    reasons.push('-3 短问答')
  } else if (length > 0 && length <= SHORT_TEXT_CHARS && !strongPtc) {
    standardScore += 1
    reasons.push('-1 短指令')
  }

  // Enumerated requirements imply several calls rather than one.
  const numbered = (value.match(/(?:^|\n)\s*(?:\d+[.、)]|[-*+]\s|#{1,6}\s)/g) ?? []).length
  if (numbered >= 3) {
    ptcScore += 1
    reasons.push('+1 结构化清单')
  }
  const inlineRefs = (value.match(/`[^`\n]+`/g) ?? []).length
  if (inlineRefs >= 3) {
    ptcScore += 1
    reasons.push('+1 多处文件引用')
  }

  // Caller-supplied tuning, applied last so deployments can bias either side.
  for (const keyword of options.extraPtc ?? []) {
    if (typeof keyword === 'string' && keyword !== '' && value.toLowerCase().includes(keyword.toLowerCase())) {
      ptcScore += 2
      reasons.push(`+2 自定义 PTC 关键词「${keyword}」`)
    }
  }
  for (const keyword of options.extraStandard ?? []) {
    if (typeof keyword === 'string' && keyword !== '' && value.toLowerCase().includes(keyword.toLowerCase())) {
      standardScore += 2
      reasons.push(`-2 自定义标准关键词「${keyword}」`)
    }
  }

  // Minimal wins only when it is the strongest signal: a bare "最小模式" turn
  // has no other evidence, while a batched task that mentions "minimal" is
  // still a batched task.
  if (minimalScore > 0 && minimalScore >= ptcScore && minimalScore >= standardScore) {
    return { mode: 'minimal', confidence: 'medium', score: minimalScore, reasons }
  }

  const delta = ptcScore - standardScore
  if (delta >= 3) return { mode: 'ptc', confidence: 'high', score: delta, reasons }
  if (delta <= -3) return { mode: 'standard', confidence: 'high', score: delta, reasons }
  if (delta >= 1) return { mode: 'ptc', confidence: 'medium', score: delta, reasons }
  if (delta <= -1) return { mode: 'standard', confidence: 'medium', score: delta, reasons }

  // A neutral text with any positive evidence at all is still worth the model's
  // opinion; a truly empty one is not.
  return { mode: 'standard', confidence: 'low', score: delta, reasons }
}

/**
 * One-line human-readable summary of a local decision.
 * @param {ReturnType<typeof classifyLocal>} decision
 * @returns {string}
 */
export function describeLocal(decision) {
  const detail = decision.reasons.length > 0 ? `（${decision.reasons.join('，')}）` : ''
  return `${decision.mode} · ${decision.confidence}${detail}`
}
