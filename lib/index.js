/**
 * ian-rules 宿主半体（Cordis 插件，运行在 DSH 宿主进程）。
 *
 * 职责：
 *   1. 存储：把「开发规则」文档持久化到 $DSH_HOME/ian-rules.json（原子写 +
 *      保存前留一份 .bak），并在外部改动时自动重载（监听目录 + 低频轮询兜底）。
 *   2. 注入：注册 `ian_rules_body` 提示变量 + 一个引用它的系统提示 section，
 *      每次组装提示时按当前会话工作目录解析生效规则并渲染。没有生效规则就返回
 *      空串，等于不注入。
 *      —— 正文走 variable 而不是直接当 section 正文，是因为 DSH 会对 section 文本
 *      做严格的 `{{变量}}` 插值（未知引用直接抛错），用户规则里的 `{{…}}` 会把
 *      整个模型步打挂；变量值不会被二次扫描。
 *   3. 面板接口：/ian-rules/* 的 JSON 接口（带同源校验），供右侧栏面板读写、
 *      预览、取工作区列表。保存带 revision，过期返回 409 而不是静默覆盖。
 *   4. 工具：ian_rules 模型工具，让对话里的 agent 能自行查看 / 新增 / 修改 / 删除。
 *
 * 除 node 内置模块与同目录的 rules.js 外不依赖任何包，所有注册都用
 * ctx.effect 包住，卸载插件时不留副作用。
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  MAX_CONTENT,
  MAX_GROUP,
  MAX_RULES,
  MAX_SECTION_CHARS,
  MAX_TITLE,
  emptyDoc,
  effectiveRules,
  estimateTokens,
  newId,
  normalizePath,
  parseMarkdownDoc,
  renderRules,
  ruleSize,
  sanitizeDoc,
  summarizeDoc,
  toMarkdownDoc,
} from './rules.js'

// ---------------------------------------------------------------------------
// 身份与契约常量。改名时**先看这一块**再动手：它和 lib/client.js 顶部的同名块、
// package.json 的 name、cordis.patch.yml 的 name 必须一致，
// `npm run check:identity` 会把这几处对一遍（改漏一处，客户端注册对不上包名会直接
// 报「Failed to load plugins」，而宿主接口看起来一切正常）。
// ---------------------------------------------------------------------------

/** 插件名（Cordis 插件身份，与页签实现 id 同一来源）。 */
export const name = 'ian-rules'
export const inject = ['webServer', 'systemPrompt', 'tools']

/** 面板接口的路由前缀。 */
const ROUTE = '/ian-rules'

/** 提示变量的名字：section 正文只写 `{{ian_rules_body}}`。 */
const BODY_VARIABLE = 'ian_rules_body'

/** 规则文件名（$DSH_HOME 下）。 */
const FILE_NAME = 'ian-rules.json'
/**
 * 更名前历代的数据文件（由新到旧）：`agent-rules.json` 是 dsh-agent-rules 时代的名字，
 * `dev-rules.json` 是更早的 dsh-dev-rules 时代的名字。老用户的规则还留在这些名字下，
 * 启动时取**第一个存在**的复制到新名字下（见 migrateLegacyFile）。
 */
const LEGACY_FILE_NAMES = ['agent-rules.json', 'dev-rules.json']

/** 文件监听不可用时的兜底轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 15000

/** 单次请求体上限，防止面板之外的调用把内存写爆。 */
const MAX_BODY_CHARS = 4_000_000

export function apply(ctx) {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  const file = path.join(home, FILE_NAME)
  const backupFile = file + '.bak'
  /** 更名前历代的数据文件（按新 → 旧）：迁移时取第一个存在的那个。 */
  const legacyFiles = LEGACY_FILE_NAMES.map((legacyName) => path.join(home, legacyName))
  /** 本次启动是否发生了一次更名迁移（只在内存里，重启后不再提示）。 */
  let migratedFrom = ''

  /** 内存中的权威状态：doc 规范化后的文档，error 为最近一次读写错误。 */
  let doc = emptyDoc()
  let loadError = ''
  let revision = 0
  let knownMtime = 0
  /** 是否已经从磁盘读过一次：决定首次装载要不要算作「内容变了」。 */
  let loaded = false

  /** 工作目录 → realpath 的小缓存（软链工作目录的项目匹配回退）。 */
  const realpathCache = new Map()

  function warn(message) {
    try {
      const logger = ctx.logger
      if (logger && typeof logger.warn === 'function') logger.warn('[ian-rules] ' + message)
      else process.stderr.write('[ian-rules] ' + message + '\n')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /**
   * 更名迁移：新名字的数据文件还不存在、旧名字的还在 → 拷一份过去。
   *
   * 用**拷贝**而不是改名：这份文件是用户自己攒的规则，回退到旧版本插件时它必须还在
   * 原处读得到。拷贝失败就继续用旧文件（下面的 loadFromDisk 会兜住），绝不因为
   * 迁移失败而让用户看不到自己的规则。
   */
  function migrateLegacyFile() {
    try {
      if (existsSync(file)) return
      const legacyFile = legacyFiles.find((candidate) => existsSync(candidate))
      if (legacyFile === undefined) return
      copyFileSync(legacyFile, file)
      migratedFrom = legacyFile
      warn('检测到更名前的数据文件，已复制到 ' + FILE_NAME + '（原文件保留）')
    } catch (error) {
      warn('迁移更名前的数据文件失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * 从磁盘同步读取（启动与外部改动都走这里）。文件不存在视为空文档。
   *
   * revision 只在**内容真的变了**时前进。目录监听会把本插件自己的保存也当成一次事件
   * 汇报上来（原子写是 rename，目录事件才可靠），若无条件自增，保存成功后 250ms
   * revision 就会自己再涨一格 —— 面板拿着保存响应里的那个 revision 再保存一次，
   * 就会撞上一个「别处改过磁盘」的 409，而磁盘上其实没人动过。
   * 冲突提示必须只在真有外部改动时出现，否则用户会学会无视它。
   */
  function loadFromDisk() {
    const before = loaded ? JSON.stringify(doc) : null
    let mtime = 0
    try {
      mtime = existsSync(file) ? statSync(file).mtimeMs : 0
    } catch {
      mtime = 0
    }
    let next = null
    try {
      next = existsSync(file) ? sanitizeDoc(JSON.parse(readFileSync(file, 'utf8'))) : emptyDoc()
    } catch (error) {
      // 读不动就保留内存里那一份：既不推翻现有规则，也不假装磁盘变了
      loadError = FILE_NAME + ' 读取失败：' + (error instanceof Error ? error.message : String(error))
      knownMtime = mtime
      warn(loadError)
      return
    }
    knownMtime = mtime
    doc = next
    loadError = ''
    if (before === null || before !== JSON.stringify(next)) revision += 1
    loaded = true
  }

  /** 保存前留一份上一版（尽力而为，失败不影响保存）。 */
  async function backupPrevious() {
    try {
      if (existsSync(file)) await copyFile(file, backupFile)
    } catch (error) {
      warn('备份 ' + FILE_NAME + ' 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * 每次保存用一个唯一的临时文件名：同名并发写会互相覆盖 ——
   * 后到的 `rename` 拿到的是已经被前一个请求搬走的路径（ENOENT → 500），
   * 两次写入还可能交错进同一个文件。同进程的多个 /save、以及共用
   * $DSH_HOME 的两个 profile，都靠这个唯一名隔开。
   */
  const tempFile = () => file + '.' + String(process.pid) + '.' + randomUUID() + '.tmp'

  /** 原子写入：先写临时文件再 rename，避免保存过程中被读到半截文件。 */
  async function persist(next) {
    const safe = sanitizeDoc(next)
    await mkdir(home, { recursive: true })
    await backupPrevious()
    const temp = tempFile()
    try {
      await writeFile(temp, JSON.stringify(safe, null, 2) + '\n', 'utf8')
      await rename(temp, file)
    } catch (error) {
      // 临时名唯一，就没有别的请求会替我清掉这一个；留着会在 $DSH_HOME 里越积越多
      try {
        await unlink(temp)
      } catch {
        /* 临时文件可能压根没建起来 */
      }
      throw error
    }
    doc = safe
    loadError = ''
    revision += 1
    try {
      knownMtime = statSync(file).mtimeMs
    } catch {
      knownMtime = 0
    }
    return doc
  }

  function meta() {
    return {
      file,
      backupFile,
      home,
      revision,
      // 更名迁移的来源文件（'' = 没发生迁移）。只在内存里，重启后不再提示。
      migratedFrom,
      error: loadError,
      maxSectionChars: MAX_SECTION_CHARS,
      // 逐条上限随 /state 下发：panel 据此设 maxLength 并解释「为什么打不进去」，
      // 免得宿主在保存时静默截断 / 丢条目，而面板看不出原因（常量只有这一处出处）。
      limits: { title: MAX_TITLE, group: MAX_GROUP, content: MAX_CONTENT, rules: MAX_RULES },
      summary: summarizeDoc(doc),
    }
  }

  // 先迁移更名前那份数据文件，再读盘：否则第一天启动会读到「空文档」而看不到自己的规则
  migrateLegacyFile()
  loadFromDisk()

  // ---- 1) 外部改动自动重载：监听目录（原子写是 rename，目录事件才可靠）+ 轮询兜底 ----
  ctx.effect(
    () => {
      let debounce = null
      const schedule = () => {
        if (debounce !== null) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          loadFromDisk()
        }, 250)
      }
      let watcher = null
      try {
        mkdirSync(home, { recursive: true })
        watcher = watch(home, { persistent: false }, (_event, filename) => {
          if (filename === null || filename === undefined || String(filename) === FILE_NAME) schedule()
        })
      } catch (error) {
        warn('目录监听不可用，退回轮询：' + (error instanceof Error ? error.message : String(error)))
      }
      const poll = setInterval(() => {
        try {
          const stat = existsSync(file) ? statSync(file) : null
          const mtime = stat === null ? 0 : stat.mtimeMs
          if (mtime !== knownMtime) loadFromDisk()
        } catch {
          /* 文件被删除或权限变化：下一轮再试 */
        }
      }, POLL_INTERVAL_MS)
      if (typeof poll.unref === 'function') poll.unref()
      return () => {
        if (debounce !== null) clearTimeout(debounce)
        clearInterval(poll)
        if (watcher !== null) {
          try {
            watcher.close()
          } catch {
            /* 已经关掉了 */
          }
        }
      }
    },
    'ian-rules: 规则文件监听',
  )

  // ---- 2) 系统提示注入（变量 + 常量 section）----
  // 组装上下文里 scope 就是 Agent 本身（assembleFrom 传 { agent, scope: agent }），
  // 因此能稳定拿到 session.header.cwd；取不到时只注入全局规则，绝不猜测目录。
  const cwdOfAssembly = (assembly) => {
    if (assembly === null || typeof assembly !== 'object') return ''
    const agent = assembly.agent ?? assembly.scope
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    return typeof assembly.cwd === 'string' ? assembly.cwd : ''
  }

  /** 软链工作目录的兜底：目录没命中项目时才解析 realpath 再试一次。 */
  function realCwdOf(cwd) {
    const now = Date.now()
    const hit = realpathCache.get(cwd)
    if (hit !== undefined && now - hit.at < 10000) return hit.value
    let value = ''
    try {
      value = realpathSync.native(cwd)
    } catch {
      value = ''
    }
    if (realpathCache.size > 200) realpathCache.clear()
    realpathCache.set(cwd, { at: now, value })
    return value
  }

  function rulesTextFor(cwd) {
    try {
      if (typeof cwd !== 'string' || cwd === '') return renderRules(doc, '')
      if (effectiveRules(doc, cwd).project !== null) return renderRules(doc, cwd)
      const real = realCwdOf(cwd)
      if (real === '' || real === cwd) return renderRules(doc, cwd)
      return renderRules(doc, real)
    } catch (error) {
      warn('渲染规则失败：' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.variable(BODY_VARIABLE, (assembly) => {
        try {
          return rulesTextFor(cwdOfAssembly(assembly))
        } catch (error) {
          warn('读取规则失败：' + (error instanceof Error ? error.message : String(error)))
          return ''
        }
      }),
    'ian-rules: 规则变量',
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:ian-rules',
        // 100：紧跟 deployment persona（0）之后、各类工具说明（900+）之前，
        // 让规则读起来像「用户给的工作约定」而不是某个工具的使用手册。
        order: 100,
        // 常量正文：正文由变量提供，用户内容不会被 `{{变量}}` 插值扫描。
        text: '{{' + BODY_VARIABLE + '}}',
      }),
    'ian-rules: 系统提示 section',
  )

  // ---- 3) 面板 HTTP 接口 ----
  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * 只接受本页面发来的请求：浏览器跨站请求带 Sec-Fetch-Site: cross-site 或
   * 不匹配的 Origin，一律拒绝；curl / 本地脚本没有这些头，照常可用。
   */
  function requestTrusted(req) {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const host = req.headers.host
      if (typeof host !== 'string' || host === '') return false
      try {
        if (new URL(origin).host !== host) return false
      } catch {
        return false
      }
    }
    return true
  }

  const isJsonRequest = (req) => {
    const type = req.headers['content-type']
    return typeof type === 'string' && type.toLowerCase().includes('application/json')
  }

  /** 带 HTTP 状态码的错误：由 handler 统一映射，缺省 500。 */
  class HttpError extends Error {
    constructor(status, message) {
      super(message)
      this.status = status
    }
  }

  const readBody = async (req) => {
    // 逐块解码必须交回同一个 StringDecoder，而不是对每个 chunk 各调一次 toString()：
    // 多字节字符（中文规则正文几乎全是）落在两个 TCP 分段的中间时，逐块解码会把两边
    // 各转成一个 U+FFFD，存盘后规则正文里就多出几个问号菱形。StringDecoder 会把没解完的
    // 半个字符留到下一块；按字符计数也正好是 MAX_BODY_CHARS 的语义。
    const decoder = new StringDecoder('utf8')
    let text = ''
    for await (const chunk of req) {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (text.length > MAX_BODY_CHARS) throw new HttpError(413, '请求体过大')
    }
    text += decoder.end()
    return text
  }

  const readJsonBody = async (req) => {
    if (!isJsonRequest(req)) throw new HttpError(415, '需要 Content-Type: application/json')
    const text = await readBody(req)
    if (text.trim() === '') return {}
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // 客户端发来的体不合法是 400，不是服务端故障；原来它一路冒到统一映射里变成 500，
      // 排查时会去翻宿主日志，而问题其实在请求那边。
      throw new HttpError(400, '请求体不是合法 JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
    return parsed
  }

  /** 面板「项目路径」下拉的数据源：工作区注册表 + 活动会话的工作目录。 */
  function workspaceEntries() {
    const out = []
    const seen = new Set()
    const add = (candidate, title) => {
      const normalized = normalizePath(candidate)
      if (normalized === '' || seen.has(normalized)) return
      seen.add(normalized)
      out.push({ path: normalized, title: typeof title === 'string' ? title : '' })
    }
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
        for (const workspace of registry.list()) add(workspace?.path, workspace?.title)
      }
    } catch (error) {
      warn('读取工作区列表失败：' + (error instanceof Error ? error.message : String(error)))
    }
    try {
      const sessions = ctx.get('sessions')
      if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
        for (const session of sessions.list()) add(session?.header?.cwd, '')
      }
    } catch {
      /* 会话存储不可用时只用工作区列表 */
    }
    return out.slice(0, 40)
  }

  function previewPayload(draft, target) {
    const effective = effectiveRules(draft, target)
    const text = renderRules(draft, target, { limit: Number.POSITIVE_INFINITY })
    const injected = renderRules(draft, target)
    return {
      ok: true,
      path: normalizePath(target),
      text,
      injected,
      chars: text.length,
      injectedChars: injected.length,
      tokens: estimateTokens(text),
      injectedTokens: estimateTokens(injected),
      truncated: injected.length < text.length,
      matched:
        effective.project === null
          ? null
          : { path: effective.project.path, label: effective.project.label, mode: effective.project.mode },
      counts: {
        global: effective.globalRules.length,
        project: effective.projectRules.length,
        suppressed: effective.suppressedGlobalRules.length,
      },
      rules: effective.rules.map((rule) => {
        const size = ruleSize(rule)
        return { id: rule.id, title: rule.title, group: rule.group, chars: size.chars, tokens: size.tokens }
      }),
    }
  }

  const handler = async (req, res) => {
    try {
      if (!requestTrusted(req)) {
        sendJson(res, 403, { ok: false, error: '拒绝跨站请求（Origin / Sec-Fetch-Site 校验未通过）' })
        return
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const route = url.pathname

      if (route === ROUTE + '/state' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, doc, meta: meta() })
        return
      }

      if (route === ROUTE + '/export' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const draft = body.doc === undefined ? doc : sanitizeDoc(body.doc)
        sendJson(res, 200, {
          ok: true,
          markdown: toMarkdownDoc(draft),
          json: JSON.stringify(draft, null, 2) + '\n',
          summary: summarizeDoc(draft),
        })
        return
      }

      if (route === ROUTE + '/import' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim() === '') throw new HttpError(400, '导入内容为空')
        const looksJson = text.trim().startsWith('{') || text.trim().startsWith('[')
        let imported
        try {
          imported = looksJson ? sanitizeDoc(JSON.parse(text)) : parseMarkdownDoc(text)
        } catch (error) {
          throw new HttpError(400, '导入解析失败：' + (error instanceof Error ? error.message : String(error)))
        }
        sendJson(res, 200, {
          ok: true,
          format: looksJson ? 'json' : 'markdown',
          doc: imported,
          summary: summarizeDoc(imported),
        })
        return
      }

      if (route === ROUTE + '/workspaces' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, workspaces: workspaceEntries() })
        return
      }

      if (route === ROUTE + '/save' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const sentRevision = typeof body.revision === 'number' ? body.revision : undefined
        if (sentRevision !== undefined && sentRevision !== revision) {
          sendJson(res, 409, {
            ok: false,
            conflict: true,
            error: '规则已被外部修改（文件被手工编辑，或另一个会话用 ian_rules 改过）；请先重新载入再保存，以免覆盖。',
            doc,
            meta: meta(),
          })
          return
        }
        await persist(body.doc === undefined ? body : body.doc)
        sendJson(res, 200, { ok: true, doc, meta: meta(), notice: '已保存，正在运行的会话下一步即生效' })
        return
      }

      if (route === ROUTE + '/reload' && req.method === 'POST') {
        if (!isJsonRequest(req)) throw new HttpError(415, '需要 Content-Type: application/json')
        loadFromDisk()
        sendJson(res, 200, { ok: true, doc, meta: meta() })
        return
      }

      if (route === ROUTE + '/preview' && (req.method === 'GET' || req.method === 'POST')) {
        let target = url.searchParams.get('path') || ''
        let draft = doc
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.path === 'string' && body.path !== '') target = body.path
          if (body.doc !== undefined) draft = sanitizeDoc(body.doc)
        }
        if (target === '') target = process.cwd()
        sendJson(res, 200, previewPayload(draft, target))
        return
      }

      sendJson(res, 404, { ok: false, error: '未知接口：' + route })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'ian-rules: 面板接口')

  // ---- 4) ian_rules 工具 ----
  const cloneDoc = () => sanitizeDoc(JSON.parse(JSON.stringify(doc)))

  const findRule = (target, id) => {
    for (const rule of target.global) if (rule.id === id) return { rule, list: target.global, scope: 'global', project: null }
    for (const project of target.projects) {
      for (const rule of project.rules) if (rule.id === id) return { rule, list: project.rules, scope: 'project', project }
    }
    return null
  }

  const projectFor = (target, projectPath) => {
    const normalized = normalizePath(projectPath)
    if (normalized === '') return null
    let found = target.projects.find((project) => project.path === normalized)
    if (found === undefined) {
      found = { id: newId('p'), path: normalized, label: '', enabled: true, mode: 'append', rules: [] }
      target.projects.push(found)
    }
    return found
  }

  const cwdOfExec = (exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : ''
  }

  const asText = (value) => (typeof value === 'string' ? value.trim() : '')

  const tool = {
    name: 'ian_rules',
    description:
      '查看与维护本机的「项目开发规则」（由 ian-rules 插件维护，规则会自动注入系统提示）。用户说「把这条记进开发规则 / 看一下开发规则 / 删掉某条规则」时用它。action 取值：list（查看当前目录或指定路径下生效的规则）、add（新增规则）、update（修改标题 / 正文 / 分组 / 启用状态）、remove（删除规则）。scope=global 表示全局规则，scope=project 表示某个项目的规则（用 path 指定项目目录，默认当前会话工作目录）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: '要执行的动作' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'add 时的归属：global 全局规则（默认），project 项目规则' },
        path: { type: 'string', description: '目录路径：list 看该目录的生效规则；add(scope=project) 指定规则归属的项目；缺省用当前会话工作目录' },
        id: { type: 'string', description: '规则 id（update / remove 必填，list 的输出里带 id）' },
        title: { type: 'string', description: '规则标题（add 建议填；update 可改）' },
        content: { type: 'string', description: '规则正文：具体、可执行的约定（add 必填；update 可改）' },
        group: { type: 'string', description: '可选分组名（面板按分组展示，注入文本里作为小标题）' },
        enabled: { type: 'boolean', description: '是否启用该规则（update 时用；add 默认启用）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, data: { type: 'string' }, notice: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && (value.notice || value.data)) || '' }]
      },
    },
    async execute(args, exec) {
      const action = asText(args?.action) || 'list'
      const sessionCwd = cwdOfExec(exec)
      const explicitPath = asText(args?.path)

      if (action === 'list') {
        const target = explicitPath !== '' ? explicitPath : sessionCwd
        const effective = effectiveRules(doc, target)
        const lines = []
        lines.push('规则文件：' + file + '（备份 ' + backupFile + '）')
        lines.push('全局规则 ' + String(effective.globalRules.length) + ' 条启用 / ' + String(doc.global.length) + ' 条总计' + (doc.enabled ? '' : '（规则总开关已关闭，当前不会注入）'))
        for (const rule of doc.global) {
          lines.push('- [' + rule.id + '] ' + (rule.enabled ? '启用' : '停用') + ' ' + (rule.group === '' ? '' : '#' + rule.group + ' ') + (rule.title || '(无标题)'))
        }
        lines.push('项目规则集 ' + String(doc.projects.length) + ' 个：')
        for (const project of doc.projects) {
          lines.push(
            '- [' + project.id + '] ' + project.path + (project.enabled ? '' : '（已停用）') +
              ' 模式=' + (project.mode === 'override' ? '覆盖全局' : '追加全局') + ' 规则 ' + String(project.rules.length) + ' 条',
          )
          for (const rule of project.rules) lines.push('  · [' + rule.id + '] ' + (rule.enabled ? '启用' : '停用') + ' ' + (rule.title || '(无标题)'))
        }
        if (target !== '') {
          const injected = renderRules(doc, target)
          lines.push('')
          lines.push(
            '路径 ' + (normalizePath(target) || target) + ' 下生效 ' + String(effective.rules.length) + ' 条' +
              '（注入 ' + String(injected.length) + ' 字符 / 约 ' + String(estimateTokens(injected)) + ' token）' +
              (effective.suppressedGlobalRules.length > 0 ? '；覆盖模式挡掉全局 ' + String(effective.suppressedGlobalRules.length) + ' 条' : '') + '：',
          )
          lines.push(renderRules(doc, target, { limit: Number.POSITIVE_INFINITY }) || '（无）')
        }
        return { ok: true, data: lines.join('\n'), notice: '' }
      }

      if (action === 'add') {
        const content = asText(args?.content)
        if (content === '') return { ok: false, data: '', notice: 'add 需要 content（规则正文）' }
        const scope = args?.scope === 'project' ? 'project' : 'global'
        const title = asText(args?.title)
        const group = asText(args?.group)
        const target = cloneDoc()
        if (scope === 'global') {
          const rule = { id: newId('g'), title, content, group, enabled: args?.enabled !== false }
          target.global.push(rule)
          await persist(target)
          return { ok: true, data: rule.id, notice: '已新增全局规则「' + (title || content.slice(0, 20)) + '」（id ' + rule.id + '），已保存并即时生效。' }
        }
        const projectPath = explicitPath !== '' ? explicitPath : sessionCwd
        if (projectPath === '') return { ok: false, data: '', notice: 'add(scope=project) 需要 path：请给出项目目录，或在有工作目录的会话里调用。' }
        const project = projectFor(target, projectPath)
        const rule = { id: newId('r'), title, content, group, enabled: args?.enabled !== false }
        project.rules.push(rule)
        await persist(target)
        return {
          ok: true,
          data: rule.id,
          notice: '已新增项目规则「' + (title || content.slice(0, 20)) + '」（id ' + rule.id + '，项目 ' + project.path + '），已保存并即时生效。',
        }
      }

      if (action === 'update') {
        const id = asText(args?.id)
        if (id === '') return { ok: false, data: '', notice: 'update 需要 id（可用 action=list 查看）' }
        const target = cloneDoc()
        const hit = findRule(target, id)
        if (hit === null) return { ok: false, data: '', notice: '未找到 id 为 ' + id + ' 的规则' }
        if (typeof args?.title === 'string') hit.rule.title = asText(args.title)
        if (typeof args?.content === 'string' && asText(args.content) !== '') hit.rule.content = asText(args.content)
        if (typeof args?.group === 'string') hit.rule.group = asText(args.group)
        if (typeof args?.enabled === 'boolean') hit.rule.enabled = args.enabled
        if (hit.rule.title === '' && hit.rule.content !== '') hit.rule.title = hit.rule.content.split('\n')[0].slice(0, 120)
        await persist(target)
        return { ok: true, data: hit.rule.id, notice: '已更新规则「' + (hit.rule.title || hit.rule.id) + '」（' + hit.scope + '）。' }
      }

      if (action === 'remove') {
        const id = asText(args?.id)
        if (id === '') return { ok: false, data: '', notice: 'remove 需要 id（可用 action=list 查看）' }
        const target = cloneDoc()
        const hit = findRule(target, id)
        if (hit === null) return { ok: false, data: '', notice: '未找到 id 为 ' + id + ' 的规则' }
        const index = hit.list.findIndex((rule) => rule.id === id)
        hit.list.splice(index, 1)
        await persist(target)
        return { ok: true, data: id, notice: '已删除规则「' + (hit.rule.title || id) + '」（' + hit.scope + '）。' }
      }

      return { ok: false, data: '', notice: '不支持的动作：' + action }
    },
  }

  ctx.effect(() => ctx.tools.register(tool), 'ian-rules: ian_rules 工具')
}
