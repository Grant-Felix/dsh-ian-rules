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
import { appendFile, copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  MAX_CONTENT,
  MAX_GROUP,
  MAX_RULES,
  MAX_TAG,
  MAX_TAGS,
  MAX_SECTION_CHARS,
  MAX_TITLE,
  emptyDoc,
  effectiveRules,
  estimateTokens,
  newId,
  normalizePath,
  parseMarkdownDoc,
  renderRuleListLines,
  renderRules,
  ruleSize,
  RULE_MODE_AUTO,
  SCENE_MATCHING_AUTO,
  sanitizeDoc,
  summarizeDoc,
  toMarkdownDoc,
} from './rules.js'
import { SCENE_BUDGET_CHARS, SCENE_THRESHOLD, sceneDigest, scoreRule, selectSceneRules, tokenize } from './scene.js'

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

/** 按场景命中日志的文件名（$DSH_HOME 下）；默认不写，开着才写。 */
const HITS_FILE_NAME = 'ian-rules.hits.jsonl'

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
   * 按场景命中日志（只在文档里开着 sceneLog 时写）。
   * 目的只有一个：回头调匹配阈值时有据可查。尽力而为，写不进去也只 warn ——
   * 日志从来不该影响注入本身。
   */
  const hitsFile = path.join(home, HITS_FILE_NAME)

  function logSceneHit(entry) {
    if (doc.sceneLog !== true) return
    appendFile(hitsFile, JSON.stringify(entry) + '\n', 'utf8').catch((error) => {
      warn('写命中日志失败：' + (error instanceof Error ? error.message : String(error)))
    })
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
      // 「下个会话生效」当前钉住了几个会话：面板据此显示「N 个运行中的会话仍在使用旧规则」
      deferred: { sessions: frozenText.size },
      // 逐条上限随 /state 下发：panel 据此设 maxLength 并解释「为什么打不进去」，
      // 免得宿主在保存时静默截断 / 丢条目，而面板看不出原因（常量只有这一处出处）。
      limits: { title: MAX_TITLE, group: MAX_GROUP, content: MAX_CONTENT, rules: MAX_RULES, tags: MAX_TAGS, tag: MAX_TAG },
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
  //
  // 组装上下文里 `scope` 就是 Agent 本身（dsh-agent 的 assembleContextFor() 传
  // { agent, scope: agent }），因此能稳定拿到 session.header.cwd。
  //
  // ⚠️ 但 `agent` 不在宿主的公开类型里 —— `AssembleContext` 只声明了 `{ scope, signal }`
  // （dsh-system-prompt/lib/types/index.d.ts），`agent` 是 dsh-agent 额外塞的。
  // 所以这里每一层都做类型防御：宿主哪天改了内部结构，插件退化成「只注入全局规则」，
  // 而不是把整个模型步打挂。参数名也不叫 assembly（它并不是整份 assembly）。
  const cwdOfContext = (context) => {
    if (context === null || typeof context !== 'object') return ''
    try {
      const agent = context.agent ?? context.scope
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
      return typeof context.cwd === 'string' ? context.cwd : ''
    } catch {
      // 宿主换了字段形状、或某个 getter 抛错：按「拿不到 cwd」处理，绝不猜目录
      return ''
    }
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

  function renderForCwd(cwd) {
    if (effectiveRules(doc, cwd).project !== null) return renderRules(doc, cwd)
    const real = realCwdOf(cwd)
    if (real === '' || real === cwd) return renderRules(doc, cwd)
    return renderRules(doc, real)
  }

  /**
   * 渲染结果按「文档 revision + 目录」缓存。两个作用：
   *   ① 每个模型步都会重新取值，同样的输入没必要重算（含超限时的逐条裁剪循环）；
   *   ② 保证同一份文档下连续几步返回**逐字节相同**的字符串 —— 提示词前缀缓存
   *      要求它是稳定的，任何漂移都会让系统提示之后的内容一起失效。
   * revision 只在内容真的变时才前进，所以 key 不会撞。
   */
  const textCache = new Map()

  /**
   * 「下个会话生效」用的两个表（key 都是会话 id）：
   *   - sessionText：每个会话最近一次真正渲染出的文本；
   *   - frozenText：被冻结在旧规则上的会话 → 它当时看到的文本。
   *
   * 为什么需要：规则一改，系统提示就变了；正在跑的会话（已经从缓存里吃过旧提示的
   * 那些）下一次请求要重算提示前缀。在有前缀缓存的供应商上，这可能是本插件一整天
   * 规则开销的几十倍。冻结让「改规则」与「正在跑的会话」解耦：
   * 已经渲染过规则的会话继续用旧文本，新会话（以及用户主动切回时）才用新规则。
   * 只冻结「渲染过」的会话是足够的 —— 没渲染过的会话本来就没有旧前缀可保护。
   */
  const sessionText = new Map()
  const frozenText = new Map()

  const sessionIdOfContext = (context) => {
    if (context === null || typeof context !== 'object') return ''
    try {
      const agent = context.agent ?? context.scope
      const id = agent?.session?.id
      return typeof id === 'string' && id !== '' ? id : ''
    } catch {
      return ''
    }
  }

  function rulesTextFor(cwd, sessionId = '') {
    try {
      const frozen = sessionId === '' ? undefined : frozenText.get(sessionId)
      if (frozen !== undefined) return frozen
      if (typeof cwd !== 'string' || cwd === '') {
        const text = renderRules(doc, '')
        if (sessionId !== '') sessionText.set(sessionId, text)
        return text
      }
      const key = String(revision) + '\u0000' + cwd
      const cached = textCache.get(key)
      const text = cached === undefined ? renderForCwd(cwd) : cached
      if (cached === undefined) {
        if (textCache.size > 64) textCache.clear()
        textCache.set(key, text)
      }
      if (sessionId !== '') sessionText.set(sessionId, text)
      return text
    } catch (error) {
      warn('渲染规则失败：' + (error instanceof Error ? error.message : String(error)))
      return ''
    }
  }

  /** 把「已经在用旧规则的会话」钉在它们当时看到的文本上。 */
  function freezeLiveSessions() {
    frozenText.clear()
    for (const [sessionId, text] of sessionText) {
      // 空文本不值得保护：那个会话的上下文里本来就没有规则内容，冻结它只会让新规则用不上
      if (text !== '') frozenText.set(sessionId, text)
    }
    return frozenText.size
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.variable(BODY_VARIABLE, (context) => {
        try {
          return rulesTextFor(cwdOfContext(context), sessionIdOfContext(context))
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

  // ---- 2b) 按场景注入（`mode: 'auto'` 的规则）----
  //
  // 为什么走 `agent/pre-step` 而不是 systemPrompt.context()：
  //   - 唯一能拿到**本步消息**的地方就是这里（assemble 在它之前跑完，inbox 也已被 claim 清空）；
  //     context() 的 provider 只能拿到 { agent, scope, signal }，读不到当前这条用户消息；
  //   - 注入的消息落在**消息尾部**，不动已缓存的前缀。若把这部分塞进系统提示，
  //     它一变，之后的一切（工具定义 + 整段历史）都要按未命中价重算 —— 在未声明
  //     `systemPromptUpdate: "in-history"` 的路由上，这能贵出两个数量级。
  //   - 这也是 DSH 自己的 skill 插件干的事（`<system-reminder>` + 摘要去重）。
  //
  // 宿主不导出 `createUserMessage`，插件也 import 不到宿主包（profile 里没有那些依赖），
  // 所以这里按 session.append 的宽松校验自建一条 user 消息。

  /** 每个会话的按场景状态：本轮已命中的规则 id（轮内 sticky）+ 上次注入的指纹。 */
  const sceneState = new Map()

  function sceneStateOf(sessionId) {
    let state = sceneState.get(sessionId)
    if (state === undefined) {
      state = { turn: -1, matched: [], digest: '' }
      if (sceneState.size > 200) sceneState.clear()
      sceneState.set(sessionId, state)
    }
    return state
  }

  /** 真正生效的规则（含软链回退），渲染与场景匹配共用一份判断。 */
  function effectiveForCwd(cwd) {
    const direct = effectiveRules(doc, cwd)
    if (direct.project !== null || typeof cwd !== 'string' || cwd === '') return direct
    const real = realCwdOf(cwd)
    if (real === '' || real === cwd) return direct
    const linked = effectiveRules(doc, real)
    return linked.project === null ? direct : linked
  }

  /** 取一条消息里的纯文本（只认 text 块；其它块对场景匹配没有意义）。 */
  function messageText(message) {
    if (message === null || typeof message !== 'object') return ''
    const content = Array.isArray(message.content) ? message.content : []
    const parts = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }

  /**
   * 场景信号：**只用本步的真人消息**。
   *
   * 两条排除，都是踩过的：
   *   1. `runtime-context` 快照（沙箱 / 审批 / 时间的固定话术）—— 它会让规则被那些词误命中；
   *   2. **工作目录**—— 曾经把它拼进信号里，结果一条标题含「项目」的规则在每次调用
   *      都命中：用户的目录叫 `~/项目/…`，路径里的「项目」两个字直接喂给了匹配器。
   *      实测同一条消息「今天天气不错」，路径带「项目」时命中、换成 `/tmp/x` 就不命中。
   *      项目范围本来就由 effectiveRules 按 cwd 过滤过了，路径进信号没有增量、只有噪声。
   */
  function sceneSignal(messages) {
    const parts = []
    for (const message of Array.isArray(messages) ? messages.slice(-3) : []) {
      const kind = message !== null && typeof message === 'object' && message.source !== null && typeof message.source === 'object' ? message.source.kind : undefined
      if (kind === 'runtime-context') continue
      parts.push(messageText(message))
    }
    return parts.join('\n')
  }

  /** 按场景送达的文本块（与系统提示里的排版同源：同样的分组小标题与编号）。 */
  function renderSceneBlock(matched, unmatched) {
    const lines = [
      '<system-reminder>',
      '本机用户维护的「项目开发规则」中，与当前任务相关的这几条（按场景匹配后送达，不是全部规则）：',
      '',
      ...renderRuleListLines(matched),
    ]
    if (unmatched > 0) {
      lines.push('', '另有 ' + String(unmatched) + ' 条按场景规则本次未命中；需要时用 ian_rules 工具按关键词取用。')
    }
    lines.push('</system-reminder>')
    return lines.join('\n')
  }

  /** 自建一条 user 消息：结构与宿主 createUserMessage 一致（id + role + content + source）。 */
  function sceneMessage(text) {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'ian-rules-scene' } }
  }

  /**
   * 算出这一步该不该注入、注入什么。返回空串＝不注入。
   *
   * sticky 按**轮（turn）**而不是按整个会话：一轮之内步与步之间规则不能飘（第 2 步
   * 往后已经没有新的用户消息，纯靠打分会把上一秒刚命中的规则又抖掉）；跨轮则重新匹配，
   * 否则「第一轮聊依赖」命中的规则会一直粘到最后一轮。集合没变就不重复注入：
   * 每注入一次都会在历史里留下一条消息。
   */
  function sceneTextFor(agent, messages, turn, sessionId) {
    // 快速路径：默认（关）时每个模型步都要走一遍这里，先把最便宜的判断放最前面，
    // 不去碰 effectiveRules / 分词这些更贵的事。
    if (doc.sceneMatching !== SCENE_MATCHING_AUTO) return ''
    const state = sceneStateOf(sessionId)
    if (state.turn !== turn) {
      state.turn = turn
      state.matched = []
      state.digest = ''
    }
    const cwd = cwdOfContext({ agent })
    const effective = effectiveForCwd(cwd)
    if (!effective.enabled || effective.sceneMatching !== SCENE_MATCHING_AUTO) return ''
    const auto = effective.rules.filter((rule) => rule.mode === RULE_MODE_AUTO)
    if (auto.length === 0) return ''
    const selected = selectSceneRules(auto, sceneSignal(messages), { pinned: state.matched })
    if (selected.matched.length === 0) return ''
    const digest = sceneDigest(selected.matched)
    if (digest === state.digest) return ''
    state.matched = selected.matched.map((rule) => rule.id)
    state.digest = digest
    logSceneHit({
      at: new Date().toISOString(),
      session: sessionId,
      turn: turn,
      cwd: cwd,
      matched: selected.matched.map((rule) => rule.id),
      titles: selected.matched.map((rule) => rule.title),
      unmatched: auto.length - selected.matched.length,
    })
    return renderSceneBlock(selected.matched, auto.length - selected.matched.length)
  }

  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {}
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision
        const agent = payload?.agent
        const sessionId = sessionIdOfContext({ agent })
        if (sessionId === '') return decision
        const text = sceneTextFor(agent, decision.messages, payload?.turn, sessionId)
        if (text === '') return decision
        return { ...decision, messages: [...(Array.isArray(decision.messages) ? decision.messages : []), sceneMessage(text)] }
      } catch (error) {
        // 场景匹配只是锦上添花：它出错也绝不能把模型步带崩
        warn('按场景注入失败：' + (error instanceof Error ? error.message : String(error)))
        return decision
      }
    })
    return typeof dispose === 'function' ? dispose : () => {}
  }, 'ian-rules: 按场景注入')

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
      // 命中链（由外到内）：monorepo 下父子都会在里面，面板据此说明「继承了谁」
      chain: effective.projects.map((project) => ({ path: project.path, label: project.label, mode: project.mode })),
      inherited: effective.inheritedProjects.map((project) => project.path),
      // 「按场景」规则的目录：面板据此预览「常驻的只是目录，全文按需取」
      sceneMatching: draft.sceneMatching === 'auto',
      sceneIndex: effective.rules
        .filter((rule) => rule.mode === 'auto')
        .map((rule) => ({ id: rule.id, title: rule.title, tags: rule.tags, tokens: ruleSize(rule).tokens })),
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

      if (route === ROUTE + '/scene' && req.method === 'POST') {
        // 面板的「场景模拟器」：给一句话，看它会命中哪几条按场景规则、为什么。
        // 匹配器是纯函数，这里只是把它套上 HTTP 外壳 —— 规则面板能解释自己，
        // 用户才敢把规则标成「按场景」。
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        const target = typeof body.path === 'string' && body.path !== '' ? body.path : process.cwd()
        const effective = effectiveForCwd(target)
        const auto = effective.rules.filter((rule) => rule.mode === 'auto')
        // 排序与选取必须用**同一个信号**，否则面板会给出低于阈值却「命中」、
        // 或分数很高却没进 near 的自相矛盾结果。path 只用来决定候选范围，不进信号。
        const terms = tokenize(text)
        const scored = auto
          .map((rule) => ({ rule, score: scoreRule(rule, terms) }))
          .sort((a, b) => b.score - a.score)
        const selected = selectSceneRules(auto, text, {})
        const matchedIds = new Set(selected.matched.map((rule) => rule.id))
        const describe = (entry) => ({
          id: entry.rule.id,
          title: entry.rule.title,
          tags: entry.rule.tags,
          score: Number(entry.score.toFixed(3)),
          chars: ruleSize(entry.rule).chars,
        })
        sendJson(res, 200, {
          ok: true,
          path: normalizePath(target),
          sceneMatching: effective.sceneMatching === 'auto',
          total: auto.length,
          threshold: SCENE_THRESHOLD,
          budget: SCENE_BUDGET_CHARS,
          matched: scored.filter((entry) => matchedIds.has(entry.rule.id)).map(describe),
          // 没命中里分最高的几条：用来解释「为什么这条没进来」，比只报命中有用得多
          near: scored.filter((entry) => !matchedIds.has(entry.rule.id) && entry.score > 0).slice(0, 3).map(describe),
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
        // applyMode='next-session'：正在跑的会话继续用它们已经吃进上下文的旧规则，
        // 新会话才用新规则。冻结必须发生在 persist 之前 —— 一旦 doc 被换掉，
        // 就再也还原不出「它们当时看到的文本」了。
        const applyMode = body.applyMode === 'next-session' ? 'next-session' : 'now'
        const frozenSessions = applyMode === 'next-session' ? freezeLiveSessions() : 0
        if (applyMode === 'now') frozenText.clear()
        // 不带 doc 时保存**当前内存里的文档**（＝只改生效方式、不动规则）。
        // 以前这里落的是整个请求体，于是 `{revision, applyMode}` 这种请求会把规则清空。
        await persist(body.doc === undefined ? doc : body.doc)
        sendJson(res, 200, {
          ok: true,
          doc,
          meta: meta(),
          applyMode,
          frozenSessions,
          notice:
            applyMode === 'next-session'
              ? frozenSessions === 0
                ? '已保存；当前没有正在运行的会话，全部按新规则走。'
                : '已保存；' + String(frozenSessions) + ' 个正在运行的会话继续使用旧规则（省掉重算提示缓存），新会话用新规则。'
              : '已保存，下一步即生效（正在运行的会话会重算自身提示缓存）',
        })
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
      '查看与维护本机的「项目开发规则」（由 ian-rules 插件维护，规则会自动注入系统提示）。用户说「把这条记进开发规则 / 看一下开发规则 / 删掉某条规则」时用它。action 取值：list（查看当前目录或指定路径下生效的规则，默认只给摘要）、lookup（按关键词取某几条规则的正文，用于「按场景」规则没有常驻在提示里时主动查）、add（新增规则）、update（修改标题 / 正文 / 分组 / 启用状态）、remove（删除规则）。scope=global 表示全局规则，scope=project 表示某个项目的规则（用 path 指定项目目录，默认当前会话工作目录）。list 的 full=true 才返回完整注入原文，all=true 才列举全部项目的规则。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'lookup', 'add', 'update', 'remove'], description: '要执行的动作' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'add 时的归属：global 全局规则（默认），project 项目规则' },
        path: { type: 'string', description: '目录路径：list 看该目录的生效规则；add(scope=project) 指定规则归属的项目；缺省用当前会话工作目录' },
        id: { type: 'string', description: '规则 id（update / remove 必填，list 的输出里带 id）' },
        title: { type: 'string', description: '规则标题（add 建议填；update 可改）' },
        content: { type: 'string', description: '规则正文：具体、可执行的约定（add 必填；update 可改）' },
        group: { type: 'string', description: '可选分组名（面板按分组展示，注入文本里作为小标题）' },
        enabled: { type: 'boolean', description: '是否启用该规则（update 时用；add 默认启用）' },
        full: { type: 'boolean', description: 'list 专用：返回完整注入原文（默认只给摘要，避免把大段文本写进对话历史）' },
        all: { type: 'boolean', description: 'list / lookup 专用：list 时列举所有项目的规则；lookup 时把搜索范围扩大到全文档（默认只搜本路径生效的规则）' },
        query: { type: 'string', description: 'lookup 必填：想找什么。一句话或几个关键词都行，按相关度排序返回正文' },
        limit: { type: 'number', description: 'lookup 专用：最多返回几条（默认 5，上限 20）' },
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
        // 默认只给摘要：以前这里把「全部项目 + 每个项目的每条规则 + 整段注入原文」一次性
        // 塞进工具结果，而工具结果是**永久留在历史里**的消息 —— 规则一多，一次 list
        // 就能吃掉上万 token。要全文得显式要（full），要列举全部项目也得显式要（all）。
        const wantFull = args?.full === true
        const wantAll = args?.all === true
        const lines = []
        lines.push('规则文件：' + file + '（备份 ' + backupFile + '）')
        lines.push(
          '全局规则 ' + String(effective.globalRules.length) + ' 条启用 / ' + String(doc.global.length) + ' 条总计' +
            (doc.enabled ? '' : '（规则总开关已关闭，当前不会注入）'),
        )
        lines.push('项目规则集 ' + String(doc.projects.length) + ' 个。')

        const ruleLine = (rule) =>
          '[' + rule.id + '] ' + (rule.enabled ? '' : '停用 ') + (rule.group === '' ? '' : '#' + rule.group + ' ') + (rule.title || '(无标题)')

        /** 列表太长时截断并说实话 —— 工具结果只该给「够用的那一部分」。 */
        const capped = (rules, cap = 30) => {
          const head = rules.slice(0, cap).map((rule) => '  · ' + ruleLine(rule))
          if (rules.length > cap) head.push('  · …等 ' + String(rules.length - cap) + ' 条')
          return head
        }

        if (target === '') {
          lines.push('（未给出目录，也没拿到会话工作目录：只列全局规则，无法判断项目命中）')
          lines.push(...capped(doc.global, wantAll ? doc.global.length : 30))
        } else {
          const chain = effective.projects
          lines.push('')
          lines.push(
            '路径 ' + (normalizePath(target) || target) + '：命中 ' +
              (chain.length === 0 ? '0 个项目规则集' : String(chain.length) + ' 个项目规则集 —— ' + chain.map((project) => project.path).join(' → ')) +
              (effective.override ? '（链上有覆盖模式：全局规则在本路径不生效）' : ''),
          )
          const injected = renderRules(doc, target)
          lines.push(
            '本路径生效 ' + String(effective.rules.length) + ' 条（注入 ' + String(injected.length) + ' 字符 / 约 ' +
              String(estimateTokens(injected)) + ' token' + (doc.enabled ? '' : '；但总开关已关，实际不注入') + '）：',
          )
          if (effective.rules.length === 0) lines.push('  （无）')
          else lines.push(...capped(effective.rules))

          if (effective.suppressedGlobalRules.length > 0) {
            lines.push('覆盖模式挡掉的全局规则 ' + String(effective.suppressedGlobalRules.length) + ' 条：')
            lines.push(...capped(effective.suppressedGlobalRules, 8))
          }

          // 停用的规则也要能查到 —— 否则「为什么这条没生效」只能靠猜。默认只列与本路径相关的。
          const inactiveGlobal = doc.global.filter((rule) => rule.enabled === false)
          const inactiveProject = effective.projects.flatMap((project) => project.rules.filter((rule) => rule.enabled === false))
          const inactive = inactiveGlobal.concat(inactiveProject)
          if (inactive.length > 0) {
            lines.push('本路径相关但已停用 ' + String(inactive.length) + ' 条：')
            lines.push(...capped(inactive, 8))
          }

          const idleProjects = doc.projects.filter((project) => !effective.projects.includes(project))
          if (idleProjects.length > 0) {
            if (wantAll) {
              lines.push('其它项目规则集 ' + String(idleProjects.length) + ' 个（本项目路径下不生效）：')
              for (const project of idleProjects) {
                lines.push(
                  '  - [' + project.id + '] ' + project.path + (project.enabled ? '' : '（已停用）') +
                    ' 模式=' + (project.mode === 'override' ? '覆盖全局' : '追加全局') + ' 规则 ' + String(project.rules.length) + ' 条',
                )
                lines.push(...capped(project.rules, 8))
              }
            } else {
              lines.push(
                '另有 ' + String(idleProjects.length) + ' 个项目规则集在本路径不生效（列全部规则用 `all: true`；' +
                  '结构摘要：' + idleProjects.slice(0, 5).map((project) => project.path + '(' + String(project.rules.length) + ')').join('、') +
                  (idleProjects.length > 5 ? ' 等' : '') + '）。',
              )
            }
          }

          if (wantFull) {
            lines.push('')
            lines.push('完整注入原文（未截断）：')
            lines.push(renderRules(doc, target, { limit: Number.POSITIVE_INFINITY }) || '（无）')
          } else {
            lines.push('')
            lines.push('（以上为摘要；需要完整注入原文时用 `full: true`，需要列举全部项目规则时用 `all: true`。）')
          }
        }
        return { ok: true, data: lines.join('\n'), notice: '' }
      }

      if (action === 'lookup') {
        // 「按关键词取用」：系统提示里只放目录，正文靠这一步取。默认只看本路径生效的
        // 规则（和 agent 手上那份一致），`all: true` 才扩大到全文档。
        const query = asText(args?.query)
        if (query === '') return { ok: false, data: '', notice: 'lookup 需要 query：想找什么，一句话或几个关键词都行。' }
        const target = explicitPath !== '' ? explicitPath : sessionCwd
        const effective = effectiveForCwd(target)
        const pool = args?.all === true ? doc.global.concat(doc.projects.flatMap((project) => project.rules)) : effective.rules
        const terms = tokenize(query)
        const ranked = []
        for (const rule of pool) {
          const score = scoreRule(rule, terms)
          if (score > 0) ranked.push({ rule, score })
        }
        ranked.sort((a, b) => b.score - a.score)
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, Math.trunc(args.limit))) : 5
        const picked = ranked.slice(0, limit)
        const lines = ['查询：' + query + '（在本路径生效的 ' + String(pool.length) + ' 条里按相关度排序）']
        if (picked.length === 0) {
          lines.push('（没有找到相关的规则。换个关键词，或用 action=list 看全部。）')
          return { ok: true, data: lines.join('\n'), notice: '' }
        }
        for (const entry of picked) {
          lines.push(
            '',
            '[' + entry.rule.id + '] ' + (entry.rule.title || '(无标题)') +
              (entry.rule.group === '' ? '' : '  #' + entry.rule.group) +
              (entry.rule.mode === 'auto' ? '  （按场景）' : '') +
              (Array.isArray(entry.rule.tags) && entry.rule.tags.length > 0 ? '  标签：' + entry.rule.tags.join('、') : '') +
              '  相关度 ' + entry.score.toFixed(2),
          )
          if (entry.rule.content !== '') lines.push(...entry.rule.content.split('\n'))
        }
        if (ranked.length > picked.length) {
          lines.push('', '（另有 ' + String(ranked.length - picked.length) + ' 条相关规则未列出；加大 limit 或换个更具体的关键词。）')
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
