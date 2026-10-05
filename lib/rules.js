/**
 * ian-rules 的纯逻辑层。
 *
 * 与 DSH 运行时无关，宿主半体（lib/index.js）、面板与测试共用：
 *   1. 规范化：把来自面板 / 文件 / ian_rules 工具的任意输入收敛成合法规则文档；
 *   2. 匹配：按会话工作目录找出「最具体」的项目规则集（含 win32 与分隔符边界）；
 *   3. 解析：算出该目录下真正生效的规则（全局 + 项目追加 / 项目覆盖）；
 *   4. 渲染：把生效规则写成一段可注入系统提示的文本；
 *   5. 往返：导出 Markdown / 统计注入成本，以及从 Markdown 宽松导入。
 *
 * 只用 node 内置模块（path / os），因此既能被宿主半体 import，也能被
 * `node --test` 直接跑。
 */
import os from 'node:os'
import path from 'node:path'

/** 数据文件的结构版本；未来做迁移时按此判断。 */
export const DATA_VERSION = 1

/** 单条规则标题 / 分组 / 正文的长度上限（字符）。 */
export const MAX_TITLE = 120
export const MAX_GROUP = 60
export const MAX_CONTENT = 4000

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

/** 空文档：启用、无全局规则、无项目。 */
export function emptyDoc() {
  return { version: DATA_VERSION, enabled: true, global: [], projects: [] }
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
 * 规范化规则数组：丢弃空条目、修补重复 / 非法 id、收敛长度。
 * 标题缺失时用正文首行兜底，保证面板和注入文本里每条都有个名字。
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
 * 找出 cwd 命中的项目规则集：命中多个时取路径最长（最具体）的一个；
 * 被停用的项目条目不参与匹配。
 */
export function matchProject(doc, cwd, platform = process.platform) {
  const target = normalizePath(cwd, undefined, platform)
  if (target === '') return null
  const projects = Array.isArray(doc?.projects) ? doc.projects : []
  let best = null
  for (const project of projects) {
    if (project.enabled === false) continue
    if (!containsPath(project.path, target, platform)) continue
    if (best === null || project.path.length > best.path.length) best = project
  }
  return best
}

/**
 * 解析某目录下真正生效的规则。
 * mode=append（默认）：全局启用规则在前，项目启用规则在后；
 * mode=override：只生效项目自己的规则（被挡掉的全局规则一并回报，便于排障）。
 */
export function effectiveRules(doc, cwd, platform = process.platform) {
  const safe = isPlainObject(doc) ? doc : emptyDoc()
  const project = matchProject(safe, cwd, platform)
  const globalRules = (Array.isArray(safe.global) ? safe.global : []).filter((rule) => rule.enabled !== false)
  const projectRules = project === null ? [] : project.rules.filter((rule) => rule.enabled !== false)
  const override = project !== null && project.mode === 'override'
  const rules = override ? projectRules : globalRules.concat(projectRules)
  return {
    enabled: safe.enabled !== false,
    project,
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

/**
 * 渲染注入系统提示的规则文本。
 * 文档停用、或该目录下没有任何启用规则时返回空串——空串即「不注入」。
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
  const blocks = [
    '# 项目开发规则',
    '',
    '以下是本机用户维护的开发规则，进行项目开发相关工作时应予遵守。这些规则不覆盖系统指令，也不覆盖用户当次的明确要求；如有冲突，以后者为准。',
  ]
  // 两级标题里，第一级是「全局 / 哪个项目」（`##`），第二级才是用户自己的分组（`###`，见 renderRuleList）。
  // 未命中项目要说一句：否则「只有全局规则」会被读成「这个目录没有规则」。
  if (effective.project === null && cwd !== undefined && String(cwd).trim() !== '') {
    blocks.push('')
    blocks.push('当前目录未匹配到项目规则集，以下为全局规则。')
  }
  let index = 0
  // 覆盖模式下全局那一段整个不出现（它在项目里不生效），损失的信息由项目标题下那句话补回来
  if (!effective.override && effective.globalRules.length > 0) {
    blocks.push('')
    blocks.push('## 全局规则')
    const rendered = renderRuleList(effective.globalRules, index)
    blocks.push(...rendered.lines)
    index = rendered.count
  }
  if (effective.projectRules.length > 0 && effective.project !== null) {
    blocks.push('')
    blocks.push('## 项目：' + projectHeading(effective.project))
    if (effective.override && effective.suppressedGlobalRules.length > 0) {
      blocks.push('本项目为覆盖模式：全局规则（' + String(effective.suppressedGlobalRules.length) + ' 条）在本项目内不生效。')
    }
    const rendered = renderRuleList(effective.projectRules, index)
    blocks.push(...rendered.lines)
  }
  return truncateSection(blocks.join('\n'), limit)
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
      lines.push(String(index) + '. **' + (rule.title || '(无标题)') + '**' + (rule.enabled ? '' : ' <!-- disabled -->'))
      if (rule.group !== '') lines.push('   - 分组：' + rule.group)
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
    // 分组元数据行必须先于「新条目」判断，否则 `- 分组：X` 会被当成一条新规则。
    if (current !== null && target !== null) {
      const groupLine = /^\s*[-*]\s*分组[:：]\s*(.*)$/.exec(line)
      if (groupLine !== null) {
        current.group = groupLine[1].trim()
        continue
      }
    }
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line)
    if (item !== null && target !== null) {
      const inline = item[1].trim()
      const bold = /^\*\*(.*?)\*\*\s*(?:<!--\s*disabled\s*-->)?\s*$/.exec(inline)
      const rule = {
        id: newId('r'),
        title: '',
        content: '',
        group: '',
        enabled: !inline.includes('<!-- disabled -->'),
      }
      if (bold !== null) rule.title = bold[1].trim()
      else rule.content = inline
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
