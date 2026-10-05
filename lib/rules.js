/**
 * ian-rules 的纯逻辑层。
 *
 * 与 DSH 运行时无关，宿主半体（lib/index.js）、面板与测试共用：
 *   1. 规范化：把来自面板 / 文件 / ian_rules 工具的任意输入收敛成合法规则文档；
 *   2. 匹配：按会话工作目录找出命中的项目规则集（含 win32 与分隔符边界）；
 *      命中多层时按「父级在前」串成一条链，不再只取最具体的一个；
 *   3. 解析：算出该目录下真正生效的规则（全局 + 项目链叠加 / 链上 override 截断）；
 *   4. 渲染：把生效规则写成一段可注入系统提示的文本；
 *   5. 往返：导出 Markdown / 统计注入成本，以及从 Markdown 宽松导入。
 *
 * 只用 node 内置模块（path / os），因此既能被宿主半体 import，也能被
 * `node --test` 直接跑。
 */
import os from 'node:os'
import path from 'node:path'

/** 数据文件的结构版本；未来做迁移时按此判断。v2 起规则带 mode / tags、文档带 sceneMatching。 */
export const DATA_VERSION = 2

/** 单条规则标题 / 分组 / 正文的长度上限（字符）。 */
export const MAX_TITLE = 120
export const MAX_GROUP = 60
export const MAX_CONTENT = 4000

/** 一条规则最多几个标签、单个标签多长。 */
export const MAX_TAGS = 8
export const MAX_TAG = 24

/**
 * 规则的生效方式：
 *   - `always`（默认）：常驻注入，每次组装都在系统提示里；
 *   - `auto`：按场景匹配后才注入（走消息尾部，见 README「注入形态」）。
 * 只有用户显式改了才会是 auto —— 老文档（v1）补默认值时一律 always，行为不变。
 */
export const RULE_MODE_ALWAYS = 'always'
export const RULE_MODE_AUTO = 'auto'

/** 场景匹配总开关的取值（缺省 `off`，即与旧版行为一致）。 */
export const SCENE_MATCHING_OFF = 'off'
export const SCENE_MATCHING_AUTO = 'auto'

/** 一份文档最多接受的规则条数与项目条目数。 */
export const MAX_RULES = 300
export const MAX_PROJECTS = 200

/** 单次注入系统提示的文本上限；超出即截断并附提示。 */
export const MAX_SECTION_CHARS = 12000

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const WINDOWS_ABS = /^[A-Za-z]:[\\/]/
const UNC_ABS = /^\\\\/
/** CJK / 全角字符（token 估算用）。 */
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 空文档：启用、无全局规则、无项目、场景匹配关闭。 */
export function emptyDoc() {
  return { version: DATA_VERSION, enabled: true, sceneMatching: SCENE_MATCHING_OFF, sceneLog: false, global: [], projects: [] }
}

/** 归一化一段自由文本：统一换行、去掉行尾空白、裁掉首尾空白并限长。 */
function normalizeText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 取一个可用作 key 的 id；非法或缺省时回落到生成值。 */
function normalizeId(value, fallback) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : fallback
}

let idSeed = 0
/** 生成一个短 id（面板与工具新增规则时使用）。 */
export function newId(prefix = 'r') {
  idSeed += 1
  return prefix + Date.now().toString(36) + '-' + idSeed.toString(36)
}

/**
 * 规范化标签数组：丢掉空标签、去重、限量。
 * 分隔符由调用方决定（面板是逐个加，Markdown 导入是「、」或逗号分隔）。
 */
export function normalizeTags(raw) {
  const source = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[、,，;；\s]+/) : []
  const out = []
  for (const item of source) {
    const tag = normalizeText(item, MAX_TAG)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * 规范化规则数组：丢弃空条目、修补重复 / 非法 id、收敛长度。
 * 标题缺失时用正文首行兜底，保证面板和注入文本里每条都有个名字。
 * v1 文档没有 mode / tags 字段 → 补成 `always` + 空标签，行为与旧版逐字节一致。
 */
export function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw.slice(0, MAX_RULES)) {
    if (!isPlainObject(item)) continue
    const content = normalizeText(item.content, MAX_CONTENT)
    let title = normalizeText(item.title, MAX_TITLE)
    if (title === '' && content !== '') title = content.split('\n')[0].slice(0, MAX_TITLE)
    if (title === '' && content === '') continue
    let id = normalizeId(item.id, '')
    if (id === '' || seen.has(id)) id = newId('r')
    seen.add(id)
    out.push({
      id,
      title,
      content,
      group: normalizeText(item.group, MAX_GROUP),
      enabled: item.enabled !== false,
      mode: item.mode === RULE_MODE_AUTO ? RULE_MODE_AUTO : RULE_MODE_ALWAYS,
      tags: normalizeTags(item.tags),
    })
  }
  return out
}

/**
 * 把用户输入的目录写成绝对路径：展开 `~`、按当前工作目录补全、
 * 去掉尾部分隔符（根目录除外）。空串表示「未设置」。
 *
 * Windows 形式（`C:\...`、`\\server\share`）无论宿主平台都按 Windows 规则
 * 收敛，这样手工粘贴的 Windows 路径不会被 POSIX resolve 弄坏，win32 分支
 * 也能被测到。
 * @param input 原始路径文本
 * @param base 相对路径的基准目录（缺省为宿主当前工作目录）
 * @param platform 判定路径风格的平台（默认宿主平台）
 */
export function normalizePath(input, base, platform = process.platform) {
  if (typeof input !== 'string') return ''
  let value = input.trim()
  if (value === '') return ''
  const windowsStyle = platform === 'win32' || WINDOWS_ABS.test(value) || UNC_ABS.test(value)
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2))
  if (windowsStyle) {
    let resolved = value.replace(/\//g, '\\')
    if (resolved.length > 3 && resolved.endsWith('\\')) resolved = resolved.slice(0, -1)
    return resolved
  }
  const cwd = typeof base === 'string' && base !== '' ? base : process.cwd()
  let resolved
  try {
    resolved = path.resolve(cwd, value)
  } catch {
    return ''
  }
  if (resolved.length > 1 && resolved.endsWith(path.sep)) resolved = resolved.slice(0, -1)
  return resolved
}

/** 规范化一条项目规则集；路径缺失即视为无效条目（返回 null）。 */
export function normalizeProject(raw, index = 0) {
  if (!isPlainObject(raw)) return null
  const projectPath = normalizePath(raw.path)
  if (projectPath === '') return null
  return {
    id: normalizeId(raw.id, 'p' + String(index + 1)),
    path: projectPath,
    label: normalizeText(raw.label, MAX_TITLE),
    enabled: raw.enabled !== false,
    mode: raw.mode === 'override' ? 'override' : 'append',
    rules: normalizeRules(raw.rules),
  }
}

/** 规范化整份文档：任何输入都收敛成结构完整的合法文档。 */
export function sanitizeDoc(raw) {
  const doc = emptyDoc()
  if (!isPlainObject(raw)) return doc
  doc.enabled = raw.enabled !== false
  doc.sceneMatching = raw.sceneMatching === SCENE_MATCHING_AUTO ? SCENE_MATCHING_AUTO : SCENE_MATCHING_OFF
  // 命中日志默认关：它只对「回头调阈值」有用，平时不该往用户硬盘上写东西
  doc.sceneLog = raw.sceneLog === true
  doc.global = normalizeRules(raw.global)
  const seen = new Set()
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects.slice(0, MAX_PROJECTS)) {
      const project = normalizeProject(item, doc.projects.length)
      if (project === null || seen.has(project.path)) continue
      seen.add(project.path)
      doc.projects.push(project)
    }
  }
  return doc
}

/** 判断 cwd 是否落在 projectPath 之内（含相等）；分隔符与大小写按平台处理。 */
export function containsPath(projectPath, cwd, platform = process.platform) {
  const normalize = (value) => {
    const raw = String(value ?? '')
    if (platform === 'win32') return raw.replace(/\//g, '\\').toLowerCase()
    return raw
  }
  const project = normalize(projectPath)
  const target = normalize(cwd)
  if (project === '' || target === '') return false
  if (project === target) return true
  const separators = platform === 'win32' ? ['\\'] : [path.sep]
  for (const separator of separators) {
    const prefix = project.endsWith(separator) ? project : project + separator
    if (target.startsWith(prefix)) return true
  }
  return false
}

/**
 * 找出 cwd 命中的**全部**项目规则集，按路径由短到长（＝由外到内）排序。
 * 单命中时结果与 {@link matchProject} 相同；monorepo 里父子目录都配了规则时，
 * 父级不再被静默丢弃 —— {@link effectiveRules} 会把这条链按层叠顺序拼起来。
 * 被停用的项目条目不参与匹配。
 */
export function matchProjects(doc, cwd, platform = process.platform) {
  const target = normalizePath(cwd, undefined, platform)
  if (target === '') return []
  const projects = Array.isArray(doc?.projects) ? doc.projects : []
  const hits = []
  for (const project of projects) {
    if (project.enabled === false) continue
    if (!containsPath(project.path, target, platform)) continue
    hits.push(project)
  }
  hits.sort((a, b) => a.path.length - b.path.length)
  return hits
}

/**
 * 找出 cwd 命中的项目规则集：命中多个时取路径最长（最具体）的一个；
 * 被停用的项目条目不参与匹配。
 */
export function matchProject(doc, cwd, platform = process.platform) {
  const hits = matchProjects(doc, cwd, platform)
  return hits.length === 0 ? null : hits[hits.length - 1]
}

/**
 * 解析某目录下真正生效的规则。
 *
 * 层叠规则（自外向内）：命中的项目按路径由短到长依次叠加，父级在前、子级在后；
 * 链上**最后一个 `mode: 'override'` 的项目**会把它之上的所有层（含全局规则）
 * 一并挡掉。因此：
 *   - 只有一层项目 + override → 与旧行为完全一致（只生效项目自己的规则）；
 *   - monorepo（父 append + 子 append）→ 两级规则都在，父级不再被丢掉；
 *   - 父 override + 子 append → 全局被挡，父与子的规则都生效；
 *   - 子 override → 父级与全局都被挡（「覆盖上层全部」）。
 *
 * @returns 生效上下文；`project` 是命中的最具体项目（未命中为 null），
 *          `projects` 是完整命中链，`inheritedProjects` 是链上被继承的父级。
 */
export function effectiveRules(doc, cwd, platform = process.platform) {
  const safe = isPlainObject(doc) ? doc : emptyDoc()
  const projects = matchProjects(safe, cwd, platform)
  const globalRules = (Array.isArray(safe.global) ? safe.global : []).filter((rule) => rule.enabled !== false)
  let cut = 0
  for (let index = 0; index < projects.length; index += 1) {
    if (projects[index].mode === 'override') cut = index
  }
  const override = projects.some((project) => project.mode === 'override')
  const active = projects.slice(cut)
  const projectRules = active.flatMap((project) => project.rules.filter((rule) => rule.enabled !== false))
  const rules = override ? projectRules : globalRules.concat(projectRules)
  const project = projects.length === 0 ? null : projects[projects.length - 1]
  return {
    enabled: safe.enabled !== false,
    sceneMatching: safe.sceneMatching === SCENE_MATCHING_AUTO ? SCENE_MATCHING_AUTO : SCENE_MATCHING_OFF,
    project,
    projects,
    inheritedProjects: active.slice(0, -1),
    globalRules,
    projectRules,
    suppressedGlobalRules: override ? globalRules : [],
    override,
    rules,
  }
}

/**
 * 渲染规则列表：按分组归类（组的先后 = 第一次出现的顺序），组内保持用户排的顺序，
 * 组名作为 `### 组` 小标题，编号在整段里连续。
 * 这样同一组的规则不会因为中间夹了别的组而重复出现多个同名小标题。
 */
function renderRuleList(rules, startIndex = 0) {
  const lines = []
  const order = []
  const buckets = new Map()
  for (const rule of rules) {
    const group = rule.group === undefined ? '' : rule.group
    if (!buckets.has(group)) {
      buckets.set(group, [])
      order.push(group)
    }
    buckets.get(group).push(rule)
  }
  let index = startIndex
  for (const group of order) {
    if (group !== '') lines.push('### ' + group)
    for (const rule of buckets.get(group)) {
      index += 1
      const heading = rule.title === '' ? '' : '**' + rule.title + '**'
      if (rule.content === '') {
        lines.push(String(index) + '. ' + heading)
        continue
      }
      if (heading === '') {
        lines.push(String(index) + '. ' + rule.content.split('\n').join('\n   '))
        continue
      }
      const body = rule.content
        .split('\n')
        .map((line) => (line === '' ? '' : '   ' + line))
        .join('\n')
      lines.push(String(index) + '. ' + heading + '\n' + body)
    }
  }
  return { lines, count: index - startIndex }
}

function truncateSection(text, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text
  const cut = text.slice(0, limit)
  const at = cut.lastIndexOf('\n')
  return (at > 0 ? cut.slice(0, at) : cut) + '\n\n…（开发规则过长，此处已截断；完整内容见「开发规则」面板）'
}

/** 一条「有哪些规则没进来」的说明里最多列几个标题（说明自己不能再变成一段长文本）。 */
const DROPPED_TITLES = 8

/** 「按场景」目录最多列几条（目录是常驻的，不能自己长成一大段）。 */
const INDEX_ENTRIES = 60

/**
 * 被预算裁掉的规则要**说出来**：静默少注入几条，会让 agent 以为自己看到了全部规则，
 * 而用户也没有任何地方能发现这件事。只说标题、限量、并给出可继续查的入口。
 */
function droppedNotice(dropped) {
  const titles = dropped
    .slice(0, DROPPED_TITLES)
    .map((rule) => (rule.title === '' ? '(无标题)' : rule.title))
  return (
    '⚠️ 规则总量超过单次注入上限，本轮有 ' +
    String(dropped.length) +
    ' 条未注入：' +
    titles.join(' / ') +
    (dropped.length > DROPPED_TITLES ? ' 等' : '') +
    '。需要时用 ian_rules 工具按关键词查询，或到「开发规则」面板看全文。'
  )
}

/**
 * 挑下一个该被裁掉的列表。优先级是**项目规则比全局规则具体**，所以先裁全局；
 * 两边都从各自末尾裁（用户排序里靠后的先走），并且**至少留最后一条** ——
 * 全裁光会让整个 section 变成空串，那才是真正的静默失效；剩下那一条由硬截断兜底。
 * @returns 可裁的数组；null 表示已无可裁
 */
function pickDroppable(selection, override) {
  const total = (override ? 0 : selection.global.length) + selection.project.length
  if (total <= 1) return null
  if (!override && selection.global.length > 0) return selection.global
  return selection.project
}

/**
 * 把一份「已经选好的规则集」渲染成注入文本。
 * 显示顺序仍是全局在前、项目在后（与面板一致）；被裁掉的是列表末尾。
 * `index` 是「按场景」规则的**目录**（只有点名与标签，没有正文）：常驻的索引让
 * agent 知道有哪些规则可按需取用，也把 L3 漏命中从「静默失效」降级为「自己会去查」。
 */
function renderSectionText(effective, selection, dropped, cwdGiven, index = []) {
  const blocks = [
    '# 项目开发规则',
    '',
    '以下是本机用户维护的开发规则，进行项目开发相关工作时应予遵守。这些规则不覆盖系统指令，也不覆盖用户当次的明确要求；如有冲突，以后者为准。',
  ]
  // 这句放在头部而不是尾部：尾部截断会把放在末尾的说明一起切掉，正好毁掉它存在的意义
  if (dropped.length > 0) {
    blocks.push('')
    blocks.push(droppedNotice(dropped))
  }
  // 两级标题里，第一级是「全局 / 哪个项目」（`##`），第二级才是用户自己的分组（`###`，见 renderRuleList）。
  // 未命中项目要说一句：否则「只有全局规则」会被读成「这个目录没有规则」。
  if (effective.project === null && cwdGiven) {
    blocks.push('')
    blocks.push('当前目录未匹配到项目规则集，以下为全局规则。')
  }
  let counter = 0
  // 覆盖模式下全局那一段整个不出现（它在项目里不生效），损失的信息由项目标题下那句话补回来
  if (!effective.override && selection.global.length > 0) {
    blocks.push('')
    blocks.push('## 全局规则')
    const rendered = renderRuleList(selection.global, counter)
    blocks.push(...rendered.lines)
    counter = rendered.count
  }
  if (selection.project.length > 0 && effective.project !== null) {
    blocks.push('')
    blocks.push('## 项目：' + projectHeading(effective.project))
    // 命中多个项目时，父子规则已按「父级在前」拼在同一段里 —— 说清楚，
    // 否则 agent 会把父级规则当成当前项目的规则，用户也无从知道继承发生了。
    if (effective.inheritedProjects.length > 0) {
      blocks.push(
        '本段含继承自上层项目的规则（父级在前）：' +
          effective.inheritedProjects.map((project) => project.path).join(' → ') +
          '。',
      )
    }
    if (effective.override && effective.suppressedGlobalRules.length > 0) {
      blocks.push('本项目为覆盖模式：全局规则（' + String(effective.suppressedGlobalRules.length) + ' 条）在本项目内不生效。')
    }
    const rendered = renderRuleList(selection.project, counter)
    blocks.push(...rendered.lines)
  }
  if (index.length > 0) {
    blocks.push('')
    blocks.push('## 按场景规则（目录）')
    blocks.push('以下规则的正文没有常驻在这里：它们按当前任务匹配后单独送达。需要某一条时可以在标题里点名，或用 ian_rules 工具取全文。')
    for (const rule of index.slice(0, INDEX_ENTRIES)) {
      const tags = Array.isArray(rule.tags) && rule.tags.length > 0 ? '（标签：' + rule.tags.join('、') + '）' : ''
      blocks.push('- ' + (rule.title || '(无标题)') + tags)
    }
    if (index.length > INDEX_ENTRIES) blocks.push('- …等 ' + String(index.length - INDEX_ENTRIES) + ' 条')
  }
  return blocks.join('\n')
}

/**
 * 把一组规则渲染成带分组小标题的编号列表（行数组）。
 * 宿主按场景注入时复用同一套排版 —— 面板、系统提示、按场景送达三处必须是同一种读法。
 */
export function renderRuleListLines(rules) {
  return renderRuleList(rules, 0).lines
}

/**
 * 渲染注入系统提示的规则文本。
 * 文档停用、或该目录下没有任何启用规则时返回空串——空串即「不注入」。
 *
 * 超出上限时的裁剪顺序是**先裁全局、再裁项目**（项目规则更具体、更该活下来），
 * 并且把裁掉了哪几条写进提示，避免「静默少注入」。规则数在上限内时输出与
 * 旧版逐字节相同（预览传 `limit: Infinity` 也走这条路径）。
 *
 * 注意：返回值里可能出现用户的任意文本（包括 `{{…}}`），而 DSH 的 prompt
 * section 正文会被 `{{变量}}` 插值扫描（未知引用直接抛错）。所以宿主半体不把
 * 它当 section 正文，而是经 `systemPrompt.variable()` 注入——变量值不会被二次扫描。
 * @param doc 规则文档
 * @param cwd 会话工作目录
 * @param options.limit 文本上限（字符），面板预览可传 Infinity
 * @param options.platform 路径匹配平台（测试用）
 */
export function renderRules(doc, cwd, options = {}) {
  const limit = options.limit === undefined ? MAX_SECTION_CHARS : options.limit
  const effective = effectiveRules(doc, cwd, options.platform)
  if (!effective.enabled || effective.rules.length === 0) return ''
  const cwdGiven = cwd !== undefined && String(cwd).trim() !== ''
  // 开了按场景之后：常驻的只有 `always` 规则，`auto` 规则退成目录（正文由宿主在
  // 消息尾部按场景送达）。没开时一切照旧 —— 这一条是「升级不改行为」的关键。
  const sceneOn = effective.sceneMatching === SCENE_MATCHING_AUTO
  const onlyAlways = (rules) => (sceneOn ? rules.filter((rule) => rule.mode !== RULE_MODE_AUTO) : rules)
  const sceneIndex = sceneOn ? effective.rules.filter((rule) => rule.mode === RULE_MODE_AUTO) : []
  const selection = { global: onlyAlways(effective.globalRules).slice(), project: onlyAlways(effective.projectRules).slice() }
  const dropped = []
  let text = renderSectionText(effective, selection, dropped, cwdGiven, sceneIndex)
  if (Number.isFinite(limit) && limit > 0) {
    while (text.length > limit) {
      const pool = pickDroppable(selection, effective.override)
      if (pool === null) break
      dropped.push(pool.pop())
      text = renderSectionText(effective, selection, dropped, cwdGiven, sceneIndex)
    }
    text = truncateSection(text, limit)
  }
  return text
}

/** 第一级标题里的项目名：有别名就「别名（路径）」，否则只用路径。 */
function projectHeading(project) {
  return project.label === '' ? project.path : project.label + '（' + project.path + '）'
}

/** 粗略的 token 估算：CJK 约 1 字 1 token，其余约 4 字符 1 token。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  const cjk = (text.match(CJK_RANGE) || []).length
  let ascii = 0
  for (const word of text.replace(CJK_RANGE, ' ').split(/\s+/)) ascii += word.length
  return Math.round(cjk + ascii / 4)
}

/** 面板展示用的规模统计。 */
export function summarizeDoc(doc) {
  const safe = sanitizeDoc(doc)
  const projectRules = safe.projects.reduce((total, project) => total + project.rules.length, 0)
  return {
    global: safe.global.length,
    projects: safe.projects.length,
    projectRules,
    enabled: safe.enabled,
  }
}

/** 一条规则在注入文本里的体量（面板用：标出最占预算的规则）。 */
export function ruleSize(rule) {
  const title = String(rule?.title ?? '')
  const content = String(rule?.content ?? '')
  return { chars: title.length + content.length, tokens: estimateTokens(title + ' ' + content) }
}

/** 文档里出现过的分组名（去重、保持出现顺序）。 */
export function groupNames(doc) {
  const names = []
  const seen = new Set()
  const collect = (rules) => {
    for (const rule of rules) {
      if (rule.group !== '' && rule.group !== undefined && !seen.has(rule.group)) {
        seen.add(rule.group)
        names.push(rule.group)
      }
    }
  }
  const safe = isPlainObject(doc) ? doc : emptyDoc()
  collect(Array.isArray(safe.global) ? safe.global : [])
  for (const project of Array.isArray(safe.projects) ? safe.projects : []) collect(project.rules ?? [])
  return names
}

/**
 * 导出成 Markdown（与 {@link parseMarkdownDoc} 往返兼容）。
 * @param doc 规则文档
 * @returns Markdown 文本
 */
export function toMarkdownDoc(doc) {
  const safe = sanitizeDoc(doc)
  const lines = [
    '# 开发规则导出',
    '',
    '> 由 ian-rules 导出；可直接改回 JSON，或用面板「导入」读回这份 Markdown。',
    '',
  ]
  const writeRules = (rules) => {
    let index = 0
    for (const rule of rules) {
      index += 1
      lines.push(
        String(index) +
          '. **' +
          (rule.title || '(无标题)') +
          '**' +
          (rule.enabled ? '' : ' <!-- disabled -->') +
          (rule.mode === RULE_MODE_AUTO ? ' <!-- auto -->' : ''),
      )
      if (rule.group !== '') lines.push('   - 分组：' + rule.group)
      if (rule.tags.length > 0) lines.push('   - 标签：' + rule.tags.join('、'))
      if (rule.content !== '') for (const line of rule.content.split('\n')) lines.push('   ' + line)
      lines.push('')
    }
    if (rules.length === 0) lines.push('（无）', '')
  }
  lines.push('## 全局规则', '')
  writeRules(safe.global)
  for (const project of safe.projects) {
    lines.push(
      '## 项目规则：' +
        project.path +
        (project.label === '' ? '' : ' | ' + project.label) +
        ' [' + project.mode + ']' +
        (project.enabled ? '' : ' [disabled]'),
      '',
    )
    writeRules(project.rules)
  }
  return lines.join('\n')
}

/**
 * 从 Markdown 宽松导入：识别「## 全局规则」与
 * 「## 项目规则：<path> [| 别名] [append|override] [disabled]」分节；
 * 条目形如 `1. **标题**`，其后的缩进行（≥3 空格）算正文，`- 分组：X` 记分组。
 * 认不出的行一律并入当前规则正文，不抛错。
 * @param text Markdown 文本
 * @returns 规范化后的规则文档
 */
export function parseMarkdownDoc(text) {
  const doc = emptyDoc()
  if (typeof text !== 'string' || text.trim() === '') return doc
  // 没有小节标题时，默认把条目收进全局规则（宽松导入）；遇到认不出的小节标题
  // 才停手，避免把无关 Markdown 的列表也吞进来。
  let target = doc.global
  let current = null
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const section = /^##\s*(.+?)\s*$/.exec(line)
    if (section !== null) {
      const heading = section[1]
      current = null
      if (heading.startsWith('全局规则')) {
        target = doc.global
        continue
      }
      const match = /^项目规则[:：]\s*(.*)$/.exec(heading)
      if (match === null) {
        target = null
        continue
      }
      const rest = match[1]
      const mode = rest.includes('[override]') ? 'override' : 'append'
      const enabled = !rest.includes('[disabled]')
      const cleaned = rest.replace(/\[(append|override|disabled)\]/g, '').trim()
      const [pathPart, labelPart] = cleaned.split('|')
      const entry = {
        id: newId('p'),
        path: (pathPart ?? '').trim(),
        label: (labelPart ?? '').trim(),
        enabled,
        mode,
        rules: [],
      }
      doc.projects.push(entry)
      target = entry.rules
      continue
    }
    // 分组 / 标签元数据行必须先于「新条目」判断，否则 `- 分组：X` 会被当成一条新规则。
    if (current !== null && target !== null) {
      const metaLine = /^\s*[-*]\s*(分组|标签)[:：]\s*(.*)$/.exec(line)
      if (metaLine !== null) {
        if (metaLine[1] === '分组') current.group = metaLine[2].trim()
        else current.tags = normalizeTags(metaLine[2])
        continue
      }
    }
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line)
    if (item !== null && target !== null) {
      const inline = item[1].trim()
      // 先摘掉所有 `<!-- … -->` 标记（disabled / auto），剩下的才该拿去认标题，
      // 否则 `**标题** <!-- auto -->` 会因为尾部标记而认不出标题、整行被当成正文。
      const rule = {
        id: newId('r'),
        title: '',
        content: '',
        group: '',
        enabled: !/<!--\s*disabled\s*-->/.test(inline),
        mode: /<!--\s*auto\s*-->/.test(inline) ? RULE_MODE_AUTO : RULE_MODE_ALWAYS,
        tags: [],
      }
      const bare = inline.replace(/<!--[^>]*-->/g, '').trim()
      const bold = /^\*\*(.*?)\*\*$/.exec(bare)
      if (bold !== null) rule.title = bold[1].trim()
      else rule.content = bare
      target.push(rule)
      current = rule
      continue
    }
    if (current !== null && target !== null) {
      const body = /^\s{3,}(.*)$/.exec(line)
      if (body !== null) {
        current.content = current.content === '' ? body[1] : current.content + '\n' + body[1]
        continue
      }
      if (line.trim() !== '') {
        current.content = current.content === '' ? line.trim() : current.content + '\n' + line.trim()
      }
    }
  }
  return sanitizeDoc(doc)
}

/** 导入前预览：这份文本里能识别出多少规则 / 项目。 */
export function countMarkdownRules(text) {
  return summarizeDoc(parseMarkdownDoc(text))
}
