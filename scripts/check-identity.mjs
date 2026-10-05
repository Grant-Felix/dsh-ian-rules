#!/usr/bin/env node
/**
 * 身份自检：把「改名」从一件靠记忆的事，变成一件靠机器核对的事。
 *
 * 为什么需要它：这个插件的名字散在四个地方，而它们必须一致 ——
 *   - `package.json` 的 `name`（pnpm 依赖键、插件市场认的包名）
 *   - `cordis.patch.yml` 的行 `name`（要加载的**模块名**，与包名不同会让 profile 装不上）
 *   - `lib/client.js` 里 `__ModuleLoader__.load({ id })`（DSH 的客户端模块图按**包名**建行，
 *     对不上就启动即报「Failed to load plugins：loaded without registering …」，
 *     而宿主接口一切正常 —— 只 curl 接口的自检抓不到这种错）
 *   - `lib/index.js` / `lib/client.js` 里由名字派生的路由、section 名、提示变量、文件名、
 *     页签 kind
 * 以前这些是七处独立的字符串字面量，改一处漏一处只能靠人眼扫。这里把它们放在一起核对：
 * 约定 **包名去掉 `dsh-` 前缀就是 slug**（`dsh-ian-rules` → `ian-rules`），其余标识全部
 * 由 slug 派生。于是「改名」＝改 `package.json` 的 `name`、把旧名字补进两个 lib 里
 * `LEGACY_*` 那几行（历代名字的清单，由新到旧），然后跑 `npm run check:identity` 看还差哪里。
 *
 * 顺带守住第二条线：历代更名前的旧名字不许再出现在代码与配置里（文档/迁移/兼容那几处例外
 * 在下面的 ALLOWED 里逐条写明理由 —— 这份清单就是「哪些旧名字是故意留下的」的完整答案）。
 *
 * 用法：
 *   node scripts/check-identity.mjs          # 打印结果，有问题退出码 1
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描时跳过的目录：都不是仓库内容。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sandbox', '.visual', '.pnpm-store'])

/**
 * 更名前历代的旧名字（由新到旧）。每一处允许的例外都在 ALLOWED 里写明理由。
 * 注意长名字（`dsh-agent-rules`）会被短名字（`agent-rules`）的子串匹配覆盖，所以这里只列短的那个。
 */
const BANNED = [
  { token: 'agent-rules', label: '上一代包名 / 上一代 slug / 上一代数据文件名 / 上一代页签 kind' },
  { token: 'agent_rules', label: '上一代提示变量名 / 上一代工具名' },
  { token: 'dsh-dev-rules', label: '更早一代的包名' },
  { token: 'dev-rules', label: '更早一代的 slug / 数据文件名 / 页签 kind' },
  { token: 'dev_rules', label: '更早一代的提示变量名 / 工具名' },
  { token: '--dr-', label: '更早一代的样式变量前缀' },
  { token: /\bdr_/, label: '更早一代的类名前缀' },
]

/**
 * 允许留下旧名字的地方。每条都要回答「为什么这处可以不改」——
 * 清单越短越好，新增一条就等于承认多欠了一笔技术债。
 */
const ALLOWED = [
  { file: 'lib/index.js', token: 'agent-rules', why: 'LEGACY_FILE_NAMES：上一代数据文件的**迁移来源**，必须写它才能把老用户的规则搬过来' },
  { file: 'lib/index.js', token: 'dev-rules', why: 'LEGACY_FILE_NAMES：更早一代数据文件的**迁移来源**，同理' },
  { file: 'lib/index.js', token: 'dsh-dev-rules', why: '同一处的中文注释（说清是从哪个名字迁过来的）' },
  { file: 'lib/client.js', token: 'agent-rules', why: '两处过渡兼容：LEGACY_TAB_KINDS（上一代已打开的页签持久化的就是这个 kind）与 LEGACY_ROUTES（页面已换新客户端、宿主还没重启时把请求退回去问一次）' },
  { file: 'lib/client.js', token: 'dev-rules', why: '同上，更早一代的那一个名字' },
  { file: 'test/host.test.mjs', token: 'agent-rules', why: '迁移用例自己造一份上一代名字的数据文件来验迁移（含「两代都在时取新的」）' },
  { file: 'test/host.test.mjs', token: 'dev-rules', why: '同上，更早一代' },
  { file: 'test/client.test.mjs', token: 'agent-rules', why: '断言上一代的兼容注册存在、且**不能带 guide**（带了页面列表会多一行）' },
  { file: 'test/client.test.mjs', token: 'dev-rules', why: '同上，更早一代' },
  { file: 'scripts/sandbox.sh', token: 'agent-rules', why: '沙箱要先摘掉上一代包名的依赖，否则 profile 会同时装两份' },
  { file: 'scripts/sandbox.sh', token: 'dsh-dev-rules', why: '同上，更早一代的包名' },
  { file: 'scripts/sandbox.sh', token: 'dev-rules', why: 'Gitee 镜像地址（镜像未随更名改动）' },
  { file: 'README.md', token: 'agent-rules', why: '迁移说明里要点明「从哪个名字迁过来的」' },
  { file: 'README.md', token: 'dev-rules', why: '迁移说明 + Gitee 镜像地址（镜像未随更名改动）' },
  { file: 'README.md', token: 'dsh-dev-rules', why: '迁移说明里要点明「从哪个名字迁过来的」' },
  { file: 'NOTICE.md', token: 'dev-rules', why: '历史沿革说明' },
  { file: '.gitignore', token: 'agent-rules', why: '上一代数据文件仍在本地时不该让工作区变脏' },
  { file: '.gitignore', token: 'dev-rules', why: '更早一代数据文件仍在本地时不该让工作区变脏' },
]

/** 递归列出仓库里的文本文件（相对路径）。 */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const rel = prefix === '' ? entry : prefix + '/' + entry
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel))
    else out.push(rel)
  }
  return out
}

const read = (rel) => readFileSync(path.join(repo, rel), 'utf8')
const problems = []

/** 从源码里取一个「单一出处」的值；取不到就是问题本身。 */
function grab(rel, pattern, what) {
  const match = pattern.exec(read(rel))
  if (match === null) {
    problems.push(`${rel}：找不到 ${what}`)
    return null
  }
  return match[1]
}

const pkg = JSON.parse(read('package.json'))
const name = String(pkg.name ?? '')
if (!/^dsh-[a-z0-9-]+$/.test(name)) problems.push(`package.json 的 name「${name}」应形如 dsh-<slug>`)
const slug = name.replace(/^dsh-/, '')

// ---- 1) 名字的四处出处必须一致 ----
const patch = read('cordis.patch.yml')
const patchName = /^\s*name:\s*'([^']+)'\s*$/m.exec(patch)?.[1] ?? null
const patchId = /^\s*-?\s*id:\s*([A-Za-z0-9_-]+)\s*$/m.exec(patch)?.[1] ?? null
const clientId = grab('lib/client.js', /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,800}?\bid:\s*'([^']+)'/, '客户端注册 id')
const clientPkg = grab('lib/client.js', /const PACKAGE_NAME = '([^']+)'/, 'PACKAGE_NAME')
const clientTabId = grab('lib/client.js', /const TAB_IMPL_ID = '([^']+)'/, 'TAB_IMPL_ID')
const clientTabKind = grab('lib/client.js', /const TAB_KIND = '([^']+)'/, 'TAB_KIND')
const clientApi = grab('lib/client.js', /const API = '([^']+)'/, 'API 路由')
const clientAttr = grab('lib/client.js', /setAttribute\('data-plugin', '([^']+)'\)/, 'data-plugin 标记')
const hostName = grab('lib/index.js', /export const name = '([^']+)'/, '插件导出 name')
const route = grab('lib/index.js', /const ROUTE = '([^']+)'/, 'ROUTE')
const variable = grab('lib/index.js', /const BODY_VARIABLE = '([^']+)'/, 'BODY_VARIABLE')
const fileName = grab('lib/index.js', /const FILE_NAME = '([^']+)'/, 'FILE_NAME')
const section = grab('lib/index.js', /name: 'plugin:([^']+)'/, 'section 名')

const expected = [
  ['cordis.patch.yml 的 name', patchName, name],
  ['cordis.patch.yml 的 id', patchId, slug],
  ['lib/client.js 的客户端注册 id', clientId, name],
  ['lib/client.js 的 PACKAGE_NAME（插件市场认的包名）', clientPkg, name],
  ['lib/client.js 的 TAB_IMPL_ID（契约要求就用包名）', clientTabId, name],
  ['lib/client.js 的 TAB_KIND', clientTabKind, slug],
  ['lib/client.js 的 API 路由', clientApi, '/' + slug],
  ['lib/client.js 的 data-plugin 标记', clientAttr, slug],
  ['lib/index.js 导出的 name', hostName, slug],
  ['lib/index.js 的 ROUTE', route, '/' + slug],
  ['lib/index.js 的 BODY_VARIABLE', variable, slug.replace(/-/g, '_') + '_body'],
  ['lib/index.js 的 FILE_NAME', fileName, slug + '.json'],
  ['lib/index.js 的 section 名', section, slug],
]
for (const [what, actual, want] of expected) {
  if (actual !== null && actual !== want) problems.push(`${what} 是「${actual}」，应为「${want}」（包名 ${name}）`)
}

// ---- 1b) 一处**故意的不对称**：Gitee 镜像没随更名改动 ----
// 全局替换「旧 slug → 新 slug」时最容易误伤的就是它：把镜像地址也改成新名字，文档里那条
// 国内安装路径就指向一个不存在的仓库，而本地测试全绿、根本发现不了。这里把它钉死。
for (const rel of ['README.md', 'scripts/sandbox.sh']) {
  const text = read(rel)
  // 只吃仓库名允许的字符，别把 markdown 的 '>' 或行尾标点也吞进来
  for (const match of text.matchAll(/gitee\.com\/[^\s/]+\/([A-Za-z0-9._-]+)/g)) {
    if (match[1].replace(/\.git$/, '') !== 'dev-rules') {
      problems.push(`${rel}：Gitee 镜像地址指向「${match[1]}」—— 镜像仓库没有随更名改动，应仍是 dev-rules`)
    }
  }
}

// ---- 2) 旧名字不许再出现在代码与配置里（例外的逐条列明）----
const allowedHere = (rel, token) => ALLOWED.some((entry) => entry.file === rel && entry.token === token)
for (const rel of listFiles(repo)) {
  if (rel === 'scripts/check-identity.mjs') continue // 它自己就写着这些名字
  if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$/i.test(rel)) continue
  let text
  try {
    text = read(rel)
  } catch {
    continue
  }
  for (const { token, label } of BANNED) {
    const pattern = token instanceof RegExp ? token : new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const hits = text.match(pattern)
    if (hits !== null && !allowedHere(rel, String(token))) {
      problems.push(`${rel}：还有${label}「${token}」${hits.length} 处 —— 改掉，或在 scripts/check-identity.mjs 的 ALLOWED 里写明为什么留着`)
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ 身份自检通过：包名 ${name}，slug ${slug}；代码与配置里没有残留的旧名字（${ALLOWED.length} 处例外均已列明理由）`)
  process.exit(0)
}
console.error('✖ 身份自检未通过：\n' + problems.map((line) => '  - ' + line).join('\n'))
process.exit(1)
