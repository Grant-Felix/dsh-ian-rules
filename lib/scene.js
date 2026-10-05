/**
 * 场景匹配：把「这个会话此刻在做什么」与「哪几条规则和它相关」对上。
 *
 * 纯逻辑、零依赖（与 rules.js 一样可被 `node --test` 直跑），不碰 DSH 运行时。
 *
 * 三条设计约束（理由见 README 第五节）：
 *   1. 只服务 `mode: 'auto'` 的规则；常驻规则不进这里，它们照旧固定在系统提示里；
 *   2. 命中结果挂在**消息尾部**，绝不进系统提示 —— 系统提示一变，它之后的
 *      全部内容（工具定义 + 整段对话历史）都要按未命中价重算；
 *   3. 同一会话内已命中的集合只增不减（sticky，由调用方维护）：每步换一批会让
 *      模型看到互相矛盾的规则快照，行为飘忽。
 */
import { createHash } from 'node:crypto'

/** 命中一条规则所需的最低分。低于它就当成「这轮不相关」。 */
export const SCENE_THRESHOLD = 1.5

/** 一次最多注入几条命中规则。 */
export const SCENE_LIMIT = 8

/** 一次注入的字符预算（标题 + 正文）。 */
export const SCENE_BUDGET_CHARS = 2000

/**
 * 打分权重：标签最准，标题次之，正文最弱（正文长，容易「什么都沾一点」）。
 * 单字再乘 `CHAR_DISCOUNT` —— 中文一个字的信息量远小于一个二元组，
 * 不降权的话「最新版」和「版本号」会靠一个「版」字互相命中。
 */
const WEIGHT_TAG = 3
const WEIGHT_TITLE = 2
const WEIGHT_CONTENT = 1
const CHAR_DISCOUNT = 0.25

const CJK_RUN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]+/g
const CJK_CHAR = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 把一段自由文本切成两层词元：
 *   - `words`：ASCII 词（小写、长度 ≥ 2）+ CJK **二元字组**；
 *   - `chars`：CJK **单字**（降权使用）。
 *
 * 中文没有空格，而本插件全程零依赖、不引分词器，所以二元组是主力：
 * 「提交前跑测试」→ `提交/交前/前跑/跑测/测试`，已经接近词粒度；单字只作为兜底，
 * 靠 `CHAR_DISCOUNT` 压住误命中。
 */
export function tokenize(text) {
  const words = new Set()
  const chars = new Set()
  const raw = String(text ?? '').toLowerCase()
  if (raw === '') return { words, chars }
  for (const word of raw.replace(/[^\x20-\x7e]+/g, ' ').split(/[^a-z0-9_+#.-]+/)) {
    if (word.length >= 2) words.add(word)
  }
  for (const run of raw.match(CJK_RUN) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      const char = run[index]
      if (CJK_CHAR.test(char)) chars.add(char)
      if (index + 1 < run.length) words.add(run.slice(index, index + 2))
    }
  }
  return { words, chars }
}

/**
 * 词元缓存。规则对象在**同一份文档**里是稳定的（sanitizeDoc 之后不再重建），
 * 所以用 WeakMap 按对象缓存；文档一换，旧对象自然被回收。
 */
const termCache = new WeakMap()

function termsOf(rule) {
  let entry = termCache.get(rule)
  if (entry === undefined) {
    entry = {
      tags: tokenize(Array.isArray(rule.tags) ? rule.tags.join(' ') : ''),
      title: tokenize(rule.title),
      content: tokenize(rule.content),
    }
    termCache.set(rule, entry)
  }
  return entry
}

function overlap(field, signal, weight) {
  let score = 0
  for (const word of field.words) if (signal.words.has(word)) score += weight
  for (const char of field.chars) if (signal.chars.has(char)) score += weight * CHAR_DISCOUNT
  return score
}

/**
 * 一条规则与场景信号的匹配分。命中标签 / 标题 / 正文都算分，再按正文长度做
 * **归一化** —— 否则一条 4000 字的巨型规则靠「什么都沾一点」通吃所有场次。
 * @returns 0 表示毫无关联
 */
export function scoreRule(rule, terms) {
  if (terms.words.size === 0 && terms.chars.size === 0) return 0
  const entry = termsOf(rule)
  const raw =
    overlap(entry.tags, terms, WEIGHT_TAG) +
    overlap(entry.title, terms, WEIGHT_TITLE) +
    overlap(entry.content, terms, WEIGHT_CONTENT)
  if (raw === 0) return 0
  return raw / (1 + Math.log1p(String(rule.content ?? '').length / 200))
}

/**
 * 从候选规则里挑出这一轮该注入的几条。
 *
 * @param rules 候选（调用方已按「启用 + mode=auto + 本目录生效」过滤）
 * @param signal 场景信号文本（当前这条用户消息 + 最近几条 + 工作目录拼在一起）
 * @param options.pinned 已命中过的规则 id（sticky：优先保留，但最多占 limit-1 个名额，
 *                       否则新场景永远挤不进来）
 * @param options.threshold / options.limit / options.budget 可覆盖上面的常量
 * @returns `{ matched, skipped, terms }`；matched 里 pinned 在前、新命中按分数降序在后
 */
export function selectSceneRules(rules, signal, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : SCENE_THRESHOLD
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : SCENE_LIMIT
  const budget = Number.isFinite(options.budget) && options.budget > 0 ? options.budget : SCENE_BUDGET_CHARS
  const pinned = Array.isArray(options.pinned) ? options.pinned : []
  const terms = tokenize(signal)

  const pinnedIds = pinned.slice(Math.max(0, pinned.length - Math.max(1, limit - 1)))
  const pinnedSet = new Set(pinnedIds)
  const scored = []
  for (const rule of rules) {
    if (pinnedSet.has(rule.id)) continue
    const score = scoreRule(rule, terms)
    if (score >= threshold) scored.push({ rule, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.rule.id < b.rule.id ? -1 : 1))

  const matched = []
  let used = 0
  for (const rule of rules) {
    if (!pinnedSet.has(rule.id)) continue
    matched.push(rule)
    used += sizeOf(rule)
  }
  const skipped = []
  for (const entry of scored) {
    if (matched.length >= limit) {
      skipped.push(entry.rule)
      continue
    }
    const size = sizeOf(entry.rule)
    // 预算只对新命中的生效：pinned 已经在上一轮的上下文里了，把它挤掉只会让
    // 模型看到「规则时有时无」，代价（一次尾部未命中）却已经付过了。
    // `matched.length > 0` 这个前提不能少：否则一条自己就超预算的规则永远进不来 ——
    // 而它往往正是最该被送达的那一条。
    if (matched.length > 0 && matched.length >= pinnedIds.length && used + size > budget) {
      skipped.push(entry.rule)
      continue
    }
    matched.push(entry.rule)
    used += size
  }
  return { matched, skipped, terms }
}

function sizeOf(rule) {
  return String(rule?.title ?? '').length + String(rule?.content ?? '').length
}

/**
 * 命中集合的内容指纹：集合不变就不重复注入（每次注入都是尾部一条新消息，
 * 会留在历史里）。用 id + 标题 + 正文一起算，规则被编辑过也会被认成「变了」。
 */
export function sceneDigest(rules) {
  const hash = createHash('sha256')
  for (const rule of rules) {
    hash.update(String(rule.id)).update('\u0000').update(String(rule.title)).update('\u0000').update(String(rule.content)).update('\u0001')
  }
  return hash.digest('hex').slice(0, 16)
}
