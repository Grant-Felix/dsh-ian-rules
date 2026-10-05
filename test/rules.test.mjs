import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
	MAX_SECTION_CHARS,
	containsPath,
	countMarkdownRules,
	effectiveRules,
	emptyDoc,
	estimateTokens,
	groupNames,
	matchProject,
	matchProjects,
	normalizePath,
	parseMarkdownDoc,
	renderRules,
	ruleSize,
	sanitizeDoc,
	summarizeDoc,
	toMarkdownDoc,
} from '../lib/rules.js'

const posix = (value) => path.sep === '/' ? value : value

test('normalizePath：展开 ~、补全绝对路径、去掉尾部分隔符', () => {
	assert.equal(normalizePath('~'), os.homedir())
	assert.equal(normalizePath('~/项目/foo/'), path.join(os.homedir(), '项目/foo'))
	assert.equal(normalizePath('/tmp/a/b/'), '/tmp/a/b')
	assert.equal(normalizePath(''), '')
	assert.equal(normalizePath('   '), '')
	assert.equal(normalizePath('rel/dir', '/tmp/base'), '/tmp/base/rel/dir')
})

test('sanitizeDoc：任何垃圾输入都收敛成合法文档', () => {
	const doc = sanitizeDoc(null)
	assert.deepEqual(doc, emptyDoc())

	const messy = sanitizeDoc({
		enabled: false,
		global: [
			null,
			{ title: '  ', content: '   ' },
			{ title: '  提交前跑测试  ', content: 'npm test 必须绿  \n\n' },
			{ id: 'dup', title: 'A', content: 'x' },
			{ id: 'dup', title: 'B', content: 'y' },
		],
		projects: [
			{ path: '' },
			{ path: '/tmp/proj-a', mode: 'nonsense', rules: [{ content: '只有正文' }] },
			{ path: '/tmp/proj-a', rules: [] },
			{ path: '/tmp/proj-b', mode: 'override', enabled: false, label: '  B  ' },
		],
	})
	assert.equal(messy.enabled, false)
	assert.equal(messy.global.length, 3)
	assert.equal(messy.global[0].title, '提交前跑测试')
	assert.equal(messy.global[0].content, 'npm test 必须绿')
	assert.equal(messy.global[0].enabled, true)
	// 重复 id 被改写；两条都保留
	assert.notEqual(messy.global[1].id, messy.global[2].id)
	// 空路径项目被丢弃，重复路径只留一条
	assert.equal(messy.projects.length, 2)
	assert.equal(messy.projects[0].path, posix('/tmp/proj-a'))
	assert.equal(messy.projects[0].mode, 'append')
	// 正文兜底成标题
	assert.equal(messy.projects[0].rules[0].title, '只有正文')
	assert.equal(messy.projects[1].mode, 'override')
	assert.equal(messy.projects[1].enabled, false)
	assert.equal(messy.projects[1].label, 'B')
})

test('matchProject：取最长前缀，且不跨目录边界', () => {
	const doc = sanitizeDoc({
		projects: [
			{ path: '/tmp/proj', rules: [] },
			{ path: '/tmp/proj/sub', rules: [] },
			{ path: '/tmp/proj-other', enabled: false, rules: [] },
		],
	})
	assert.equal(matchProject(doc, '/tmp/proj/sub/deep').path, posix('/tmp/proj/sub'))
	assert.equal(matchProject(doc, '/tmp/proj/other').path, posix('/tmp/proj'))
	assert.equal(matchProject(doc, '/tmp/proj').path, posix('/tmp/proj'))
	// /tmp/projabc 不属于 /tmp/proj
	assert.equal(matchProject(doc, '/tmp/projabc'), null)
	// 停用的项目不参与匹配
	assert.equal(matchProject(doc, '/tmp/proj-other/x'), null)
	assert.equal(matchProject(doc, ''), null)
})

test('effectiveRules：追加与覆盖两种模式', () => {
	const doc = sanitizeDoc({
		global: [{ id: 'g1', title: 'G1', content: 'g1' }, { id: 'g2', title: 'G2', content: 'g2', enabled: false }],
		projects: [
			{ path: '/tmp/append', mode: 'append', rules: [{ id: 'p1', title: 'P1', content: 'p1' }] },
			{ path: '/tmp/override', mode: 'override', rules: [{ id: 'p2', title: 'P2', content: 'p2' }] },
		],
	})

	const appended = effectiveRules(doc, '/tmp/append/src')
	assert.deepEqual(appended.rules.map((rule) => rule.id), ['g1', 'p1'])
	assert.equal(appended.override, false)
	assert.equal(appended.project.path, posix('/tmp/append'))

	const overridden = effectiveRules(doc, '/tmp/override/src')
	assert.deepEqual(overridden.rules.map((rule) => rule.id), ['p2'])
	assert.equal(overridden.override, true)
	assert.equal(overridden.globalRules.length, 1)

	// 未命中项目 → 只有全局
	const plain = effectiveRules(doc, '/tmp/elsewhere')
	assert.deepEqual(plain.rules.map((rule) => rule.id), ['g1'])
	assert.equal(plain.project, null)
})

test('matchProjects：返回完整命中链，由外到内', () => {
	const doc = sanitizeDoc({
		projects: [
			{ path: '/tmp/mono/packages/a', rules: [] },
			{ path: '/tmp/mono', rules: [] },
			{ path: '/tmp/mono/packages/a/deep', enabled: false, rules: [] },
		],
	})
	assert.deepEqual(matchProjects(doc, '/tmp/mono/packages/a/src').map((p) => p.path), [
		posix('/tmp/mono'),
		posix('/tmp/mono/packages/a'),
	])
	// 单命中时与 matchProject 一致
	assert.deepEqual(matchProjects(doc, '/tmp/mono/x').map((p) => p.path), [posix('/tmp/mono')])
	assert.equal(matchProject(doc, '/tmp/mono/x').path, posix('/tmp/mono'))
	// 停用的项目不进链；命中不到就是空数组
	assert.deepEqual(matchProjects(doc, '/tmp/mono/packages/a/deep').map((p) => p.path), [posix('/tmp/mono'), posix('/tmp/mono/packages/a')])
	assert.deepEqual(matchProjects(doc, ''), [])
})

test('effectiveRules：monorepo 父子叠加，父级不再被静默丢弃', () => {
	const doc = sanitizeDoc({
		global: [{ id: 'g1', title: 'G', content: 'g' }],
		projects: [
			{ path: '/repo', mode: 'append', rules: [{ id: 'root', title: '根级约定', content: '统一用 pnpm' }] },
			{ path: '/repo/packages/a', mode: 'append', rules: [{ id: 'leaf', title: '子包约定', content: 'A 包走 esm' }] },
		],
	})
	const effective = effectiveRules(doc, '/repo/packages/a/src')
	// 顺序：全局 → 父级 → 子级
	assert.deepEqual(effective.rules.map((rule) => rule.id), ['g1', 'root', 'leaf'])
	assert.equal(effective.project.path, posix('/repo/packages/a'))
	assert.deepEqual(effective.inheritedProjects.map((p) => p.path), [posix('/repo')])
	assert.equal(effective.override, false)
	// 渲染里要说明继承发生了，并且确实注入了父级规则
	const text = renderRules(doc, '/repo/packages/a/src')
	assert.match(text, /根级约定/)
	assert.match(text, /本段含继承自上层项目的规则（父级在前）：\/repo/)
})

test('effectiveRules：层叠 override —— 链上最后一个覆盖项目挡掉它之上的全部层', () => {
	const base = {
		global: [{ id: 'g1', title: 'G', content: 'g' }],
		projects: [
			{ id: 'root', path: '/repo', mode: 'append', rules: [{ id: 'root', title: '根', content: 'r' }] },
			{ id: 'leaf', path: '/repo/pkg', mode: 'append', rules: [{ id: 'leaf', title: '子', content: 'l' }] },
		],
	}
	// 父 override + 子 append：全局被挡，父与子的规则都生效
	const parentOverride = effectiveRules(sanitizeDoc({ ...base, projects: [ { ...base.projects[0], mode: 'override' }, base.projects[1] ] }), '/repo/pkg')
	assert.deepEqual(parentOverride.rules.map((rule) => rule.id), ['root', 'leaf'])
	assert.equal(parentOverride.override, true)
	assert.equal(parentOverride.suppressedGlobalRules.length, 1)

	// 子 override：父级与全局都被挡（覆盖上层全部）
	const leafOverride = effectiveRules(sanitizeDoc({ ...base, projects: [base.projects[0], { ...base.projects[1], mode: 'override' }] }), '/repo/pkg')
	assert.deepEqual(leafOverride.rules.map((rule) => rule.id), ['leaf'])
	assert.deepEqual(leafOverride.inheritedProjects, [])
	assert.equal(leafOverride.project.path, posix('/repo/pkg'))

	// 单层 override：与旧行为一致
	const single = sanitizeDoc({
		global: [{ id: 'g1', title: 'G', content: 'g' }],
		projects: [{ path: '/repo', mode: 'override', rules: [{ id: 'p', title: 'P', content: 'p' }] }],
	})
	assert.deepEqual(effectiveRules(single, '/repo').rules.map((rule) => rule.id), ['p'])
})

test('renderRules：无生效规则就返回空串（等于不注入）', () => {
	assert.equal(renderRules(emptyDoc(), '/tmp/x'), '')
	assert.equal(renderRules(sanitizeDoc({ enabled: false, global: [{ title: 'A', content: 'a' }] }), '/tmp/x'), '')
	// 命中项目但项目规则为空、全局被覆盖 → 也不注入
	const overrideEmpty = sanitizeDoc({
		global: [{ title: 'A', content: 'a' }],
		projects: [{ path: '/tmp/x', mode: 'override', rules: [] }],
	})
	assert.equal(renderRules(overrideEmpty, '/tmp/x'), '')
})

test('renderRules：两级标题 —— 第一级是全局 / 哪个项目，第二级才是用户分组', () => {
	const doc = sanitizeDoc({
		global: [
			{ title: '全局规矩', content: '第一行\n第二行', group: '通用' },
			{ title: '未分组全局', content: 'x' },
		],
		projects: [{ path: '/tmp/proj', label: '示例项目', rules: [{ title: '项目规矩', content: '只管本项目', group: '本项目组' }] }],
	})
	const text = renderRules(doc, '/tmp/proj/src')
	assert.match(text, /# 项目开发规则/)
	assert.match(text, /## 全局规则/)
	// 第一级写具体项目名（别名 + 路径）；不再有单独的「适用项目 / 规则来源」两行
	assert.match(text, /## 项目：示例项目（\/tmp\/proj）/)
	assert.doesNotMatch(text, /适用项目：/)
	assert.doesNotMatch(text, /规则来源：/)
	// 第二级是用户分组；编号跨两级连续
	assert.match(text, /### 通用\n1\. \*\*全局规矩\*\*/)
	assert.match(text, /### 本项目组\n3\. \*\*项目规矩\*\*/)
	assert.match(text, /第二行/)
	// 未命中项目时不出现任何项目段落，并明确说明只剩全局规则
	const outside = renderRules(doc, '/tmp/none')
	assert.doesNotMatch(outside, /## 项目：/)
	assert.match(outside, /当前目录未匹配到项目规则集/)
	// 没有别名时标题只写路径
	const bare = sanitizeDoc({ global: [], projects: [{ path: '/tmp/bare', rules: [{ title: 'R', content: 'r' }] }] })
	assert.match(renderRules(bare, '/tmp/bare'), /## 项目：\/tmp\/bare/)
})

test('renderRules：超长文本被裁到上限内，并说明少了哪几条', () => {
	const big = Array.from({ length: 400 }, (_, index) => ({
		title: '规则 ' + String(index),
		content: '这条规则的正文写得比较长，用来把注入文本撑到上限以上：'.repeat(4),
	}))
	const text = renderRules(sanitizeDoc({ global: big }), '/tmp/x')
	assert.ok(text.length < MAX_SECTION_CHARS + 200)
	// 关键：不能说「已截断」就完事 —— 得说清少了几条，否则 agent 以为自己看到了全部规则
	assert.match(text, /本轮有 \d+ 条未注入/)
	assert.match(text, /ian_rules 工具/)
	// 说明必须落在头部：放尾部会被截断自己切掉
	assert.ok(text.indexOf('条未注入') < text.indexOf('## 全局规则'))
	// 预览可以要求不裁
	const full = renderRules(sanitizeDoc({ global: big }), '/tmp/x', { limit: Number.POSITIVE_INFINITY })
	assert.ok(full.length > MAX_SECTION_CHARS)
	assert.doesNotMatch(full, /未注入/)
})

test('renderRules：超限时先裁全局、保住项目规则（具体性优先）', () => {
	// 全局 120 条撑爆上限，项目只有 1 条 —— 旧实现从尾部切，把项目规则整条丢掉
	const global = Array.from({ length: 120 }, (_, index) => ({
		title: '全局规则' + String(index),
		content: '这是一条比较长的全局规则正文，用来撑大注入体积。'.repeat(4),
	}))
	const doc = sanitizeDoc({
		global,
		projects: [{ path: '/tmp/proj', label: '示例', rules: [{ title: '项目专属规则', content: '项目里最重要的那条约定。' }] }],
	})
	const text = renderRules(doc, '/tmp/proj')
	assert.ok(text.length <= MAX_SECTION_CHARS)
	assert.match(text, /\*\*项目专属规则\*\*/)
	// 被裁掉的一定是全局，且裁掉的是末尾那几条
	assert.match(text, /未注入：全局规则119/)
	assert.match(text, /1\. \*\*全局规则0\*\*/)
	// 编号必须连续（重新渲染而不是从中间切字符串，所以不会出现断号）
	const numbers = [...text.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
	assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1))
	// 永不返回空串（全裁光才是真正的静默失效）
	assert.notEqual(renderRules(sanitizeDoc({ global: [{ title: '唯一一条', content: 'x'.repeat(20000) }] }), '/tmp/x'), '')
})

test('renderRules：上限内时输出与旧版一致（不引入任何多余说明）', () => {
	const doc = sanitizeDoc({
		global: [{ title: 'A', content: 'a' }],
		projects: [{ path: '/tmp/p', rules: [{ title: 'B', content: 'b' }] }],
	})
	const text = renderRules(doc, '/tmp/p')
	assert.doesNotMatch(text, /未注入/)
	assert.doesNotMatch(text, /已截断/)
	// 逐字节稳定：同一份文档渲染两次必须完全相同（否则会不停顶掉提示词缓存）
	assert.equal(text, renderRules(doc, '/tmp/p'))
})

test('数据 v2：规则带 mode / tags，老文档补默认值后行为不变', () => {
	// v1 文档没有 mode / tags：读进来必须补成 always + 空标签
	const v1 = sanitizeDoc({
		version: 1,
		global: [{ id: 'g1', title: 'A', content: 'a' }],
		projects: [{ path: '/tmp/v1', rules: [{ id: 'r1', title: 'B', content: 'b' }] }],
	})
	assert.equal(v1.version, 2)
	assert.equal(v1.sceneMatching, 'off')
	assert.equal(v1.global[0].mode, 'always')
	assert.deepEqual(v1.global[0].tags, [])
	assert.equal(v1.projects[0].rules[0].mode, 'always')

	// mode / tags 的规范化：未知 mode 回落到 always、标签去重限量限长
	const messy = sanitizeDoc({
		sceneMatching: 'nonsense',
		global: [
			{ title: 'X', content: 'x', mode: 'auto', tags: [' 依赖 ', '依赖', '', 'a'.repeat(80), 42] },
			{ title: 'Y', content: 'y', mode: 'nonsense', tags: '提交、依赖 依赖' },
		],
	})
	assert.equal(messy.sceneMatching, 'off')
	assert.equal(messy.global[0].mode, 'auto')
	assert.deepEqual(messy.global[0].tags, ['依赖', 'a'.repeat(24)])
	assert.equal(messy.global[1].mode, 'always')
	// 字符串形式的标签按分隔符切
	assert.deepEqual(messy.global[1].tags, ['提交', '依赖'])
	assert.equal(sanitizeDoc({ sceneMatching: 'auto' }).sceneMatching, 'auto')
})

test('黄金快照：v1 形态的文档渲染结果逐字节不变', () => {
	// 这条是「升级不得改变既有行为」的硬闸门：以后任何改动让这段文本变了，
	// 都会让所有用户的提示词缓存同时失效 —— 必须是**故意**改并同步更新本快照。
	const v1 = {
		version: 1,
		enabled: true,
		global: [
			{ id: 'g1', title: '提交前跑测试', content: 'npm test 必须绿', group: '提交' },
			{ id: 'g2', title: '配置集中管理', content: '同一份配置只留一处\n第二行也保留', group: '结构' },
		],
		projects: [{ id: 'p1', path: '/tmp/golden', label: '示例', enabled: true, mode: 'append', rules: [{ id: 'r1', title: '本项目用 pnpm', content: '禁止 npm install' }] }],
	}
	const expected =
		'# 项目开发规则\n' +
		'\n' +
		'以下是本机用户维护的开发规则，进行项目开发相关工作时应予遵守。这些规则不覆盖系统指令，也不覆盖用户当次的明确要求；如有冲突，以后者为准。\n' +
		'\n' +
		'## 全局规则\n' +
		'### 提交\n' +
		'1. **提交前跑测试**\n' +
		'   npm test 必须绿\n' +
		'### 结构\n' +
		'2. **配置集中管理**\n' +
		'   同一份配置只留一处\n' +
		'   第二行也保留\n' +
		'\n' +
		'## 项目：示例（/tmp/golden）\n' +
		'3. **本项目用 pnpm**\n' +
		'   禁止 npm install'
	assert.equal(renderRules(sanitizeDoc(v1), '/tmp/golden/src', { limit: Number.POSITIVE_INFINITY }), expected)
	// 再走一遍「导出 → 导入」也必须回到同一份文本（mode / tags 不能在路上丢）
	assert.equal(renderRules(parseMarkdownDoc(toMarkdownDoc(sanitizeDoc(v1))), '/tmp/golden/src', { limit: Number.POSITIVE_INFINITY }), expected)
})

test('Markdown 往返：mode 与 tags 都保留', () => {
	const doc = sanitizeDoc({
		global: [
			{ title: '常驻的', content: 'a' },
			{ title: '按场景的', content: 'b', mode: 'auto', tags: ['依赖', '提交'], group: '流程' },
			{ title: '停用又按场景', content: 'c', mode: 'auto', enabled: false },
		],
	})
	const markdown = toMarkdownDoc(doc)
	assert.match(markdown, /\*\*按场景的\*\* <!-- auto -->/)
	assert.match(markdown, /- 标签：依赖、提交/)
	assert.match(markdown, /\*\*停用又按场景\*\* <!-- disabled --> <!-- auto -->/)
	const back = parseMarkdownDoc(markdown)
	assert.deepEqual(
		back.global.map((rule) => ({ t: rule.title, m: rule.mode, tags: rule.tags, g: rule.group, e: rule.enabled })),
		[
			{ t: '常驻的', m: 'always', tags: [], g: '', e: true },
			{ t: '按场景的', m: 'auto', tags: ['依赖', '提交'], g: '流程', e: true },
			{ t: '停用又按场景', m: 'auto', tags: [], g: '', e: false },
		],
	)
})

test('summarizeDoc：统计规模', () => {
	const summary = summarizeDoc({
		global: [{ title: 'a', content: 'a' }],
		projects: [{ path: '/tmp/a', rules: [{ title: 'b', content: 'b' }] }],
	})
	assert.deepEqual(summary, { global: 1, projects: 1, projectRules: 1, enabled: true })
})

test('分组：规范化保留 group，注入文本按组出小标题且编号连续', () => {
	const doc = sanitizeDoc({
		global: [
			{ title: 'A', content: 'a', group: '流程' },
			{ title: 'B', content: 'b' },
			{ title: 'C', content: 'c', group: '流程' },
		],
	})
	assert.equal(doc.global[0].group, '流程')
	assert.equal(doc.global[1].group, '')
	const text = renderRules(doc, '/tmp/nowhere', { limit: Number.POSITIVE_INFINITY })
	// 同一组的规则归到一起（组内保持原顺序），组标题只出现一次，编号连续
	assert.equal((text.match(/### 流程/g) || []).length, 1)
	assert.match(text, /### 流程\n1\. \*\*A\*\*/)
	assert.match(text, /2\. \*\*C\*\*/)
	assert.match(text, /3\. \*\*B\*\*/)
	assert.deepEqual(groupNames(doc), ['流程'])
})

test('覆盖模式：被挡掉的全局规则会明确告知', () => {
	const doc = sanitizeDoc({
		global: [{ title: 'G1', content: 'g1' }, { title: 'G2', content: 'g2' }],
		projects: [{ path: '/tmp/p', mode: 'override', rules: [{ title: 'P', content: 'p' }] }],
	})
	const text = renderRules(doc, '/tmp/p', { limit: Number.POSITIVE_INFINITY })
	// 覆盖模式下「## 全局规则」那一段整个不出现，损失的信息由项目标题下这句话补回来
	assert.doesNotMatch(text, /## 全局规则/)
	assert.match(text, /## 项目：\/tmp\/p/)
	assert.match(text, /本项目为覆盖模式：全局规则（2 条）在本项目内不生效/)
	assert.match(text, /\*\*P\*\*/)
	assert.doesNotMatch(text, /\*\*G1\*\*/)
	assert.equal(effectiveRules(doc, '/tmp/p').suppressedGlobalRules.length, 2)
})

test('win32 分支：大小写不敏感、两种分隔符，且不跨目录边界', () => {
	assert.equal(normalizePath('C:/proj/sub/', undefined, 'win32'), 'C:\\proj\\sub')
	const doc = sanitizeDoc({ projects: [{ path: 'C:/proj', rules: [] }, { path: 'C:\\proj\\sub', rules: [] }] })
	assert.equal(matchProject(doc, 'c:\\proj\\sub\\deep', 'win32').path, 'C:\\proj\\sub')
	assert.equal(matchProject(doc, 'C:/PROJ', 'win32').path, 'C:\\proj')
	assert.equal(matchProject(doc, 'C:\\projabc', 'win32'), null)
	assert.equal(containsPath('C:\\proj', 'C:/proj/sub', 'win32'), true)
	// POSIX 下大小写敏感
	assert.equal(containsPath('/tmp/proj', '/tmp/PROJ/sub'), false)
})

test('estimateTokens / ruleSize：CJK 与 ASCII 的粗估', () => {
	assert.equal(estimateTokens(''), 0)
	assert.equal(estimateTokens('中文四字'), 4)
	assert.equal(estimateTokens('abcd'), 1)
	assert.ok(estimateTokens('中文 with english words') > estimateTokens('中文'))
	const size = ruleSize({ title: '标题', content: '正文正文' })
	assert.equal(size.chars, 6)
	assert.ok(size.tokens >= 6)
})

test('Markdown 导出 / 导入往返：标题、分组、正文、项目模式都保留', () => {
	const doc = sanitizeDoc({
		enabled: true,
		global: [
			{ title: '提交前跑测试', content: 'npm test 必须绿\n第二行', group: '提交' },
			{ title: '停用的规则', content: 'x', enabled: false },
		],
		projects: [
			{ path: '/tmp/proj-a', label: '示例', mode: 'override', rules: [{ title: 'A', content: 'a', group: '结构' }] },
			{ path: '/tmp/proj-b', mode: 'append', enabled: false, rules: [] },
		],
	})
	const markdown = toMarkdownDoc(doc)
	assert.match(markdown, /## 全局规则/)
	assert.match(markdown, /## 项目规则：\/tmp\/proj-a \| 示例 \[override\]/)
	const back = parseMarkdownDoc(markdown)
	assert.deepEqual(
		back.global.map((rule) => ({ t: rule.title, g: rule.group, c: rule.content, e: rule.enabled })),
		[
			{ t: '提交前跑测试', g: '提交', c: 'npm test 必须绿\n第二行', e: true },
			{ t: '停用的规则', g: '', c: 'x', e: false },
		],
	)
	assert.deepEqual(
		back.projects.map((project) => ({ p: project.path, l: project.label, m: project.mode, e: project.enabled, n: project.rules.length })),
		[
			{ p: '/tmp/proj-a', l: '示例', m: 'override', e: true, n: 1 },
			{ p: '/tmp/proj-b', l: '', m: 'append', e: false, n: 0 },
		],
	)
	// 导入后渲染出来应与原文档等价
	assert.equal(renderRules(back, '/tmp/proj-a', { limit: Number.POSITIVE_INFINITY }), renderRules(doc, '/tmp/proj-a', { limit: Number.POSITIVE_INFINITY }))
	// 认不出的内容不抛错
	assert.deepEqual(countMarkdownRules('随便一段文字\n- 一条'), { global: 1, projects: 0, projectRules: 0, enabled: true })
	assert.deepEqual(countMarkdownRules(''), { global: 0, projects: 0, projectRules: 0, enabled: true })
})
