/**
 * 宿主半体的集成冒烟测试：不启动 DSH，用一个最小 ctx 桩驱动 apply()，
 * 验证几件事真的接通了 ——
 *   1. 规则经 `ian_rules_body` 提示变量渲染（section 正文是常量，用户内容
 *      不会被 DSH 的 `{{…}}` 插值扫到）；
 *   2. /ian-rules/* 接口能读 / 存 / 预览 / 列工作区，并挡住跨站与错类型；
 *   3. 保存带 revision，过期返回 409；保存前留 .bak 备份；
 *   4. ian_rules 工具能新增 / 改 / 删规则并落盘，立刻影响注入文本；
 *   5. 更名迁移：历代旧数据文件（agent-rules.json / dev-rules.json）会被复制到 ian-rules.json。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, name, inject } from '../lib/index.js'
import { MAX_CONTENT, MAX_GROUP, MAX_RULES, MAX_SECTION_CHARS, MAX_TAG, MAX_TAGS, MAX_TITLE } from '../lib/rules.js'

/** 最小 ctx 桩：只实现本插件用到的注册面，并记录 disposer。 */
function makeCtx(extra = {}) {
	const disposed = []
	const ctx = {
		logger: { warn() {} },
		sections: [],
		variables: new Map(),
		routes: [],
		registeredTools: [],
		effect(factory) {
			const dispose = factory()
			if (typeof dispose === 'function') disposed.push(dispose)
			return dispose
		},
		systemPrompt: {
			section(section) {
				ctx.sections.push(section)
				return () => {}
			},
			variable(variableName, provider) {
				ctx.variables.set(variableName, provider)
				return () => {}
			},
		},
		webServer: {
			register(route) {
				ctx.routes.push(route)
				return () => {}
			},
		},
		tools: {
			register(tool) {
				ctx.registeredTools.push(tool)
				return () => {}
			},
		},
		get(service) {
			return extra[service]
		},
		handlers: new Map(),
		// 事件监听桩：按场景注入挂在 agent/pre-step 上，测试要能把它取出来手动跑一遍
		// （DSH 的 waterfall 用法是 `(payload, next) => next()`，见 runPreStep）。
		on(event, listener) {
			if (!ctx.handlers.has(event)) ctx.handlers.set(event, [])
			ctx.handlers.get(event).push(listener)
			return () => {
				const list = ctx.handlers.get(event)
				const index = list.indexOf(listener)
				if (index >= 0) list.splice(index, 1)
			}
		},
		disposeAll() {
			while (disposed.length > 0) disposed.pop()()
		},
	}
	return ctx
}

function makeRequest(method, url, body, headers = {}) {
	const merged = { ...headers }
	if (body !== undefined && merged['content-type'] === undefined) merged['content-type'] = 'application/json'
	return {
		method,
		url,
		headers: merged,
		async *[Symbol.asyncIterator]() {
			if (body === undefined) return
			// 数组＝按块给（可选 Buffer）：真实 socket 会从多字节字符中间切开，
			// 单块字符串的桩天然绕过这一类解码问题。
			if (Array.isArray(body)) {
				for (const chunk of body) yield chunk
				return
			}
			yield body
		},
	}
}

function makeResponse() {
	return {
		status: 0,
		body: '',
		writeHead(status) {
			this.status = status
		},
		end(chunk) {
			this.body = chunk === undefined ? '' : String(chunk)
		},
	}
}

async function callRoute(ctx, method, url, body, headers) {
	const route = ctx.routes.find((entry) => entry.path === '/ian-rules')
	assert.ok(route !== undefined, '插件应注册 /ian-rules 路由')
	const res = makeResponse()
	await route.handler(makeRequest(method, url, body, headers), res)
	return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
}

function withHome(t) {
	const home = mkdtempSync(path.join(os.tmpdir(), 'ian-rules-'))
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	t.after(() => {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		rmSync(home, { recursive: true, force: true })
	})
	return home
}

const bodyProvider = (ctx) => {
	const provider = ctx.variables.get('ian_rules_body')
	assert.equal(typeof provider, 'function', '应注册 ian_rules_body 提示变量')
	return provider
}

const cwdAssembly = (cwd) => ({ agent: { session: { header: { cwd } } } })

/**
 * 跑一遍 agent/pre-step waterfall（按注册顺序），返回最终 decision。
 * DSH 里这是 waterfall 事件：每个监听器 `(payload, next) => …` 决定要不要改写
 * 上一位的结果，默认 `next()` 给 `{ kind: 'enter', messages }`。
 */
async function runPreStep(ctx, payload, base) {
	const listeners = ctx.handlers.get('agent/pre-step') ?? []
	// 与 DSH 一致：默认 decision 的 messages 就是本步 claim 到的消息
	const settled = base ?? { kind: 'enter', messages: Array.isArray(payload?.messages) ? payload.messages : [] }
	let next = () => Promise.resolve(settled)
	for (const listener of [...listeners].reverse()) {
		const inner = next
		next = () => listener(payload, inner)
	}
	return next()
}

test('插件身份：name / inject 与约定一致', () => {
	assert.equal(name, 'ian-rules')
	assert.deepEqual(inject, ['webServer', 'systemPrompt', 'tools'])
})

test('注入：section 是常量引用，正文由 ian_rules_body 变量提供', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const section = ctx.sections.find((entry) => entry.name === 'plugin:ian-rules')
	assert.ok(section !== undefined, '应注册 plugin:ian-rules section')
	assert.equal(section.order, 100)
	// 关键：section 正文必须是常量引用，不能把用户内容塞进会被插值扫描的位置
	assert.equal(section.text, '{{ian_rules_body}}')

	const provider = bodyProvider(ctx)
	assert.equal(provider(cwdAssembly('/tmp/whatever')), '')

	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')
	await tool.execute({ action: 'add', scope: 'global', title: '提交前跑测试', content: 'npm test 必须绿' })
	assert.match(provider(cwdAssembly('/tmp/other')), /\*\*提交前跑测试\*\*/)

	await tool.execute({ action: 'add', scope: 'project', path: '/tmp/demo-project', title: '本项目用 pnpm', content: '禁止 npm install' })
	const inside = provider(cwdAssembly('/tmp/demo-project/src'))
	assert.match(inside, /本项目用 pnpm/)
	assert.match(inside, /提交前跑测试/)
	assert.doesNotMatch(provider(cwdAssembly('/tmp/elsewhere')), /本项目用 pnpm/)

	// 组装上下文缺 cwd 时只注入全局，绝不猜测目录
	const noCwd = provider({})
	assert.match(noCwd, /提交前跑测试/)
	assert.doesNotMatch(noCwd, /本项目用 pnpm/)

	// 用户规则里的 `{{…}}` 原样保留（不会被插值、更不会打挂模型步）
	await tool.execute({ action: 'add', scope: 'global', title: '模板写法', content: '示例：{{user_name}} 与 {\{bad}' })
	const withBraces = provider(cwdAssembly('/tmp/other'))
	assert.match(withBraces, /\{\{user_name\}\}/)
})

test('注入：软链工作目录经 realpath 回退仍能命中项目规则', async (t) => {
	if (process.platform === 'win32') return
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	const realDir = mkdtempSync(path.join(os.tmpdir(), 'ian-rules-real-'))
	const linkDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'ian-rules-link-')), 'link')
	t.after(() => {
		rmSync(realDir, { recursive: true, force: true })
		rmSync(path.dirname(linkDir), { recursive: true, force: true })
	})
	symlinkSync(realDir, linkDir)

	await tool.execute({ action: 'add', scope: 'project', path: realDir, title: '软链项目规则', content: 'x' })
	// 会话 cwd 走的是软链路径，规则登记的是 realpath → 应通过 realpath 回退命中
	assert.match(provider(cwdAssembly(linkDir)), /软链项目规则/)
})

test('注入：组装上下文形状不对时退化成只注入全局（不抛错、不猜目录）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	await tool.execute({ action: 'add', scope: 'global', title: '全局兜底', content: 'x' })
	await tool.execute({ action: 'add', scope: 'project', path: '/tmp/def-proj', title: '项目专属', content: 'y' })

	// `agent` 是宿主未在公开类型里声明的字段：任何畸形形状都必须收敛成「只注入全局」
	const malformed = [null, 42, 'x', [], {}, { agent: null }, { agent: {} }, { agent: { session: null } }, { agent: { session: { header: {} } } }, { cwd: 123 }]
	for (const context of malformed) {
		assert.doesNotThrow(() => provider(context), '畸形上下文不该抛错：' + JSON.stringify(context))
		assert.match(provider(context), /全局兜底/)
		assert.doesNotMatch(provider(context), /项目专属/)
	}
	// 字段变成会抛错的 getter，也不能把整个模型步打挂
	const throwing = {
		get agent() {
			throw new Error('宿主内部结构变了')
		},
	}
	assert.doesNotThrow(() => provider(throwing))
	assert.match(provider(throwing), /全局兜底/)
})

test('注入：同一份文档连续取值逐字节相同，规则一改立即失效', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	await tool.execute({ action: 'add', scope: 'project', path: '/tmp/cache-proj', title: '第一条', content: 'a' })
	const first = provider(cwdAssembly('/tmp/cache-proj/src'))
	// 前缀缓存的前提：同一份规则、同一个目录，连续几步必须拿到完全一样的字符串
	assert.equal(provider(cwdAssembly('/tmp/cache-proj/src')), first)
	assert.equal(provider(cwdAssembly('/tmp/cache-proj/src')), first)
	// 但规则一改必须立刻反映出来（缓存不能把新规则挡住）
	await tool.execute({ action: 'add', scope: 'project', path: '/tmp/cache-proj', title: '第二条', content: 'b' })
	const second = provider(cwdAssembly('/tmp/cache-proj/src'))
	assert.notEqual(second, first)
	assert.match(second, /第二条/)
	// 缓存按目录分开：另一个目录不该拿到这个项目的结果
	assert.doesNotMatch(provider(cwdAssembly('/tmp/other')), /第二条/)
})

test('接口：preview 会回报命中链（monorepo 下父子都在链里）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				global: [],
				projects: [
					{ path: '/tmp/chain', rules: [{ title: '根级', content: 'r' }] },
					{ path: '/tmp/chain/pkg', rules: [{ title: '子级', content: 'l' }] },
				],
			},
		}),
	)
	const preview = await callRoute(ctx, 'POST', '/ian-rules/preview', JSON.stringify({ path: '/tmp/chain/pkg/src' }))
	assert.deepEqual(preview.payload.chain.map((entry) => entry.path), ['/tmp/chain', '/tmp/chain/pkg'])
	assert.deepEqual(preview.payload.inherited, ['/tmp/chain'])
	assert.equal(preview.payload.counts.project, 2)
	assert.match(preview.payload.text, /根级/)
	assert.match(preview.payload.text, /子级/)
})

test('接口：preview 回报「按场景」规则目录（面板据此预览常驻的只是目录）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ title: '常驻的', content: 'a' },
					{ title: '按场景的', content: 'b', mode: 'auto', tags: ['依赖'] },
					{ title: '按场景但停用', content: 'c', mode: 'auto', enabled: false },
				],
				projects: [],
			},
		}),
	)
	const preview = await callRoute(ctx, 'POST', '/ian-rules/preview', JSON.stringify({ path: '/tmp/nowhere' }))
	assert.equal(preview.payload.sceneMatching, true)
	// 停用的不进目录；目录里带 tags，供面板显示
	assert.deepEqual(
		preview.payload.sceneIndex.map((entry) => ({ t: entry.title, tags: entry.tags })),
		[{ t: '按场景的', tags: ['依赖'] }],
	)
	// P1 阶段：按场景只表达意图，注入行为不变（P2 落地匹配后这条断言会翻过来，届时同步改）
	assert.match(preview.payload.text, /按场景的/)
})

test('保存：applyMode=next-session 把运行中的会话钉在旧规则上，新会话用新规则', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)

	const sessionOf = (id, cwd) => ({ agent: { session: { id, header: { cwd } } } })
	const running = sessionOf('session-running', '/tmp/defer-proj')
	const fresh = sessionOf('session-fresh', '/tmp/defer-proj')

	// 先有一版规则，并让「运行中的会话」吃过它（吃进上下文 = 有旧前缀要保护）
	const first = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, global: [{ title: '第一版规则', content: 'v1' }], projects: [] } }),
	)
	assert.equal(first.payload.applyMode, 'now')
	assert.match(provider(running), /第一版规则/)

	// 第二版用「下个会话生效」
	const deferred = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, global: [{ title: '第二版规则', content: 'v2' }], projects: [] }, applyMode: 'next-session' }),
	)
	assert.equal(deferred.payload.applyMode, 'next-session')
	assert.equal(deferred.payload.frozenSessions, 1)
	assert.equal(deferred.payload.meta.deferred.sessions, 1)
	assert.match(deferred.payload.notice, /继续使用旧规则/)
	// 关键：已经在跑的会话拿到的是旧文本，逐字节没变
	assert.match(provider(running), /第一版规则/)
	assert.doesNotMatch(provider(running), /第二版规则/)
	// 新会话（没渲染过的）直接吃新规则
	assert.match(provider(fresh), /第二版规则/)

	// 再保存一次「立即生效」→ 解冻，所有会话都切到新规则
	const immediate = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, global: [{ title: '第三版规则', content: 'v3' }], projects: [] } }),
	)
	assert.equal(immediate.payload.frozenSessions, 0)
	assert.equal(immediate.payload.meta.deferred.sessions, 0)
	assert.match(provider(running), /第三版规则/)
})

test('保存：空文本的会话不会被钉住（否则新规则永远用不上）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)
	const session = { agent: { session: { id: 'session-empty', header: { cwd: '/tmp/defer-empty' } } } }

	// 会话先渲染过一次，但当时一条规则都没有
	assert.equal(provider(session), '')
	const saved = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, global: [{ title: '刚加的规则', content: 'x' }], projects: [] }, applyMode: 'next-session' }),
	)
	assert.equal(saved.payload.frozenSessions, 0)
	assert.match(provider(session), /刚加的规则/)
})

test('保存：不带 doc 的请求保存内存里的当前文档（不能把规则清空）', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const saved = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, global: [{ title: '不许被清空', content: 'x' }], projects: [] } }),
	)
	assert.equal(saved.status, 200)
	// 面板「让它们改用新规则」发的就是这种体：只有 revision / applyMode，没有 doc
	const unfreeze = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ revision: saved.payload.meta.revision, applyMode: 'now' }),
	)
	assert.equal(unfreeze.status, 200)
	assert.equal(unfreeze.payload.meta.summary.global, 1, '规则条数不该被清成 0')
	const onDisk = JSON.parse(readFileSync(path.join(home, 'ian-rules.json'), 'utf8'))
	assert.equal(onDisk.global[0].title, '不许被清空')
})

test('接口：state / workspaces / save / preview / reload 与落盘 + 备份', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx({
		workspaceRegistry: { list: () => [{ path: '/tmp/ws-a', title: '工作区 A' }] },
		sessions: { list: () => [{ header: { cwd: '/tmp/session-cwd' } }] },
	})
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const initial = await callRoute(ctx, 'GET', '/ian-rules/state')
	assert.equal(initial.status, 200)
	assert.equal(initial.payload.meta.file, path.join(home, 'ian-rules.json'))
	assert.equal(initial.payload.meta.backupFile, path.join(home, 'ian-rules.json.bak'))
	// 逐条上限随 /state 下发，面板据此设 maxLength：与 rules.js 的常量必须是同一份
	assert.deepEqual(initial.payload.meta.limits, {
		title: MAX_TITLE,
		group: MAX_GROUP,
		content: MAX_CONTENT,
		rules: MAX_RULES,
		tags: MAX_TAGS,
		tag: MAX_TAG,
	})
	assert.equal(initial.payload.meta.maxSectionChars, MAX_SECTION_CHARS)

	const workspaces = await callRoute(ctx, 'GET', '/ian-rules/workspaces')
	assert.deepEqual(
		workspaces.payload.workspaces.map((entry) => entry.path),
		['/tmp/ws-a', '/tmp/session-cwd'],
	)

	const saved = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				global: [{ title: '先读再改', content: '动手前先读完相关文件', group: '流程' }],
				projects: [{ path: '/tmp/proj-x', mode: 'override', rules: [{ title: 'X', content: 'x' }] }],
			},
		}),
	)
	assert.equal(saved.payload.ok, true)
	assert.equal(saved.payload.doc.global[0].group, '流程')
	const firstRevision = saved.payload.meta.revision

	// 预览：带成本统计与被覆盖的全局规则数（此时项目 /tmp/proj-x 还在）
	const preview = await callRoute(
		ctx,
		'POST',
		'/ian-rules/preview',
		JSON.stringify({ path: '/tmp/proj-x/sub' }),
	)
	assert.equal(preview.payload.matched.mode, 'override')
	assert.equal(preview.payload.counts.suppressed, 1)
	assert.ok(preview.payload.chars > 0)
	assert.ok(preview.payload.tokens > 0)
	assert.equal(Array.isArray(preview.payload.rules), true)
	assert.equal(preview.payload.rules[0].title, 'X')

	// 第二次保存：旧版必须留在 .bak 里
	const second = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			revision: firstRevision,
			doc: { enabled: true, global: [{ title: 'V2', content: '第二版' }], projects: [] },
		}),
	)
	assert.equal(second.payload.ok, true)
	const backup = JSON.parse(readFileSync(path.join(home, 'ian-rules.json.bak'), 'utf8'))
	assert.equal(backup.global[0].title, '先读再改')
	const onDisk = JSON.parse(readFileSync(path.join(home, 'ian-rules.json'), 'utf8'))
	assert.equal(onDisk.global[0].title, 'V2')

	// 用过期 revision 保存：409，不覆盖
	const stale = await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ revision: firstRevision, doc: { global: [{ title: '不该写进去', content: 'x' }], projects: [] } }),
	)
	assert.equal(stale.status, 409)
	assert.equal(stale.payload.conflict, true)
	assert.equal(JSON.parse(readFileSync(path.join(home, 'ian-rules.json'), 'utf8')).global[0].title, 'V2')

	const reload = await callRoute(ctx, 'POST', '/ian-rules/reload', '{}')
	assert.equal(reload.payload.meta.revision >= 1, true)
});

test('保存：并发写不共用临时文件（内容完整、无残留 .tmp）', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	// 并发提交多份互不相同的文档。临时文件名若只与进程绑定（人人同名），并行写入会
	// 互相覆盖：后到的 rename 拿到已被搬走的路径 → ENOENT → 500；更糟的是前一次
	// rename 会把别人正在写的文件搬成正式文件，落盘内容变成两次写入交错的半截 JSON。
	// 文档做大（每份 ~320KB）让这个时间窗真的重叠。
	const rulesPerDoc = 80
	const docs = Array.from({ length: 10 }, (_, index) => ({
		enabled: true,
		global: Array.from({ length: rulesPerDoc }, () => ({ title: 'V' + String(index), content: 'x'.repeat(4000) })),
		projects: [],
	}))
	const results = await Promise.all(
		docs.map((doc) => callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc }))),
	)
	for (const result of results) assert.equal(result.status, 200)

	// 落盘内容必须来自同一次保存且结构完整：交错写会让 JSON 解析失败或标题混杂
	const onDisk = JSON.parse(readFileSync(path.join(home, 'ian-rules.json'), 'utf8'))
	assert.equal(onDisk.global.length, rulesPerDoc)
	assert.equal(new Set(onDisk.global.map((rule) => rule.title)).size, 1, '不能是两次写入交错的产物')
	assert.equal(onDisk.global.every((rule) => rule.content.length === 4000), true)

	const residue = readdirSync(home).filter((entry) => entry.endsWith('.tmp'))
	assert.deepEqual(residue, [], '保存完成或失败后都不该留下临时文件')
})

test('接口硬化：跨站请求 403、非 JSON 体 415、未知路径 404', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const crossSite = await callRoute(ctx, 'GET', '/ian-rules/state', undefined, { 'sec-fetch-site': 'cross-site' })
	assert.equal(crossSite.status, 403)

	const otherOrigin = await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc: { global: [], projects: [] } }), {
		origin: 'http://evil.example',
		host: '127.0.0.1:3080',
	})
	assert.equal(otherOrigin.status, 403)

	const sameOrigin = await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc: { global: [], projects: [] } }), {
		origin: 'http://127.0.0.1:3080',
		host: '127.0.0.1:3080',
		'sec-fetch-site': 'same-origin',
	})
	assert.equal(sameOrigin.status, 200)

	const wrongType = await callRoute(ctx, 'POST', '/ian-rules/save', 'doc=x', { 'content-type': 'text/plain' })
	assert.equal(wrongType.status, 415)

	const missing = await callRoute(ctx, 'GET', '/ian-rules/nope')
	assert.equal(missing.status, 404)
});

test('ian_rules 工具：list / update / remove 与错误分支', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	assert.equal((await tool.execute({ action: 'add' })).ok, false)

	const added = await tool.execute({ action: 'add', title: '约定 A', content: '正文 A', group: '流程' })
	assert.equal(added.ok, true)
	const id = added.data

	const listed = await tool.execute({ action: 'list', path: '/tmp/none' })
	assert.match(listed.data, /约定 A/)
	assert.match(listed.data, /#流程/)
	assert.match(listed.data, new RegExp(id))

	const updated = await tool.execute({ action: 'update', id, enabled: false, group: '安全' })
	assert.equal(updated.ok, true)
	const afterDisable = await tool.execute({ action: 'list', path: '/tmp/none' })
	assert.match(afterDisable.data, /停用/)
	assert.match(afterDisable.data, /#安全/)

	const removed = await tool.execute({ action: 'remove', id })
	assert.equal(removed.ok, true)
	assert.doesNotMatch((await tool.execute({ action: 'list', path: '/tmp/none' })).data, /约定 A/)

	assert.equal((await tool.execute({ action: 'update', id: 'nope' })).ok, false)
	assert.equal((await tool.execute({ action: 'remove' })).ok, false)
	assert.equal((await tool.execute({ action: 'unknown' })).ok, false)
})

test('ian_rules 工具：list 默认给有界摘要，全文与全项目枚举都要显式要', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	// 造一份「大」文档：80 条全局 + 3 个项目各 40 条 —— 旧实现的 list 会把这些
	// 连同整段注入原文一次性写进工具结果，而工具结果是永久留在历史里的。
	const doc = {
		version: 1,
		enabled: true,
		global: Array.from({ length: 80 }, (_, index) => ({ title: '全局R' + String(index), content: '正文'.repeat(80) })),
		projects: ['a', 'b', 'c'].map((name) => ({
			path: '/tmp/list-' + name,
			rules: Array.from({ length: 40 }, (_, index) => ({ title: name + '专属R' + String(index), content: '正文'.repeat(80) })),
		})),
	}
	await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc }))

	const summary = await tool.execute({ action: 'list', path: '/tmp/list-a/sub' })
	assert.equal(summary.ok, true)
	assert.ok(summary.data.length < 6000, '默认 list 必须有界，实际 ' + String(summary.data.length) + ' 字符')
	assert.match(summary.data, /命中 1 个项目规则集/)
	assert.match(summary.data, /本路径生效 120 条/)
	// 超出上限的部分只报条数，不逐条倒出来
	assert.match(summary.data, /…等 90 条/)
	assert.doesNotMatch(summary.data, /a专属R39/)
	// 其它项目只报计数，并明确告诉怎么要全
	assert.match(summary.data, /另有 2 个项目规则集/)
	assert.match(summary.data, /all: true/)
	assert.match(summary.data, /full: true/)

	// 要全文才给全文（且这份文档超限，全文比注入文本长）
	const withFull = await tool.execute({ action: 'list', path: '/tmp/list-a/sub', full: true })
	assert.match(withFull.data, /完整注入原文/)
	assert.ok(withFull.data.length > summary.data.length + 8000, 'full:true 应显著更长')

	// 要全项目才列全项目
	const withAll = await tool.execute({ action: 'list', path: '/tmp/list-a/sub', all: true })
	assert.match(withAll.data, /其它项目规则集 2 个/)
	assert.match(withAll.data, /\/tmp\/list-c/)
})

test('规则文件被外部改动：监听/轮询之外还有 reload 接口兜底', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	// 模拟外部写入（绕过插件 API），再调 reload 让它生效
	const { writeFileSync } = await import('node:fs')
	writeFileSync(path.join(home, 'ian-rules.json'), JSON.stringify({ global: [{ title: '外部规则', content: 'x' }] }), 'utf8')
	const reload = await callRoute(ctx, 'POST', '/ian-rules/reload', '{}')
	assert.equal(reload.payload.doc.global[0].title, '外部规则')
	assert.equal(existsSync(path.join(home, 'ian-rules.json')), true)
})

test('保存：多字节字符被分段切开也要原样落盘（逐块解码，不许出现替换字符）', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const content = '中文规则正文：捕获异常后要么记录、要么转成用户能看懂的提示。'.repeat(20)
	const doc = { version: 1, enabled: true, global: [{ id: 'g1', title: '标题', content }], projects: [] }
	const body = Buffer.from(JSON.stringify({ doc }), 'utf8')
	// 切点必须落在**正文**某个多字节字符内部（续字节 0x80–0xBF 上）：切在标题里也能让
	// JSON 解析通过，却正好绕开要验的那个字段 —— 这条用例第一版就是这么白写的。
	const contentAt = body.indexOf(Buffer.from(content, 'utf8'))
	assert.ok(contentAt > 0, '正文应能在请求体里定位到')
	let cut = -1
	for (let index = contentAt + 1; index < body.length; index += 1) {
		if (body[index] >= 0x80 && body[index] <= 0xbf) {
			cut = index
			break
		}
	}
	assert.ok(cut > contentAt, '中文正文里应能找到一个 UTF-8 续字节作为切点')
	const chunks = [body.subarray(0, cut), body.subarray(cut, cut + 1), body.subarray(cut + 1)]

	const res = await callRoute(ctx, 'POST', '/ian-rules/save', chunks)
	assert.equal(res.status, 200)
	const onDisk = JSON.parse(readFileSync(path.join(home, 'ian-rules.json'), 'utf8'))
	assert.equal(onDisk.global[0].content, content)
	assert.equal(onDisk.global[0].content.includes('\uFFFD'), false, '不该出现替换字符')
	assert.equal(onDisk.global[0].title, '标题', '同一份体里的其它字段也不该被波及')
})

test('保存：自己的写盘事件不推高 revision（否则「保存后再保存」必假报 409）', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const doc = { version: 1, enabled: true, global: [{ id: 'g1', title: 'A', content: 'aaa' }], projects: [] }
	const first = await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc }))
	assert.equal(first.status, 200)
	const revision = first.payload.meta.revision

	// 目录监听（去抖 250ms）会把插件自己那次 rename 也汇报一次；内容没变，revision 不能动
	await new Promise((resolve) => setTimeout(resolve, 700))
	const state = await callRoute(ctx, 'GET', '/ian-rules/state')
	assert.equal(state.payload.meta.revision, revision, '磁盘内容没变，revision 不该前进')

	const again = await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc, revision }))
	assert.equal(again.status, 200, '拿着上一次保存返回的 revision 再存一次，不该被判成冲突')

	// 反向确认监听确实在工作（否则上面那两条只是「监听没跑」的假绿灯）：
	// 外部真改了内容，revision 必须前进。
	writeFileSync(path.join(home, 'ian-rules.json'), JSON.stringify({ ...doc, global: [{ id: 'g1', title: 'B', content: 'bbb' }] }), 'utf8')
	await new Promise((resolve) => setTimeout(resolve, 700))
	const changed = await callRoute(ctx, 'GET', '/ian-rules/state')
	assert.equal(changed.payload.meta.revision > revision, true, '外部改动必须让 revision 前进')
	assert.equal(changed.payload.doc.global[0].title, 'B')
})

test('接口硬化：畸形 JSON 体是 400（客户端错误不该报成 500）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const broken = await callRoute(ctx, 'POST', '/ian-rules/save', '{oops')
	assert.equal(broken.status, 400)
	assert.match(broken.payload.error, /JSON/)

	// 合法 JSON、但不是对象：也是 400
	const array = await callRoute(ctx, 'POST', '/ian-rules/save', '[1,2,3]')
	assert.equal(array.status, 400)
})

test('更名迁移：历代旧数据文件被复制到新名字下，原文件保留', async (t) => {
	for (const legacyName of ['agent-rules.json', 'dev-rules.json']) {
		const home = mkdtempSync(path.join(os.tmpdir(), 'ian-rules-'))
		const previous = process.env.DSH_HOME
		process.env.DSH_HOME = home
		try {
			const legacy = path.join(home, legacyName)
			const fresh = path.join(home, 'ian-rules.json')
			const legacyDoc = { version: 1, enabled: true, global: [{ id: 'g1', title: '旧名下的规则', content: 'x' }], projects: [] }
			writeFileSync(legacy, JSON.stringify(legacyDoc), 'utf8')

			const ctx = makeCtx()
			apply(ctx)
			t.after(() => ctx.disposeAll())

			const state = await callRoute(ctx, 'GET', '/ian-rules/state')
			// 关键：不是「从旧文件读一次就算了」，而是真的复制过去 —— 否则第一次保存会以新文件为基准
			// 写出一个只有新改动的文档，用户攒的规则会被留在旧文件里没人再看
			assert.equal(state.payload.meta.file, fresh)
			assert.equal(state.payload.meta.migratedFrom, legacy, `应从 ${legacyName} 迁移`)
			assert.equal(existsSync(fresh), true, '新名字下的文件应被创建')
			assert.equal(existsSync(legacy), true, '原文件必须保留（回退到旧版本插件时还要读它）')
			assert.equal(readFileSync(fresh, 'utf8'), readFileSync(legacy, 'utf8'))
			assert.equal(state.payload.doc.global[0].title, '旧名下的规则')

			// 保存走的是新文件，备份也挂在新名字下
			const saved = await callRoute(ctx, 'POST', '/ian-rules/save', JSON.stringify({ doc: state.payload.doc, revision: state.payload.meta.revision }))
			assert.equal(saved.status, 200)
			assert.equal(existsSync(path.join(home, 'ian-rules.json.bak')), true)

			// 新文件已经在时不重复迁移（也不会声称迁移过）
			const again = makeCtx()
			apply(again)
			t.after(() => again.disposeAll())
			const second = await callRoute(again, 'GET', '/ian-rules/state')
			assert.equal(second.payload.meta.migratedFrom, '')
			assert.equal(second.payload.doc.global[0].title, '旧名下的规则')
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = previous
			rmSync(home, { recursive: true, force: true })
		}
	}
})

test('更名迁移：两代旧文件同时存在时，取更新的那一代', async (t) => {
	const home = withHome(t)
	const docIn = (title) => JSON.stringify({ version: 1, enabled: true, global: [{ id: 'g1', title, content: 'x' }], projects: [] })
	writeFileSync(path.join(home, 'agent-rules.json'), docIn('上一代'), 'utf8')
	writeFileSync(path.join(home, 'dev-rules.json'), docIn('更早一代'), 'utf8')

	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const state = await callRoute(ctx, 'GET', '/ian-rules/state')
	assert.equal(state.payload.meta.migratedFrom, path.join(home, 'agent-rules.json'), '应按由新到旧的顺序取第一个存在的')
	assert.equal(state.payload.doc.global[0].title, '上一代')
})

test('按场景注入：命中的规则走消息尾部，常驻规则留在系统提示，目录常驻', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ title: '常驻规则', content: '永远都在' },
					{ title: '依赖升级单独提交', content: '升级依赖不要和功能改动混在同一个提交里', mode: 'auto', tags: ['依赖'] },
					{ title: '发布前核对版本号', content: '打 tag 之前核对版本号与变更日志', mode: 'auto', tags: ['发布'] },
				],
				projects: [],
			},
		}),
	)

	const agent = { session: { id: 'session-scene', header: { cwd: '/tmp/scene' } } }
	const prompt = bodyProvider(ctx)({ agent })
	// 系统提示里：常驻规则照旧，按场景的只留目录（正文不进系统提示 —— 那会毁掉前缀缓存）
	assert.match(prompt, /常驻规则/)
	assert.match(prompt, /## 按场景规则（目录）/)
	assert.match(prompt, /- 依赖升级单独提交（标签：依赖）/)
	assert.doesNotMatch(prompt, /升级依赖不要和功能改动混在同一个提交里/)

	const userMessage = { id: 'm1', role: 'user', content: [{ type: 'text', text: '我想把依赖升级到最新版' }], source: { kind: 'user' } }
	const decision = await runPreStep(ctx, { agent, messages: [userMessage], turn: 1, step: 1 })
	assert.equal(decision.messages.length, 2, '应在本轮消息尾部追加一条')
	const injected = decision.messages[1]
	assert.equal(injected.role, 'user')
	assert.equal(injected.source.kind, 'ian-rules-scene')
	assert.match(injected.content[0].text, /<system-reminder>/)
	assert.match(injected.content[0].text, /依赖升级单独提交/)
	assert.match(injected.content[0].text, /升级依赖不要和功能改动混在同一个提交里/)
	// 没命中的那条既不在正文里，也不该被说成「命中」
	assert.doesNotMatch(injected.content[0].text, /发布前核对版本号/)
	assert.match(injected.content[0].text, /另有 1 条按场景规则本次未命中/)
})

test('按场景注入：同一轮不重复注入，跨轮重新匹配', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] },
					{ title: '发布前核对版本号', content: '打 tag 前核对版本号', mode: 'auto', tags: ['发布'] },
				],
				projects: [],
			},
		}),
	)
	const agent = { session: { id: 'session-scene-2', header: { cwd: '/tmp/scene' } } }
	const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

	const first = await runPreStep(ctx, { agent, messages: [message('m1', '把依赖升级一下')], turn: 1, step: 1 })
	assert.equal(first.messages.length, 2, '原始消息 + 注入的一条')
	assert.match(first.messages[1].content[0].text, /依赖升级单独提交/)
	// 同一轮的第 2 步：没有新消息，规则不能飘，也不能重复注入（每条注入都会留在历史里）
	const second = await runPreStep(ctx, { agent, messages: [], turn: 1, step: 2 })
	assert.equal(second.messages.length, 0)
	// 下一轮换成发布相关：重新匹配，换一条
	const nextTurn = await runPreStep(ctx, { agent, messages: [message('m2', '准备发布新版本了')], turn: 2, step: 1 })
	assert.equal(nextTurn.messages.length, 2)
	assert.match(nextTurn.messages[1].content[0].text, /发布前核对版本号/)
	assert.doesNotMatch(nextTurn.messages[1].content[0].text, /\*\*依赖升级单独提交\*\*/)
})

test('按场景注入：开关关着、或没有相关规则时，一条都不注入', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const agent = { session: { id: 'session-scene-3', header: { cwd: '/tmp/scene' } } }
	const message = (text) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

	// 总开关关着：任何消息都不注入
	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, sceneMatching: 'off', global: [{ title: '依赖升级单独提交', content: 'x', mode: 'auto', tags: ['依赖'] }], projects: [] } }),
	)
	assert.equal((await runPreStep(ctx, { agent, messages: [message('升级依赖')], turn: 1, step: 1 })).messages.length, 1)

	// 开着但这条消息和任何规则都不相关：不注入（宁可不注入，也不要塞无关规则）
	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, sceneMatching: 'auto', global: [{ title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] }], projects: [] } }),
	)
	assert.equal((await runPreStep(ctx, { agent, messages: [message('今天天气不错')], turn: 2, step: 1 })).messages.length, 1)

	// 规则总开关一关，按场景也一起停
	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: false, sceneMatching: 'auto', global: [{ title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] }], projects: [] } }),
	)
	assert.equal((await runPreStep(ctx, { agent, messages: [message('升级依赖')], turn: 3, step: 1 })).messages.length, 1)
})

test('缓存稳定：按场景注入不改变系统提示那条路径的渲染结果', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ title: '常驻规则', content: '永远都在' },
					{ title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] },
				],
				projects: [],
			},
		}),
	)
	const agent = { session: { id: 'session-scene-4', header: { cwd: '/tmp/scene' } } }
	const provider = bodyProvider(ctx)
	// 连续取值必须逐字节相同：按场景注入走消息尾部，一行都不该动系统提示
	const first = provider({ agent })
	assert.equal(provider({ agent }), first)
	assert.equal(provider({ agent }), first)
	assert.ok(first.includes('常驻规则'))

	// 真的跑一次注入，再回头看系统提示：必须逐字节没变。
	// 这条是本插件最重要的一条纪律 —— 系统提示一变，它之后的全部内容都要按
	// 未命中价重算（在本机路由上是 50 倍的差价）。
	const message = { id: 'm', role: 'user', content: [{ type: 'text', text: '升级依赖' }], source: { kind: 'user' } }
	const decision = await runPreStep(ctx, { agent, messages: [message], turn: 1, step: 1 })
	assert.equal(decision.messages.length, 2, '确实注入了')
	assert.equal(provider({ agent }), first, '按场景注入不许改变系统提示那条路径的任何一个字节')
})

test('接口：/scene 场景模拟 —— 报出命中、差一点命中与阈值', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ id: 'a1', title: '依赖升级单独提交', content: '升级依赖不要和功能改动混在一个提交里', mode: 'auto', tags: ['依赖'] },
					{ id: 'a2', title: '发布前核对版本号', content: '打 tag 之前核对版本号与变更日志', mode: 'auto', tags: ['发布'] },
					{ id: 'a3', title: '常驻规则', content: '永远都在' },
				],
				projects: [],
			},
		}),
	)

	const hit = await callRoute(ctx, 'POST', '/ian-rules/scene', JSON.stringify({ path: '/tmp/scene', text: '把依赖升级到最新版' }))
	assert.equal(hit.status, 200)
	assert.equal(hit.payload.sceneMatching, true)
	assert.equal(hit.payload.total, 2, '只统计按场景规则，常驻的不算')
	assert.deepEqual(hit.payload.matched.map((entry) => entry.id), ['a1'])
	assert.equal(hit.payload.matched[0].score > hit.payload.threshold, true)
	// 「差一点命中」要能解释为什么没进来 —— 这是面板敢让用户开这个功能的前提
	assert.deepEqual(hit.payload.near.map((entry) => entry.id), ['a2'])
	assert.equal(hit.payload.near[0].score < hit.payload.threshold, true)

	// 完全无关的一句话：一条都不命中
	const none = await callRoute(ctx, 'POST', '/ian-rules/scene', JSON.stringify({ path: '/tmp/scene', text: '今天天气不错' }))
	assert.deepEqual(none.payload.matched, [])
})

test('ian_rules 工具：lookup 按关键词取正文，limit 生效', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const tool = ctx.registeredTools.find((entry) => entry.name === 'ian_rules')

	assert.equal((await tool.execute({ action: 'lookup' })).ok, false, '缺 query 要拦下')

	await tool.execute({ action: 'add', title: '依赖升级单独提交', content: '升级依赖单独一个提交' })
	await tool.execute({ action: 'add', title: '发布前核对版本号', content: '打 tag 前核对版本号' })
	await tool.execute({ action: 'add', title: '提交前跑测试', content: 'npm test 必须绿' })

	const found = await tool.execute({ action: 'lookup', query: '我要升级依赖', path: '/tmp/none' })
	assert.equal(found.ok, true)
	assert.match(found.data, /依赖升级单独提交/)
	assert.match(found.data, /升级依赖单独一个提交/, '必须给正文，否则 lookup 没有意义')
	assert.doesNotMatch(found.data, /发布前核对版本号/)
	assert.match(found.data, /相关度/)

	// 无关查询：说清「没找到」而不是硬塞一条
	const miss = await tool.execute({ action: 'lookup', query: '今天天气不错', path: '/tmp/none' })
	assert.match(miss.data, /没有找到相关的规则/)

	// limit 生效
	const many = await tool.execute({ action: 'lookup', query: '升级依赖', path: '/tmp/none', limit: 1 })
	assert.equal(many.data.includes('发布前核对版本号'), false)
})

test('按场景注入：开着 sceneLog 时会往命中日志里记一行', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				sceneLog: true,
				global: [{ id: 'a1', title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] }],
				projects: [],
			},
		}),
	)
	const agent = { session: { id: 'session-log', header: { cwd: '/tmp/scene' } } }
	const message = { id: 'm', role: 'user', content: [{ type: 'text', text: '升级依赖' }], source: { kind: 'user' } }
	assert.equal((await runPreStep(ctx, { agent, messages: [message], turn: 1, step: 1 })).messages.length, 2)

	// 日志是异步追加的（尽力而为，不阻塞模型步）：给它一拍
	await new Promise((resolve) => setTimeout(resolve, 50))
	const logFile = path.join(home, 'ian-rules.hits.jsonl')
	assert.equal(existsSync(logFile), true, '开了 sceneLog 就该有日志文件')
	const line = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop())
	assert.equal(line.session, 'session-log')
	assert.equal(line.turn, 1)
	assert.deepEqual(line.matched, ['a1'])

	// 默认关着时不写文件
	const quietHome = withHome(t)
	const quiet = makeCtx()
	apply(quiet)
	t.after(() => quiet.disposeAll())
	await callRoute(
		quiet,
		'POST',
		'/ian-rules/save',
		JSON.stringify({ doc: { enabled: true, sceneMatching: 'auto', global: [{ id: 'a1', title: '依赖升级单独提交', content: '升级依赖单独一个提交', mode: 'auto', tags: ['依赖'] }], projects: [] } }),
	)
	await runPreStep(quiet, { agent, messages: [message], turn: 1, step: 1 })
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.equal(existsSync(path.join(quietHome, 'ian-rules.hits.jsonl')), false, '没开就不该写日志')
})

test('按场景注入：工作目录不进匹配信号（目录名不许把规则「喊」出来）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [{ id: 'g1', title: '项目/阶段/现实', content: '起手先写下当前阶段与不能动的东西', mode: 'auto', tags: ['规划'] }],
				projects: [],
			},
		}),
	)
	// 目录名里带「项目」——曾经因为把 cwd 拼进信号，这条规则每轮都命中
	const agent = { session: { id: 'session-cwd', header: { cwd: '/home/u/项目/demo' } } }
	const message = (text) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

	assert.equal(
		(await runPreStep(ctx, { agent, messages: [message('今天天气不错')], turn: 1, step: 1 })).messages.length,
		1,
		'无关消息不该因为目录名里有「项目」而命中',
	)
	// 反向确认不是「整条都不命中」的假绿灯：真聊到规划仍要命中
	const hit = await runPreStep(ctx, { agent, messages: [message('先规划一下这个方案')], turn: 2, step: 1 })
	assert.equal(hit.messages.length, 2)
	assert.match(hit.messages[1].content[0].text, /项目\/阶段\/现实/)
})

test('接口：/scene 的 path 只决定候选范围，不进匹配信号；分数与阈值自洽', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ id: 'a1', title: '项目/阶段/现实', content: '起手先写下当前阶段', mode: 'auto', tags: ['规划'] },
					{ id: 'a2', title: '假设驱动', content: '最小可测假设→最便宜实验', mode: 'auto', tags: ['复现'] },
				],
				projects: [],
			},
		}),
	)
	const probe = (path) => callRoute(ctx, 'POST', '/ian-rules/scene', JSON.stringify({ path, text: '今天天气不错' }))
	const withCjkPath = await probe('/home/u/项目/demo')
	const neutralPath = await probe('/tmp/x')
	// 同一句话，路径不同 → 结果必须相同（路径不参与打分）
	assert.deepEqual(
		withCjkPath.payload.matched.map((entry) => entry.id),
		neutralPath.payload.matched.map((entry) => entry.id),
	)
	// 面板要能解释结果：命中项的分数必须真的过了阈值
	assert.ok(withCjkPath.payload.matched.every((entry) => entry.score >= withCjkPath.payload.threshold))
	const related = await callRoute(ctx, 'POST', '/ian-rules/scene', JSON.stringify({ path: '/tmp/x', text: '这段代码复现不了' }))
	assert.deepEqual(related.payload.matched.map((entry) => entry.id), ['a2'])
	assert.ok(related.payload.matched[0].score >= related.payload.threshold)
})

test('按场景注入：消息没命中时退回用本会话动过的文件名（且只作兜底）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ id: 'a1', title: '假设驱动', content: '最小可测假设→最便宜实验', mode: 'auto', tags: ['bug', '复现'] },
					{ id: 'a2', title: '条件结论', content: '结论必带环境与规模', mode: 'auto', tags: ['latency', '性能'] },
				],
				projects: [],
			},
		}),
	)

	/** 会话桩：带 deriveMessages()，模拟「本会话动过哪些文件」。 */
	const agentWith = (id, cwd, files) => ({
		agent: {
			session: {
				id,
				header: { cwd },
				deriveMessages: () =>
					files.map((file, index) => ({
						id: 'h' + String(index),
						role: 'assistant',
						content: [{ type: 'tool-call', id: 'c' + String(index), name: 'read', arguments: JSON.stringify({ path: file }) }],
					})),
			},
		},
	})
	const msg = (text) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
	const run = (id, cwd, files, text, turn = 1) =>
		runPreStep(ctx, { ...agentWith(id, cwd, files), messages: [msg(text)], turn, step: 1 })

	// 消息本身没命中，但会话在读 bug-repro.ts → 兜底命中「假设驱动」
	const byFile = await run('s-file-hit', '/tmp/x', ['/repo/perf/bug-repro.ts'], '帮我看看这个')
	assert.equal(byFile.messages.length, 2, '应靠文件名兜底命中')
	assert.match(byFile.messages[1].content[0].text, /假设驱动/)

	// 通用文件名不参与：否则等于按文件名随机触发规则
	const stopwords = await run('s-stopword', '/tmp/x', ['/repo/src/index.ts', '/repo/src/utils.ts', '/repo/package.json'], '帮我看看这个')
	assert.equal(stopwords.messages.length, 1, 'index/utils/package 这类名字不该喊出任何规则')

	// 中文路径不参与（踩过的坑：~/项目/ 里的「项目」被喂给匹配器）
	const cjkPath = await run('s-cjk', '/tmp/x', ['/home/u/项目/性能.ts'], '帮我看看这个')
	assert.equal(cjkPath.messages.length, 1, '中文路径不该参与匹配')

	// 只作兜底：消息已经命中时，文件名不许改变结果（这条守的是「路径不与消息争主导」）
	const messageWins = await run('s-priority', '/tmp/x', ['/repo/perf/latency-bench.ts'], '这段代码复现不了')
	assert.equal(messageWins.messages.length, 2)
	assert.match(messageWins.messages[1].content[0].text, /假设驱动/, '应该是消息命中的那条')
	assert.doesNotMatch(messageWins.messages[1].content[0].text, /条件结论/, '文件名对应的那条不该挤进来')

	// deriveMessages 抛错也不能把模型步带崩
	const broken = {
		agent: {
			session: {
				id: 's-broken',
				header: { cwd: '/tmp/x' },
				deriveMessages() {
					throw new Error('会话历史读不了')
				},
			},
		},
	}
	const survived = await runPreStep(ctx, { ...broken, messages: [msg('帮我看看这个')], turn: 1, step: 1 })
	assert.equal(survived.messages.length, 1)
})

test('按场景注入：命中集合没变就不重复注入（否则每轮都在历史里堆一份同样的规则）', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	await callRoute(
		ctx,
		'POST',
		'/ian-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				sceneMatching: 'auto',
				global: [
					{ id: 'a1', title: '假设驱动', content: '最小可测假设→最便宜实验', mode: 'auto', tags: ['复现'] },
					{ id: 'a2', title: '条件结论', content: '结论必带环境与规模', mode: 'auto', tags: ['性能'] },
				],
				projects: [],
			},
		}),
	)
	const agent = { session: { id: 'session-repeat', header: { cwd: '/tmp/x' } } }
	const msg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

	// 第 1 轮命中 → 注入
	const first = await runPreStep(ctx, { agent, messages: [msg('m1', '这段代码复现不了')], turn: 1, step: 1 })
	assert.equal(first.messages.length, 2)
	// 第 2 轮同样命中同一条：正文已经在上一条消息里了，不该再堆一份
	const second = await runPreStep(ctx, { agent, messages: [msg('m2', '还是复现不了')], turn: 2, step: 1 })
	assert.equal(second.messages.length, 1, '同样的命中集合不该重复注入（设计里写的是「集合没变就不重复注入」）')
	// 但命中集合变了就要注入新的
	const third = await runPreStep(ctx, { agent, messages: [msg('m3', '这段代码复现不了，另外帮我看看性能')], turn: 3, step: 1 })
	assert.equal(third.messages.length, 2, '集合变大 = 变了，要注入')
	assert.match(third.messages[1].content[0].text, /假设驱动/)
	assert.match(third.messages[1].content[0].text, /条件结论/)
	// 再回到原来的集合（只剩假设驱动）：digest 与上次不同 → 也要注入，把范围收回来
	const back = await runPreStep(ctx, { agent, messages: [msg('m4', '还是复现不了')], turn: 4, step: 1 })
	assert.equal(back.messages.length, 2)
	assert.doesNotMatch(back.messages[1].content[0].text, /条件结论/)
})
