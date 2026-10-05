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
import { MAX_CONTENT, MAX_GROUP, MAX_RULES, MAX_SECTION_CHARS, MAX_TITLE } from '../lib/rules.js'

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
