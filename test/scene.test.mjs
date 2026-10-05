/**
 * 场景匹配器的单元测试：不启动 DSH、不碰宿主，只验「哪几条规则会因为这轮任务被挑出来」。
 *
 * 这里最该守住的两件事：
 *   1. **不该命中的不许命中** —— 中文单字太容易撞车（「最新版」vs「版本号」只共享一个
 *      「版」字），靠降权 + 阈值压住；宁可不注入，也不要塞一条无关规则进上下文；
 *   2. **该命中的必须命中** —— 标签与标题是最强的信号，被降权或阈值误伤就失去意义。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SCENE_BUDGET_CHARS, SCENE_LIMIT, SCENE_THRESHOLD, sceneDigest, scoreRule, selectSceneRules, tokenize } from '../lib/scene.js'

const rule = (id, title, content, tags = []) => ({ id, title, content, tags, mode: 'auto', enabled: true, group: '' })

test('tokenize：ASCII 转小写按词切，CJK 出二元组 + 单字', () => {
	const terms = tokenize('提交前跑 npm test')
	assert.ok(terms.words.has('提交'), '二元组')
	assert.ok(terms.words.has('测试') === false, '不跨越分隔')
	assert.ok(terms.words.has('npm'))
	assert.ok(terms.words.has('test'))
	assert.ok(terms.chars.has('提'), '单字作为兜底')
	// 单字母不算词（噪声太大）
	assert.equal(tokenize('a b cd').words.has('a'), false)
	assert.equal(tokenize('a b cd').words.has('cd'), true)
	assert.deepEqual([...tokenize('').words], [])
})

test('scoreRule：标签 > 标题 > 正文，且长文要被长度归一化压住', () => {
	const signal = tokenize('升级依赖')
	const byTag = scoreRule(rule('a', '', 'x'.repeat(40), ['升级依赖']), signal)
	const byTitle = scoreRule(rule('b', '升级依赖', 'x'.repeat(40)), signal)
	const byContent = scoreRule(rule('c', '无关标题', '升级依赖' + 'x'.repeat(40)), signal)
	assert.ok(byTag > byTitle, '标签权重最高')
	assert.ok(byTitle > byContent, '标题其次')
	// 同样命中，正文越长分越低（否则一条巨型规则通吃所有场次）
	const short = scoreRule(rule('d', '升级依赖', '升级依赖'), signal)
	const long = scoreRule(rule('e', '升级依赖', '升级依赖' + 'x'.repeat(2000)), signal)
	assert.ok(short > long)
	// 毫无关联就是 0
	assert.equal(scoreRule(rule('f', '发布前核对版本号', '打 tag 前核对版本号'), signal), 0)
})

test('scoreRule：只共享一个汉字不许过阈值（「最新版」不该命中「版本号」）', () => {
	const signal = tokenize('我想把依赖升级到最新版')
	const unrelated = rule('x', '发布前核对版本号', '打 tag 之前核对版本号与变更日志', ['发布'])
	assert.ok(scoreRule(unrelated, signal) < SCENE_THRESHOLD, '单字撞车必须被降权压到阈值以下')
	// 真相关的仍然远在阈值之上
	const related = rule('y', '依赖升级单独提交', '升级依赖不要和功能改动混在同一个提交里', ['依赖'])
	assert.ok(scoreRule(related, signal) > SCENE_THRESHOLD * 2)
})

test('selectSceneRules：阈值、条数上限、字符预算都生效', () => {
	const rules = [
		rule('r1', '依赖升级单独提交', '升级依赖单独一个提交', ['依赖']),
		rule('r2', '发布前核对版本号', '打 tag 之前核对版本号', ['发布']),
		rule('r3', '提交前跑测试', 'npm test 必须绿', ['提交']),
	]
	const selected = selectSceneRules(rules, '我要升级依赖', {})
	assert.deepEqual(selected.matched.map((entry) => entry.id), ['r1'])
	// skipped 只装「够相关但被条数 / 预算挤掉」的：不相关的根本没资格进来，
	// 把它们也塞进来会让「未命中」的提示失去意义。
	assert.deepEqual(selected.skipped, [])

	// 条数上限
	const many = Array.from({ length: 12 }, (_, index) => rule('m' + String(index), '依赖升级', '升级依赖', ['依赖']))
	const capped = selectSceneRules(many, '升级依赖', { limit: 3 })
	assert.equal(capped.matched.length, 3)
	assert.equal(capped.skipped.length, 9, '够相关但被条数挤掉的要报出来')
	assert.equal(selectSceneRules(many, '升级依赖', {}).matched.length, SCENE_LIMIT)

	// 字符预算：只容得下一条时不许硬塞第二条
	const bulky = [
		rule('b1', '依赖升级', '升级依赖' + 'x'.repeat(SCENE_BUDGET_CHARS), ['依赖']),
		rule('b2', '依赖升级', '升级依赖' + 'x'.repeat(SCENE_BUDGET_CHARS), ['依赖']),
	]
	assert.equal(selectSceneRules(bulky, '升级依赖', {}).matched.length, 1)
})

test('selectSceneRules：sticky 的 pinned 优先保留，但要给新命中留位', () => {
	const rules = [
		rule('p1', '依赖升级单独提交', '升级依赖单独一个提交', ['依赖']),
		rule('p2', '提交前跑测试', 'npm test 必须绿', ['提交']),
		rule('n1', '发布前核对版本号', '打 tag 之前核对版本号', ['发布']),
	]
	// 上一轮命中过 p1、p2；这一轮说「发布」——pinned 保留，且新的一条也能挤进来
	const selected = selectSceneRules(rules, '准备发布新版本', { pinned: ['p1', 'p2'], limit: 3 })
	assert.deepEqual(selected.matched.map((entry) => entry.id), ['p1', 'p2', 'n1'])
	assert.ok(selected.matched.length <= 3)

	// pinned 不能占满名额，否则新场景永远挤不进来
	const crowded = selectSceneRules(rules, '准备发布新版本', { pinned: ['p1', 'p2'], limit: 2 })
	assert.equal(crowded.matched.length, 2)
	assert.ok(crowded.matched.some((entry) => entry.id === 'n1'), 'limit=2 时 pinned 只保 1 个，留 1 个给新命中')

	// 信号里什么都没命中时，pinned 仍然在（这一轮的第 2 步不再有用户消息）
	const quiet = selectSceneRules(rules, '/tmp/proj', { pinned: ['p1'] })
	assert.deepEqual(quiet.matched.map((entry) => entry.id), ['p1'])
})

test('sceneDigest：集合不变则指纹不变，规则被编辑过就要重新注入', () => {
	const a = rule('x', '标题', '正文')
	const b = rule('y', '标题', '正文')
	assert.equal(sceneDigest([a]), sceneDigest([{ ...a }]))
	assert.notEqual(sceneDigest([a]), sceneDigest([b]))
	assert.notEqual(sceneDigest([a]), sceneDigest([{ ...a, content: '正文改过了' }]))
	assert.notEqual(sceneDigest([a]), sceneDigest([a, b]), '多一条也算变了')
})
