/**
 * ian-rules 浏览器半体：Web GUI 右侧栏的「开发规则」面板。
 *
 * 手写的 client bundle（不经过打包器），遵循 DSH 的
 * `window.__ModuleLoader__.load({ id, factory })` 约定：脚本执行只注册工厂，
 * 模块体（含 CSS 注入）在 factory 被 materialize 时才跑。
 *
 * 设计取向（面向「打开就知道下一步做什么」）：
 *   - 顶部吸顶：状态 + 唯一的主动作「保存并生效」，其余都收进「更多」；
 *   - 空面板给三步上手提示 + 一键插入虚构示例规则（不是作者的真实规则），不留空白无从下手；
 *   - 少用术语：说「字 / 生效 / 只用本项目规则」，不暴露 revision、id、json 字段名；
 *   - 危险动作二次确认，冲突 / 导入用横幅明确二选一；
 *   - 高级功能（导出、导入、重新载入、文件位置、使用说明）折叠在「更多」里。
 *
 * 数据全部走宿主半体挂在 /ian-rules 上的 JSON 接口（fetch）：
 *   GET  /state  POST /save  POST /reload  POST /preview
 *   GET  /workspaces  POST /export  POST /import
 *
 * 唯一的例外是「插件自更新」：那份数据不归本插件，走插件市场 dshmarket 公开的
 * UPDATE-API-v1（同源 /dsh-market/api/v1/*，见其 UPDATE-API-V1.md），面板只负责问、
 * 点、看，不自己装包。探测不到市场就整块不渲染。
 *
 * 注意（本部署实测）：DSH 在启动时就把 client bundle 读进内存并按 rev 缓存，且没跑
 * `pnpm run dev:web` 时不会装 HMR watcher —— 所以**本文件改动同样需要重启一次 profile**，
 * 只硬刷新页面是拿不到新 bundle 的。
 */
window.__ModuleLoader__.load({
	// 必须等于 package.json 的 name：DSH 的客户端模块图按**包名**建行
	// （dsh-client-modules 里 `table.set(packageName, { entry: graphRow(packageName, …) })`），
	// 注册的 id 对不上就会在启动时报「Failed to load plugins」。包名一改，这里必须跟着改 ——
	// 这条约束由 test/client.test.mjs 里的同名用例钉住。
	id: 'dsh-ian-rules',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { useState, useEffect, useLayoutEffect, useCallback, useRef } = React;
		const h = React.createElement;

		const API = '/ian-rules';
		/**
		 * 更名前历代的路由（由新到旧）。留着它们只为一件事：换过路由之后，**页面已经把新客户端
		 * 加载进来、而宿主进程还是旧代码**的那段时间里，面板能自己退回去问一次（见 callApi 的
		 * 过渡回退）。不在常量表里跟其他标识一起改名 —— 它的用途就是记住旧名字：
		 * `/agent-rules` 是 dsh-agent-rules 时代，`/dev-rules` 是更早那一代的名字。
		 */
		const LEGACY_ROUTES = ['/agent-rules', '/dev-rules'];

		/**
		 * 插件自更新走插件市场（dshmarket）公开的 UPDATE-API-v1：安装算法、回滚点、
		 * 运行态记录都在市场那边，面板照它给的路径问、按它给的能力位决定显示什么，
		 * 不自己装包、也不碰市场的旧私有路由。路径是契约的一部分，写死在这里。
		 */
		const MARKET_API = '/dsh-market/api/v1';
		const MARKET_SCHEMA = 'dsh-market/update-api/v1';
		const PACKAGE_NAME = 'dsh-ian-rules';
		/** 更新是异步操作：1.5 秒问一次进度，到终态即停。 */
		const UPDATE_POLL_MS = 1500;

		/** 面板内新增条目用的短 id：与宿主的 ID_PATTERN 一致。 */
		let idSeed = 0;
		function newId(prefix) {
			idSeed += 1;
			return prefix + Date.now().toString(36) + '-' + idSeed.toString(36);
		}

		const clone = (value) => JSON.parse(JSON.stringify(value));

		/** 与宿主同一套粗估公式：CJK 约 1 字 1 token，其余约 4 字符 1 token。 */
		function estimateTokens(text) {
			if (typeof text !== 'string' || text === '') return 0;
			const cjk = (text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
			let ascii = 0;
			for (const word of text.replace(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g, ' ').split(/\s+/)) ascii += word.length;
			return Math.round(cjk + ascii / 4);
		}

		const ruleChars = (rule) => String(rule.title || '').length + String(rule.content || '').length;
		/** 标签的兜底上限；宿主会在 meta.limits 里下发真值，这里只用于宿主没给时。 */
		const TAG_LIMITS = { count: 8, length: 24 };

		/**
		 * 切分标签输入：`、`/逗号/分号/空白都当分隔符，先截长再去重限量 ——
		 * 顺序反了的话，两条超长标签截断后会变成同一个，去重就漏了。
		 */
		function splitTags(text, limits) {
			const maxCount = limits !== undefined && Number.isFinite(limits.tags) ? limits.tags : TAG_LIMITS.count;
			const maxLength = limits !== undefined && Number.isFinite(limits.tag) ? limits.tag : TAG_LIMITS.length;
			const out = [];
			for (const raw of String(text ?? '').split(/[、,，;；\s]+/)) {
				const tag = raw.trim().slice(0, maxLength);
				if (tag === '' || out.includes(tag)) continue;
				out.push(tag);
				if (out.length >= maxCount) break;
			}
			return out;
		}

		/**
		 * 搜索 / 分组筛选行是否显示：规则少时不堆控件，但**已经生效的筛选条件必须留着控件** ——
		 * 否则规则数掉到 6 条以下时筛选行整行消失、条件却还在过滤，用户既看不到被筛掉的规则，
		 * 也没有任何入口能把条件清掉（此时上移下移还会因为「筛选状态」被禁用）。
		 */
		function shouldShowFilters(totalRules, query, groupFilter) {
			return totalRules > 6 || String(query ?? '').trim() !== '' || String(groupFilter ?? '').trim() !== '';
		}

		/**
		 * Ctrl/Cmd+S 是否真的发起保存：与主动作按钮的 disabled 用同一条判定。
		 * 无改动时保存只会让宿主把「上一版」备份冲成当前版本（.bak 的意义就没了），
		 * 保存进行中再来一次则是两个并发请求写同一份文档。
		 */
		function canShortcutSave(busy, dirty) {
			return busy !== true && dirty === true;
		}

		/**
		 * 响应里的 revision 是不是更新的状态。宿主的 revision 只增不减，所以只认「更前进」
		 * 的：一个在保存之前发出的请求、响应却后到（两个连接上完全可能），照单全收会把
		 * 刚保存的 doc 连同 revision 一起倒回去 —— 下一次保存就会莫名撞上 409。
		 */
		function isNewerRevision(next, current) {
			return Number.isFinite(next) && next > current;
		}

		/**
		 * 面板用的逐条上限快照，由宿主随 /state 下发（meta.limits）—— 面板不复制一份常量，
		 * 免得两边各改各的。宿主没给某项（对象为空 / 值非法）就留 undefined：
		 * maxLength 不设、标签里也不出现「上限」字样。
		 */
		function limitsOf(meta) {
			const raw = meta === null || meta === undefined ? null : meta.limits;
			if (raw === null || raw === undefined || typeof raw !== 'object') {
				return { title: undefined, group: undefined, content: undefined, rules: undefined, tags: undefined, tag: undefined };
			}
			const pick = (key) => (Number.isFinite(raw[key]) && raw[key] > 0 ? raw[key] : undefined);
			return {
				title: pick('title'),
				group: pick('group'),
				content: pick('content'),
				rules: pick('rules'),
				tags: pick('tags'),
				tag: pick('tag'),
			};
		}

		/**
		 * 展示文件路径时把 $DSH_HOME 缩成 `~`：`/home/xxx/.dsh/ian-rules.json` 这种长串
		 * 在窄栏里换行后会被读成两个文件名；缩写之后一行放得下，也更好认。
		 */
		function prettyPath(value, home) {
			const text = String(value ?? '');
			const base = String(home ?? '');
			if (text === '' || base === '' || !text.startsWith(base)) return text;
			const rest = text.slice(base.length);
			if (rest === '') return '~';
			return '~' + (rest.startsWith('/') ? rest : '/' + rest);
		}

		/** 标题与正文都空白的规则会被宿主规范化时直接丢掉，面板不该让它静默消失。 */
		function isBlankRule(rule) {
			return String(rule.title ?? '').trim() === '' && String(rule.content ?? '').trim() === '';
		}

		/**
		 * 卡片上的体量标签。常规只报「约 N 字」；某一栏顶到上限时把上限写出来 ——
		 * 达到 maxLength 之后浏览器什么都不说，这里是不让用户「不知道为什么打不进去」的地方。
		 * 「按场景」的规则不是每轮都注入，所以它的体量要单独标出来，否则「约 N 字」
		 * 会被读成「每轮都增加 N 字」。
		 */
		function sizeLabel(rule, limits) {
			const touched = [];
			if (limits.title !== undefined && String(rule.title ?? '').length >= limits.title) touched.push('标题上限 ' + String(limits.title));
			if (limits.content !== undefined && String(rule.content ?? '').length >= limits.content) touched.push('正文上限 ' + String(limits.content));
			return (
				(rule.mode === 'auto' ? '按场景 · 约 ' : '约 ') +
				String(ruleChars(rule)) +
				' 字' +
				(touched.length === 0 ? '' : '（' + touched.join(' / ') + '）')
			);
		}

		/**
		 * 保存前的本地校验：下面这些内容宿主会在持久化时静默处理掉，必须在面板里先拦下，
		 * 与「项目目录为空」同等对待（切到对应页签 + 说清怎么办）。
		 * 返回 null 表示可以保存，否则返回 { tab, text }。
		 */
		function validateDoc(doc, limits) {
			if (doc.projects.some((project) => String(project.path).trim() === '')) {
				return { tab: 'projects', text: '有一个项目还没填目录，补上或删掉它再保存。' };
			}
			let blank = 0;
			let blankInGlobal = 0;
			for (const rule of doc.global) {
				if (!isBlankRule(rule)) continue;
				blank += 1;
				blankInGlobal += 1;
			}
			let blankProject = null;
			for (const project of doc.projects) {
				for (const rule of project.rules) {
					if (isBlankRule(rule)) {
						blank += 1;
						if (blankProject === null) blankProject = project;
					}
				}
			}
			if (blank > 0) {
				return {
					// 有问题的规则在哪一页就跳到哪一页：每个项目都有自己的页签，
					// 把用户丢到「项目」名册上，他还得自己找是哪个项目出了事。
					tab: blankInGlobal > 0 || blankProject === null ? 'global' : 'p:' + blankProject.id,
					text: '有 ' + String(blank) + ' 条规则的标题和正文都是空的，保存时会被丢掉；请填上或删掉它们再保存。',
				};
			}
			if (limits.rules !== undefined) {
				if (doc.global.length > limits.rules) {
					return {
						tab: 'global',
						text: '全局规则有 ' + String(doc.global.length) + ' 条，超过上限 ' + String(limits.rules) + ' 条；多余的会被丢掉，请先删减再保存。',
					};
				}
				const over = doc.projects.find((project) => project.rules.length > limits.rules);
				if (over !== undefined) {
					return {
						tab: 'p:' + over.id,
						text:
							'项目「' + (over.label || over.path) + '」有 ' + String(over.rules.length) + ' 条规则，超过上限 ' + String(limits.rules) +
							' 条；多余的会被丢掉，请先删减再保存。',
					};
				}
			}
			return null;
		}

		/**
		 * 示例规则：空面板一键插入，改成自己的或直接删掉都行。
		 *
		 * **全部虚构**，不是作者的真实规则内容 —— 本项目是「代码开源 / 规则内容闭源」双轨
		 * （见本仓 NOTICE.md）：作者的规则只存在于其本机的 ~/.dsh/ian-rules.json，不进本仓。
		 */
		const SAMPLE_RULES = [
			{ title: '同一目录内风格保持一致', content: '新增代码先看邻居怎么写，别在局部引入第二套风格。', group: '惯例' },
			{ title: '依赖升级单独提交', content: '升级依赖不要和功能改动混在同一个提交里，回滚时才好切。', group: '依赖' },
			{ title: '配置项集中管理', content: '可调参数集中放一处并写清默认值，别散落在代码各处。', group: '惯例' },
			{ title: '发布前核对版本号与变更日志', content: '打 tag 之前核对版本号，并在变更日志里写下这一版改了什么。', group: '发布' },
		];

		/**
		 * 换过的路由：新客户端 + 旧宿主的过渡窗口。
		 *
		 * 浏览器半体在**页面加载**时就换成新的了，而宿主半体要等重启 profile 才换掉进程里的旧代码 ——
		 * 于是「路由改名」这个动作必然有一段时间是新客户端对着旧宿主说话，面板一片「读取失败：
		 * HTTP 404」。这不是用户该自己扛的事（重启之前面板完全不可用），所以这里只做一件事：
		 * 新路由 404 时，**用旧路由再问一次**，旧路由答得上来就切过去并记住。
		 *
		 * 只在 404 时回退、且要求旧路由确实有响应：路径写错、接口真的不见了这类 404
		 * 不会被误判成「宿主是旧版本」而悄悄换路。
		 */
		/** 当前该往哪个路由发请求。第一次回退成功后一直用它，避免每个请求都先撞一次 404。 */
		const routeState = { route: API };

		/**
		 * 该不该采用某条旧路由那次重试的结果（纯函数，用例钉住「什么情况才回退」）：
		 * 主路由 404、而这条旧路由不是 404 → 回退到它，返回该路由；否则返回 null。
		 */
		function legacyRouteFor(route, status, legacyStatus) {
			if (status !== 404) return null;
			return legacyStatus === 404 ? null : route;
		}

		/**
		 * 取一次接口，带「新路由 404 → 旧路由」的过渡回退。
		 *
		 * `doFetch` 从外面传进来（生产用全局 fetch，用例传假的），因为这里的坑只在**并发**下露面：
		 * 两个请求同时在飞，其中一个先回来把路由切到旧路由，另一个的重试随后成功 —— 此时如果
		 * 按「路由已经切过了」就跳过，这一个请求会拿着自己早先那份 404 继续报错（面板显示
		 * 「读取失败：HTTP 404」，而实际上重试是好的）。所以判定分两件事：**要不要记住切换**
		 * 与 **要不要采用这次重试结果**，后者只看重试成没成功。
		 */
		async function callWithRouteFallback(doFetch, state, path, options) {
			// 判断的依据是**这次实际请求的 URL**，不是「此刻 state 是什么」：并发时另一个请求
			// 可能刚把 state 切到旧路由，而我这一发是切之前发出去的（打在旧宿主上就是 404），
			// 按 state 判断会让我跳过本该做的重试 —— 第一版就是这么写的，用例当场把它揪出来。
			const primary = state.route + path;
			const response = await doFetch(primary, options);
			// 只有 404 才谈得上「宿主是旧版本」：其它失败照旧原样上报，不换路
			if (response.status !== 404) return response;
			for (const route of LEGACY_ROUTES) {
				const legacy = route + path;
				// 这一发本来就打在这个路由上：再重试同一个 URL 只是重复请求，不是回退
				if (legacy === primary) continue;
				const retry = await doFetch(legacy, options);
				const adopted = legacyRouteFor(route, response.status, retry.status);
				if (adopted !== null) {
					state.route = adopted;
					return retry;
				}
			}
			return response;
		}

		async function callApi(path, options) {
			const response = await callWithRouteFallback((url, init) => fetch(url, init), routeState, path, options);
			const text = await response.text();
			let payload = null;
			try {
				payload = text === '' ? null : JSON.parse(text);
			} catch {
				payload = null;
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const detail = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status);
				const error = new Error(detail);
				error.status = response.status;
				error.payload = payload;
				throw error;
			}
			return payload;
		}

		const postJson = (path, body) =>
			callApi(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

		const loadState = () => callApi('/state');
		/** 从磁盘重读（宿主的 POST /reload）：只给用户的显式动作使用，见 load 的说明。 */
		const reloadState = () => postJson('/reload', {});
		const saveState = (doc, revision, applyMode) => postJson('/save', applyMode === undefined ? { doc, revision } : { doc, revision, applyMode });
		const forceSave = (doc) => postJson('/save', { doc });
		const loadPreview = (doc, target) => postJson('/preview', { doc, path: target });
		// 场景模拟器：给一句话，问匹配器「这会命中哪几条」——纯函数套 HTTP 外壳，不改任何状态
		const simulateScene = (path, text) => postJson('/scene', { path, text });
		const loadWorkspaces = () => callApi('/workspaces');
		const exportDoc = (doc) => postJson('/export', { doc });
		const importText = (text) => postJson('/import', { text });

		function downloadText(name, text, type) {
			try {
				const blob = new Blob([text], { type });
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = name;
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			} catch (error) {
				console.error('[ian-rules] 导出失败', error);
			}
		}

		/** 合并导入：按 id + 标题/正文去重，冲突时保留本地已有条目。 */
		function mergeDocs(base, incoming) {
			const merged = clone(base);
			const keyOf = (rule) => String(rule.title || '') + '\u0000' + String(rule.content || '');
			const globalIds = new Set(merged.global.map((rule) => rule.id));
			const globalKeys = new Set(merged.global.map(keyOf));
			for (const rule of incoming.global) {
				const key = keyOf(rule);
				if (globalIds.has(rule.id) || globalKeys.has(key)) continue;
				merged.global.push({ ...rule, id: newId('g') });
				globalIds.add(rule.id);
				globalKeys.add(key);
			}
			for (const project of incoming.projects) {
				let target = merged.projects.find((entry) => entry.path === project.path);
				if (target === undefined) {
					target = { ...project, id: newId('p'), rules: [] };
					merged.projects.push(target);
				}
				const ids = new Set(target.rules.map((rule) => rule.id));
				const keys = new Set(target.rules.map(keyOf));
				for (const rule of project.rules) {
					const key = keyOf(rule);
					if (ids.has(rule.id) || keys.has(key)) continue;
					target.rules.push({ ...rule, id: newId('r') });
					ids.add(rule.id);
					keys.add(key);
				}
			}
			return merged;
		}

		// ------------------------------------------------------ 插件自更新（市场公开 API）

		const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

		/**
		 * 提示里显示的版本号。git 来源时市场给的是 40 位 commit sha，取前 7 位；
		 * 语义化版本（npm 来源）原样用 —— 一律截断会把 1.2.0-beta.1 截成 1.2.0-b。
		 */
		function shortVersion(value) {
			const text = String(value ?? '').trim();
			return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7) : text;
		}

		/**
		 * 操作是否已经结束。只认契约里的两个进行中状态：**不认识的状态一律当结束** ——
		 * 遇到没见过的状态还接着按 1.5 秒一轮问下去，会把市场问成永动机。
		 */
		function isOperationTerminal(operation) {
			if (!isObject(operation)) return true;
			return operation.state !== 'queued' && operation.state !== 'running';
		}

		/** 更新中按钮上的文案：市场给了百分比就带上，给了越界值也只显示 0~100。 */
		function updatingLabel(operation) {
			const percent = isObject(operation) && isObject(operation.progress) ? operation.progress.percent : undefined;
			if (typeof percent !== 'number' || !Number.isFinite(percent)) return '更新中…';
			return '更新中… ' + String(Math.min(100, Math.max(0, Math.round(percent)))) + '%';
		}

		/**
		 * 能力探测的结果收敛成面板真正会用的两个开关。探测不到（没装市场、请求失败、
		 * 响应不是本契约的 schema、能力位说不能更新）一律 null —— 按契约整块不渲染，
		 * 「更多」里也不留死按钮。
		 */
		function capabilitiesOf(payload) {
			if (!isObject(payload) || payload.schema !== MARKET_SCHEMA) return null;
			const features = isObject(payload.features) ? payload.features : {};
			if (features.update !== true) return null;
			const restart = isObject(payload.restart) ? payload.restart : {};
			return { rollback: features.rollback === true, restart: restart.supported === true };
		}

		const updateStatusOf = (payload) => (isObject(payload) && isObject(payload.package) ? payload.package : null);
		const operationOf = (payload) => (isObject(payload) && isObject(payload.operation) ? payload.operation : null);

		/**
		 * 从市场响应体里取它写给用户的那句话：契约的顶层 error，以及实测里市场自己的重启
		 * 路由把原因包在 result 里那一种。取到就照它的原文说，不自造原因。
		 */
		function marketErrorText(payload) {
			if (!isObject(payload)) return null;
			if (typeof payload.error === 'string' && payload.error !== '') return payload.error;
			if (isObject(payload.result) && typeof payload.result.error === 'string' && payload.result.error !== '') return payload.result.error;
			return null;
		}

		/**
		 * 把一次失败的请求收敛成 updateNotice 认得的那种「失败操作」。
		 * 市场给了 failure 就原样采信它的文案与 retryable；只有市场没给（网络层失败、
		 * 只回了 error、连响应体都没有）才用面板的兜底文案 —— 此时「重试」算不算同一个
		 * 动作由调用方定：发起更新可以重试，重启 / 回滚不行。
		 */
		function failedOperation(payload, fallbackMessage, fallbackRetryable) {
			const failure = isObject(payload) && isObject(payload.failure) ? payload.failure : null;
			if (failure !== null && typeof failure.message === 'string' && failure.message !== '') {
				return { state: 'failed', failure: { message: failure.message, retryable: failure.retryable === true } };
			}
			const message = marketErrorText(payload) ?? fallbackMessage;
			if (typeof message !== 'string' || message === '') return null;
			return { state: 'failed', failure: { message, retryable: fallbackRetryable === true } };
		}

		/**
		 * 请求失败时的兜底文案。得分得清「根本没发出去」和「被市场拒了」：后者市场已经收到，
		 * 说成没发出去会把排查方向带偏。
		 */
		function failureMessage(cause, action) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			const status = isObject(cause) && typeof cause.status === 'number' ? cause.status : null;
			if (status === null) return '没能连上插件市场，' + action + '没有执行：' + detail;
			const prefix = '插件市场拒绝了这次' + action + '（HTTP ' + String(status) + '）';
			return detail === 'HTTP ' + String(status) ? prefix + '。' : prefix + '：' + detail;
		}

		/**
		 * 顶部那条更新提示的全部内容：显不显示、显示什么、给哪些按钮。
		 * 组件的分支在 Node 里跑不到（react 桩的 createElement 返回 null），判定必须在这里。
		 * capabilities 为 null（市场探测不到）整块不渲染；没有更新、也没在更新、也没刚失败
		 * 时返回 null —— 这条提示绝不常驻。
		 */
		function updateNotice(status, operation, capabilities) {
			if (capabilities === null || capabilities === undefined) return null;
			if (isObject(operation)) {
				if (!isOperationTerminal(operation)) {
					return { tone: 'busy', text: '', buttons: [{ id: 'update', label: updatingLabel(operation), disabled: true }] };
				}
				if (operation.state === 'succeeded' || operation.state === 'rolled-back') {
					const outcome = isObject(operation.outcome) ? operation.outcome : {};
					// 既不用重启也不用刷新＝这次改动当场就生效了，没有要用户做的事
					if (outcome.restartRequired !== true && outcome.refreshRequired !== true) return null;
					const version = shortVersion(operation.installedVersion ?? operation.beforeVersion);
					const done = operation.state === 'rolled-back' ? '已回滚到 ' : '已更新到 ';
					const buttons = [];
					if (capabilities.restart === true) buttons.push({ id: 'restart', label: '重启 profile', variant: 'primary' });
					return {
						tone: 'ok',
						text: (version === '' ? '本插件已更新' : done + version) + '，重启 profile 后生效。',
						buttons,
					};
				}
				if (operation.state === 'failed') {
					const failure = isObject(operation.failure) ? operation.failure : {};
					// 市场给的文案是照用户写的，原样展示，面板不改写也不翻译
					const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '更新失败，插件市场没有给出原因。';
					const buttons = [];
					if (failure.retryable === true) buttons.push({ id: 'retry', label: '重试' });
					const rollback = isObject(operation.outcome) && isObject(operation.outcome.rollback) ? operation.outcome.rollback : {};
					if (rollback.available === true && capabilities.rollback === true && typeof operation.operationId === 'string') {
						buttons.push({ id: 'rollback', label: '回滚' });
					}
					return { tone: 'error', text: message, buttons };
				}
				// cancelled 之类没有可看内容的终态：落回「有没有新版本」那条路，把更新按钮还给用户
			}
			if (!isObject(status) || status.updateAvailable !== true) return null;
			return {
				tone: 'update',
				text: '本插件有新版本：' + shortVersion(status.installedVersion) + ' → ' + shortVersion(status.latestVersion),
				buttons: [{ id: 'update', label: '更新' }],
			};
		}

		/**
		 * 市场接口的取用。响应体是本契约的 `{ schema, … }`，没有宿主那套 `ok` 字段，
		 * 所以不复用 callApi；非 2xx 一律抛带 payload 的错，让调用方决定「当没有更新」
		 * 还是「把市场给的 failure 摆出来」。
		 */
		async function fetchMarket(path, options) {
			const response = await fetch(MARKET_API + path, options);
			const raw = await response.text();
			let payload = null;
			try {
				payload = raw === '' ? null : JSON.parse(raw);
			} catch {
				payload = null;
			}
			if (!response.ok) {
				// 市场自己给的话（契约的 error / 实测重启路由的 result.error）优先于面板的 HTTP 文案
				const detail = marketErrorText(payload) ?? 'HTTP ' + String(response.status);
				const error = new Error(detail);
				error.status = response.status;
				error.payload = payload;
				throw error;
			}
			return payload;
		}

		const marketPost = (path, body) =>
			fetchMarket(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

		const probeMarket = async () => capabilitiesOf(await fetchMarket('/capabilities'));
		/** 只有用户主动点「检查更新」才跳过市场 30 分钟的检查缓存。 */
		const requestUpdateCheck = async (force) =>
			updateStatusOf(await fetchMarket('/updates?name=' + encodeURIComponent(PACKAGE_NAME) + (force === true ? '&force=1' : '')));
		const requestUpdate = async () => operationOf(await marketPost('/updates', { packageName: PACKAGE_NAME }));
		const requestOperation = async (operationId) => operationOf(await fetchMarket('/operations?operationId=' + encodeURIComponent(operationId)));
		const requestRollback = async (operationId) => operationOf(await marketPost('/rollback', { operationId }));
		const requestRestart = () => marketPost('/restart', {});

		// ---------------------------------------------------------------- UI 小件

		function IconRules(props) {
			const size = typeof props?.size === 'number' ? props.size : 16;
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
				h('path', { d: 'M4 2.4h5.4L12.6 5.6v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z', key: 'doc' }),
				h('path', { d: 'M9.2 2.6v3.2h3.2', key: 'fold' }),
				h('path', { d: 'M5.4 8.6h5.2', key: 'l1' }),
				h('path', { d: 'M5.4 11h3.4', key: 'l2' }),
			);
		}

		function Button(props) {
			const variants =
				props.variant === 'primary'
					? ' ar_btnPrimary'
					: props.variant === 'danger'
						? ' ar_btnDanger'
						: props.variant === 'quiet'
							? ' ar_btnQuiet'
							: '';
			return h(
				'button',
				{
					type: 'button',
					className: 'ar_btn' + variants + (props.block === true ? ' ar_btnBlock' : ''),
					disabled: props.disabled === true,
					title: props.title ?? '',
					onClick: (event) => {
						event.stopPropagation();
						if (props.disabled === true) return;
						props.onClick();
					},
				},
				props.children,
			);
		}

		function IconButton(props) {
			return h(
				'button',
				{
					type: 'button',
					className: 'ar_iconBtn' + (props.danger === true ? ' ar_iconBtnDanger' : ''),
					disabled: props.disabled === true,
					title: props.title,
					'aria-label': props.title,
					onClick: (event) => {
						event.stopPropagation();
						if (props.disabled === true) return;
						props.onClick();
					},
				},
				props.children,
			);
		}

		/** 二次确认删除：第一次点变「确认删除」，3 秒后自动还原。 */
		function ConfirmButton(props) {
			const [armed, setArmed] = useState(false);
			useEffect(() => {
				if (!armed) return undefined;
				const timer = setTimeout(() => setArmed(false), 3000);
				return () => clearTimeout(timer);
			}, [armed]);
			if (!armed) {
				return h(
					IconButton,
					{ title: props.title ?? '删除（点两次确认）', danger: true, onClick: () => setArmed(true) },
					'✕',
				);
			}
			return h(
				'button',
				{
					type: 'button',
					className: 'ar_confirmBtn',
					onClick: (event) => {
						event.stopPropagation();
						setArmed(false);
						props.onConfirm();
					},
				},
				props.confirmLabel ?? '确认删除',
			);
		}

		function Check(props) {
			return h(
				'label',
				{ className: 'ar_check', title: props.title ?? '' },
				h('input', {
					type: 'checkbox',
					checked: props.checked === true,
					onChange: (event) => props.onChange(event.target.checked),
				}),
				props.children,
			);
		}

		function Message(props) {
			if (props.text === '') return null;
			return h('div', { className: 'ar_msg', 'data-kind': props.kind }, props.text);
		}

		function Hint(props) {
			return h('div', { className: 'ar_hint' }, props.children);
		}

		/**
		 * 吸顶区里的更新条：内容全部来自 updateNotice，这里只负责画。
		 * 主面板只在 notice 非 null 时才渲染它，所以「绝不常驻」这条由那一层保证。
		 */
		function UpdateBar(props) {
			const notice = props.notice;
			return h(
				'div',
				{ className: 'ar_update', 'data-tone': notice.tone },
				notice.text === '' ? null : h('span', { className: 'ar_updateText' }, notice.text),
				notice.buttons.map((button) =>
					h(
						Button,
						{
							key: button.id,
							variant: button.variant,
							disabled: button.disabled === true,
							onClick: () => props.onAction(button.id),
						},
						button.label,
					),
				),
			);
		}

		/**
		 * 面板错误边界：槽位条目渲染抛错会被宿主标记为 abdicated（整块面板消失），
		 * 这里兜住并把错误原文显示在面板位置，避免「点了没反应」这种无法诊断的空白。
		 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error) {
				try {
					console.error('[ian-rules] panel render failed', error);
				} catch (ignored) {
					/* 控制台不可用时忽略 */
				}
			}
			render() {
				if (this.state.error !== null && this.state.error !== undefined) {
					const detail = String((this.state.error && this.state.error.stack) || this.state.error);
					return h(
						'div',
						{ className: 'ar_panel' },
						h('div', { className: 'ar_title' }, '开发规则面板渲染失败'),
						h(Hint, null, '把下面这段发给 DSH 即可定位；规则文件不受影响。'),
						h('pre', { className: 'ar_preview' }, detail),
						h(
							'div',
							{ className: 'ar_row' },
							h('button', { type: 'button', className: 'ar_btn', onClick: () => this.setState({ error: null }) }, '重试渲染'),
						),
					);
				}
				return this.props.children;
			}
		}

		// ------------------------------------------------------------ 规则编辑区

		function RuleRow(props) {
			const rule = props.rule;
			const limits = props.limits ?? {};
			const off = rule.enabled === false;
			/**
			 * 标签输入框保留「正在输入的原文」：每次按键都规范化会把刚敲下的那个分隔符
			 * 吃掉，于是第二个标签永远打不进去。真正落库的仍是规范化后的数组。
			 */
			const [tagText, setTagText] = useState(null);
			useEffect(() => {
				setTagText(null);
			}, [rule.id]);
			const tagsValue = typeof tagText === 'string' ? tagText : Array.isArray(rule.tags) ? rule.tags.join('、') : '';
			return h(
				'div',
				{ className: 'ar_card', 'data-off': off ? '1' : undefined },
				h(
					'div',
					{ className: 'ar_cardHead' },
					h('span', { className: 'ar_cardIndex' }, String(props.position)),
					h('input', {
						className: 'ar_input ar_titleInput',
						value: rule.title,
						maxLength: limits.title,
						placeholder: '一句话说明这条规则，例如：提交前跑测试',
						onChange: (event) => props.onPatch({ title: event.target.value }),
					}),
					// 停用态只把「不生效」说清楚，不再把整张卡压暗：右侧的「生效」勾选框
					// 正是用户要用来重新启用的控件，跟着一起变淡就点不到了。
					off ? h('span', { className: 'ar_offChip' }, '已停用') : null,
				),
				h('textarea', {
					className: 'ar_textarea',
					value: rule.content,
					maxLength: limits.content,
					rows: Math.min(12, Math.max(2, String(rule.content).split('\n').length + 1)),
					placeholder: '具体怎么做，例如：改完代码跑一次 npm test，绿灯再提交。',
					onChange: (event) => props.onPatch({ content: event.target.value }),
				}),
				h(
					'div',
					{ className: 'ar_cardFoot' },
					h('input', {
						className: 'ar_input ar_groupInput',
						list: 'ar-groups',
						value: rule.group ?? '',
						maxLength: limits.group,
						placeholder: '分组（可选）',
						title: '分组只影响展示与提示里的小标题，不影响是否生效',
						onChange: (event) => props.onPatch({ group: event.target.value }),
					}),
					h('input', {
						className: 'ar_input ar_tagInput',
						list: 'ar-tags',
						value: tagsValue,
						placeholder: '标签（可选）',
						title: '标签只给「按场景」用：命中标签的对话才会收到这条规则。用「、」分隔，最多 ' + String(TAG_LIMITS.count) + ' 个',
						onChange: (event) => {
							setTagText(event.target.value);
							props.onPatch({ tags: splitTags(event.target.value, limits) });
						},
					}),
					h(Check, { checked: rule.enabled !== false, onChange: (value) => props.onPatch({ enabled: value }), title: '取消勾选后保留内容但不再生效' }, '生效'),
					h(
						Check,
						{
							checked: rule.mode === 'auto',
							onChange: (value) => props.onPatch({ mode: value ? 'auto' : 'always' }),
							title: '勾上＝按场景注入：只有和这条规则相关（命中标题 / 标签）的对话才会收到它；不勾＝常驻，每个相关会话每轮都带着它',
						},
						'按场景',
					),
					h(
						'span',
						{ className: 'ar_size', title: rule.mode === 'auto' ? '命中时给对话增加的大致上下文量' : '这条规则给每次对话增加的大致上下文量' },
						sizeLabel(rule, limits),
					),
					h(
						'span',
						{ className: 'ar_cardTools' },
						h(IconButton, { title: props.reorderHint, disabled: props.canUp === false, onClick: () => props.onMove(-1) }, '↑'),
						h(IconButton, { title: props.reorderHint, disabled: props.canDown === false, onClick: () => props.onMove(1) }, '↓'),
						h(ConfirmButton, { title: '删除这条规则（点两次确认）', onConfirm: props.onRemove }),
					),
				),
			);
		}

		/** 一条规则是否命中搜索 / 分组筛选（纯展示过滤，与是否生效无关）。 */
		function matchesFilter(rule, query, groupFilter) {
			if (groupFilter === '__none__' && String(rule.group ?? '') !== '') return false;
			if (groupFilter !== '' && groupFilter !== '__none__' && String(rule.group ?? '') !== groupFilter) return false;
			if (query === '') return true;
			return (
				String(rule.title ?? '').toLowerCase().includes(query) ||
				String(rule.content ?? '').toLowerCase().includes(query) ||
				String(rule.group ?? '').toLowerCase().includes(query) ||
				(Array.isArray(rule.tags) ? rule.tags.join(' ').toLowerCase().includes(query) : false)
			);
		}

		/**
		 * 按用户分组归拢规则：组名按**首次出现**排序，返回 `[{ group, items: [{ rule, index }] }]`
		 * （`group === ''` 是未分组那一桶）。
		 *
		 * 与注入文本（rules.js 的 renderRuleList）用**同一套**归拢顺序 —— 面板上看到的二级
		 * 分组，就是 agent 读到的那个二级标题；两边不一致会让人以为规则丢了或跑到了别处。
		 */
		function groupBuckets(rules) {
			const order = [];
			const buckets = new Map();
			rules.forEach((rule, index) => {
				const group = String(rule.group ?? '');
				if (!buckets.has(group)) {
					buckets.set(group, []);
					order.push(group);
				}
				buckets.get(group).push({ rule, index });
			});
			return order.map((group) => ({ group, items: buckets.get(group) }));
		}

		function RuleList(props) {
			const rules = props.rules;
			const limits = props.limits ?? {};
			const query = String(props.query ?? '').trim().toLowerCase();
			const groupFilter = props.groupFilter ?? '';
			const filtering = query !== '' || groupFilter !== '';
			// 到上限就别再堆卡片了：宿主保存时会把多出来的丢掉，save 那里也会拦
			const atCap = limits.rules !== undefined && rules.length >= limits.rules;
			// 先归组、再筛：筛选不该打乱分组。序号取自**未筛选**的展示顺序，
			// 于是筛掉几条之后剩下的编号还是原来那些号，不会整体重排。
			const allBuckets = groupBuckets(rules);
			const positionOf = new Map();
			/**
			 * 每条规则在**自己那一组**里的位次：↑↓ 只在本组内换位。
			 *
			 * 为什么不做「跨组上下移」：注入文本里同一组内部的先后由这里的顺序决定，
			 * 而**组与组之间的先后**由「这个组第一次出现的位置」决定 —— 想跨组移动一条
			 * 规则，得先把别的规则挪走，点了多半看不出变化。做不到就禁用按钮，
			 * 比让用户点一下、卡片纹丝不动要好。
			 */
			const withinBucket = new Map();
			let counter = 0;
			for (const bucket of allBuckets) {
				bucket.items.forEach((item, at) => {
					counter += 1;
					positionOf.set(item.index, counter);
					withinBucket.set(item.index, { at, total: bucket.items.length });
				});
			}
			const buckets = allBuckets
				.map((bucket) => ({
					group: bucket.group,
					items: bucket.items.filter(({ rule }) => matchesFilter(rule, query, groupFilter)),
				}))
				.filter((bucket) => bucket.items.length > 0);
			const visible = buckets.flatMap((bucket) => bucket.items);
			// 只有文档里真的存在具名分组时才出二级标题：全是未分组还硬摆一个「未分组」是噪音
			const showGroupHeads = rules.some((rule) => String(rule.group ?? '') !== '') || buckets.some((bucket) => bucket.group !== '');

			const patch = (index, changes) => {
				const next = clone(rules);
				next[index] = Object.assign({}, next[index], changes);
				props.onChange(next);
			};
			/**
			 * 上移 / 下移：只与本组内相邻的那条交换数组位置。
			 * 交换（而不是「抽出来再插进去」）能保住别的规则的相对次序，
			 * 组的出现顺序也因此不会因为一次误点而整体洗牌。
			 */
			const move = (index, delta) => {
				const owner = allBuckets.find((bucket) => bucket.items.some((item) => item.index === index));
				const where = withinBucket.get(index);
				if (owner === undefined || where === undefined) return;
				const neighbour = owner.items[where.at + delta];
				if (neighbour === undefined) return;
				const next = clone(rules);
				const swap = next[index];
				next[index] = next[neighbour.index];
				next[neighbour.index] = swap;
				props.onChange(next);
			};
			const remove = (index) => {
				const next = clone(rules);
				next.splice(index, 1);
				props.onChange(next);
			};
			const addRule = () => {
				props.onChange(
					rules.concat([
						{
							id: newId(props.idPrefix ?? 'r'),
							title: '',
							content: '',
							group: groupFilter !== '' && groupFilter !== '__none__' ? groupFilter : '',
							enabled: true,
						},
					]),
				);
			};
			const addButton = h(
				'div',
				{ className: 'ar_row' },
				h(
					Button,
					{
						variant: 'quiet',
						onClick: addRule,
						disabled: atCap,
						title: atCap ? '已达每条规则集上限 ' + String(limits.rules) + ' 条' : '',
					},
					'+ 加一条规则',
				),
			);

			if (rules.length === 0) {
				return h(
					'div',
					{ className: 'ar_section' },
					props.emptyText === undefined ? null : h('div', { className: 'ar_empty' }, props.emptyText),
					addButton,
				);
			}

			return h(
				'div',
				{ className: 'ar_section' },
				visible.length === 0
					? h('div', { className: 'ar_empty' }, '没有符合条件的规则。清空上面的搜索框或把分组切回「全部分组」。')
					: buckets.map((bucket) =>
							h(
								'div',
								{ className: 'ar_group', key: bucket.group === '' ? '__ungrouped__' : bucket.group },
								showGroupHeads
									? h(
											'div',
											{ className: 'ar_groupHead' },
											h('span', { className: 'ar_groupName' }, bucket.group === '' ? '未分组' : bucket.group),
											h('span', { className: 'ar_groupCount' }, String(bucket.items.length) + ' 条'),
										)
									: null,
								h(
									'div',
									{ className: 'ar_rulesGrid' },
									bucket.items.map(({ rule, index }) =>
										h(RuleRow, {
											key: rule.id,
											rule,
											limits,
											index,
											position: positionOf.get(index) ?? index + 1,
											canUp: !filtering && (withinBucket.get(index)?.at ?? 0) > 0,
											canDown: !filtering && (withinBucket.get(index)?.at ?? 0) < (withinBucket.get(index)?.total ?? 1) - 1,
											reorderHint: filtering
												? '筛选状态下不能改顺序'
												: showGroupHeads
													? '在同一组内调整顺序（组与组之间的先后由组第一次出现的位置决定）'
													: '调整顺序',
											onPatch: (changes) => patch(index, changes),
											onMove: (delta) => move(index, delta),
											onRemove: () => remove(index),
										}),
									),
								),
							),
						),
				addButton,
			);
		}

		// ------------------------------------------------------------- 三个页签

		function GlobalTab(props) {
			return h(
				'div',
				{ className: 'ar_section' },
				h(Hint, null, '这里放「做什么项目都适用」的规则。'),
				h(RuleList, {
					rules: props.doc.global,
					idPrefix: 'g',
					limits: props.limits,
					query: props.query,
					groupFilter: props.groupFilter,
					onChange: (rules) => props.mutate((draft) => { draft.global = rules; }),
				}),
			);
		}

		/**
		 * 页签上显示的项目名：有别名用别名，否则取目录最后一段，都没有就叫「新项目」。
		 * 与注入文本第一级标题（`## 项目：别名（路径）`）取的是同一个身份，便于两边对照。
		 */
		function projectTabLabel(project) {
			const label = String(project.label ?? '').trim();
			if (label !== '') return label;
			const tail = String(project.path ?? '')
				.replace(/[\\/]+$/, '')
				.split(/[\\/]/)
				.filter(Boolean)
				.pop();
			return tail === undefined || tail === '' ? '新项目' : tail;
		}

		/**
		 * 页签列表（3 + N）：全局规则 / 项目名册 / **每个项目一页** / 效果预览。
		 * 每个项目的规则有自己的页，是这次改版的核心 —— 项目一多，把它们的规则全塞在
		 * 同一个页签里，读者就得在几个大卡片之间反复上下找。
		 */
		function panelTabs(doc) {
			return [
				{ key: 'global', label: '全局规则', count: doc.global.length },
				{ key: 'projects', label: '项目', count: doc.projects.length },
				...doc.projects.map((project) => ({ key: 'p:' + project.id, label: projectTabLabel(project), count: project.rules.length })),
				{ key: 'preview', label: '效果预览', count: null },
			];
		}

		/** 文档里出现过的分组名，按首次出现排序（去重）。 */
		function collectGroups(rules) {
			const names = [];
			for (const rule of rules) {
				const name = String(rule.group ?? '');
				if (name !== '' && names.indexOf(name) < 0) names.push(name);
			}
			return names;
		}

		/** 文档里出现过的标签，按首次出现排序（去重）——给标签输入框做自动补全。 */
		function collectTags(rules) {
			const tags = [];
			for (const rule of rules) {
				if (!Array.isArray(rule.tags)) continue;
				for (const tag of rule.tags) {
					const name = String(tag ?? '');
					if (name !== '' && tags.indexOf(name) < 0) tags.push(name);
				}
			}
			return tags;
		}

		/**
		 * 「项目」页＝项目名册：每个项目的**身份字段**只在这一处可改（目录 / 别名 /
		 * 与全局的关系 / 启用），规则本身各自在自己的页签里编辑。同名控件出现在两处，
		 * 读者就得自己判断哪个说了算 —— 这里不让它出现。
		 */
		function ProjectsTab(props) {
			const projects = props.doc.projects;
			const patchProject = (index, changes) => {
				props.mutate((draft) => {
					draft.projects[index] = Object.assign({}, draft.projects[index], changes);
				});
			};
			const removeProject = (index) => {
				props.mutate((draft) => {
					draft.projects.splice(index, 1);
				});
			};
			const addProject = () => {
				const id = newId('p');
				props.mutate((draft) => {
					draft.projects.push({ id, path: '', label: '', enabled: true, mode: 'append', rules: [] });
				});
				// 刚建完的项目一定是空的，直接落到它的规则页，省一次「它跑哪去了」的寻找
				props.onOpenProject(id);
			};
			return h(
				'div',
				{ className: 'ar_section' },
				h(Hint, null, '给某个项目单独加规则。会话的工作目录在那个目录下面就会用上；同时命中多个时，用范围更小的那个。每个项目在页签栏里都有自己的规则页。'),
				projects.length === 0
					? h('div', { className: 'ar_empty' }, '还没有项目规则。一般先用「全局规则」就够了，确实需要区别对待时再加。')
					: projects.map((project, index) =>
							h(
								'div',
								{ className: 'ar_card ar_projectCard', key: project.id },
								h(
									'div',
									{ className: 'ar_cardHead' },
									h('span', { className: 'ar_projectBadge' }, '项目 ' + String(index + 1)),
									h('span', { className: 'ar_projectName' }, projectTabLabel(project)),
									h(Check, { checked: project.enabled !== false, onChange: (value) => patchProject(index, { enabled: value }), title: '取消勾选后这个项目的规则不生效' }, '启用'),
									h(
										'span',
										{ className: 'ar_cardTools' },
										h(
											Button,
											{ variant: 'quiet', onClick: () => props.onOpenProject(project.id) },
											'编辑规则 ' + String(project.rules.length) + ' 条 →',
										),
										h(ConfirmButton, {
											title: '删除这个项目（点两次确认）',
											confirmLabel: '确认删除项目',
											onConfirm: () => removeProject(index),
										}),
									),
								),
								h(
									'label',
									{ className: 'ar_field' },
									h('span', { className: 'ar_fieldLabel' }, '项目目录'),
									h('input', {
										className: 'ar_input ar_pathInput',
										list: 'ar-workspaces',
										value: project.path,
										placeholder: '从下拉选一个工作区，或粘贴绝对路径',
										onChange: (event) => patchProject(index, { path: event.target.value }),
									}),
									h('span', { className: 'ar_fieldHint' }, '该目录（含子目录）下的会话会命中这套规则。'),
								),
								h(
									'div',
									{ className: 'ar_projectRow' },
									h(
										'label',
										{ className: 'ar_field' },
										h('span', { className: 'ar_fieldLabel' }, '别名（可选）'),
										h('input', {
											className: 'ar_input ar_labelInput',
											value: project.label ?? '',
											maxLength: props.limits.title,
											placeholder: '方便自己认，例如：博客',
											onChange: (event) => patchProject(index, { label: event.target.value }),
										}),
									),
									h(
										'label',
										{ className: 'ar_field' },
										h('span', { className: 'ar_fieldLabel' }, '和全局规则的关系'),
										h(
											'select',
											{
												className: 'ar_select',
												value: project.mode,
												onChange: (event) => patchProject(index, { mode: event.target.value }),
											},
											h('option', { value: 'append' }, '全局规则 + 本项目规则'),
											h('option', { value: 'override' }, '只用本项目规则'),
										),
										h('span', { className: 'ar_fieldHint' }, project.mode === 'override' ? '全局规则在这个项目里完全不生效。' : '本项目规则追加在全局规则后面。'),
									),
								),
							),
						),
				h(
					'div',
					{ className: 'ar_row' },
					h(Button, { variant: 'quiet', onClick: addProject }, '+ 加一个项目'),
				),
			);
		}

		/**
		 * 单个项目的规则页：顶部一条**只读**身份栏（名字 / 目录 / 与全局的关系），
		 * 下面按用户分组摆规则卡片。要改身份就去「项目」页 —— 那里是唯一的编辑入口。
		 */
		function ProjectRulesTab(props) {
			const project = props.project;
			if (project === undefined) return null;
			return h(
				'div',
				{ className: 'ar_section' },
				h(
					'div',
					{ className: 'ar_identity' },
					h(
						'div',
						{ className: 'ar_identityMain' },
						h('span', { className: 'ar_identityName' }, projectTabLabel(project)),
						h('span', { className: 'ar_chip' }, project.mode === 'override' ? '只用本项目规则' : '全局 + 本项目'),
						project.enabled === false ? h('span', { className: 'ar_chip' }, '已停用') : null,
					),
					h('div', { className: 'ar_identityPath' }, String(project.path).trim() === '' ? '（还没填目录）' : project.path),
					h(
						'div',
						{ className: 'ar_identityFoot' },
						h('span', { className: 'ar_fieldHint' }, project.mode === 'override' ? '这个目录下只注入本项目的规则，全局规则完全不生效。' : '本项目规则追加在全局规则后面一起注入。'),
						h(Button, { variant: 'quiet', onClick: props.onOpenRoster }, '改目录 / 别名 / 关系 →'),
					),
				),
				h(RuleList, {
					rules: project.rules,
					idPrefix: 'r',
					limits: props.limits,
					query: props.query,
					groupFilter: props.groupFilter,
					emptyText: '这个项目还没有规则。在下面加一条，或先到「全局规则」里写通用的那部分。',
					onChange: props.onChangeRules,
				}),
			);
		}

		function PreviewTab(props) {
			const [target, setTarget] = useState(props.initialPath ?? '');
			const [result, setResult] = useState(null);
			const [error, setError] = useState('');
			const [busy, setBusy] = useState(false);
			/** 场景模拟器的输入 / 结果：和上面的目录预览互不影响，各自一份状态。 */
			const [sceneText, setSceneText] = useState('');
			const [scene, setScene] = useState(null);
			const [sceneBusy, setSceneBusy] = useState(false);
			const [sceneError, setSceneError] = useState('');
			/** 只认最后一次请求的结果：doc 一变就重新拉预览，旧响应可能后到并盖掉新的。 */
			const seqRef = useRef(0);

			const refresh = useCallback(
				async (path) => {
					seqRef.current += 1;
					const seq = seqRef.current;
					setBusy(true);
					setError('');
					try {
						const payload = await loadPreview(props.doc, path);
						if (seq !== seqRef.current) return;
						setResult(payload);
					} catch (cause) {
						if (seq !== seqRef.current) return;
						setError(cause instanceof Error ? cause.message : String(cause));
						setResult(null);
					} finally {
						// 过期请求不许把「读取中」的状态清掉，它后面还有更新的那次
						if (seq === seqRef.current) setBusy(false);
					}
				},
				[props.doc],
			);

			useEffect(() => {
				refresh(target);
			}, [refresh]);

			const runScene = async () => {
				if (sceneText.trim() === '') return;
				setSceneBusy(true);
				setSceneError('');
				try {
					setScene(await simulateScene(target, sceneText));
				} catch (cause) {
					setSceneError(cause instanceof Error ? cause.message : String(cause));
					setScene(null);
				} finally {
					setSceneBusy(false);
				}
			};

			const biggest = result === null || !Array.isArray(result.rules) ? [] : result.rules.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5);
			const sceneIndex = result === null || !Array.isArray(result.sceneIndex) ? [] : result.sceneIndex;
			return h(
				'div',
				{ className: 'ar_section' },
				h(Hint, null, '选一个目录，看看那里的会话实际会收到什么。留空则按本机当前目录算。'),
				h(
					'div',
					{ className: 'ar_row' },
					h('input', {
						className: 'ar_input ar_pathInput',
						list: 'ar-workspaces',
						value: target,
						placeholder: '项目目录，例如 ~/项目/xxx',
						onChange: (event) => setTarget(event.target.value),
					}),
				),
				h(
					'div',
					{ className: 'ar_row' },
					h(Button, { onClick: () => refresh(target), disabled: busy }, busy ? '读取中…' : '查看'),
					result !== null && result.text !== ''
						? h(
								Button,
								{
									onClick: () =>
										downloadText(
											'生效规则-' + (target === '' ? '全局' : String(target).split('/').filter(Boolean).pop() || '项目') + '.md',
											result.text,
											'text/markdown;charset=utf-8',
										),
								},
								'把这段导出 md',
							)
						: null,
				),
				error !== '' ? h(Message, { kind: 'error', text: error }) : null,
				result !== null
					? h(
							'div',
							{ className: 'ar_summary' },
							resultSummary(result).map((line, index) => h('div', { className: 'ar_summaryLine', key: String(index) }, line)),
						)
					: null,
				biggest.length > 0
					? h(
							'div',
							{ className: 'ar_sizeList' },
							h('span', { className: 'ar_fieldLabel' }, '最占上下文的几条：'),
							biggest.map((rule) =>
								h('span', { className: 'ar_sizeChip', key: rule.id, title: rule.title }, (rule.title || '(无标题)') + ' · ' + String(rule.tokens) + ' token'),
							),
						)
					: null,
				sceneIndex.length > 0
					? h(
							'div',
							{ className: 'ar_sizeList' },
							h(
								'span',
								{ className: 'ar_fieldLabel' },
								result.sceneMatching
									? '设为「按场景」的 ' + String(sceneIndex.length) + ' 条（这里只列目录，全文按场景取）：'
									: '设为「按场景」的 ' + String(sceneIndex.length) + ' 条（按场景注入还没开，现在它们仍按常驻注入）：',
							),
							sceneIndex.map((rule) =>
								h(
									'span',
									{ className: 'ar_sizeChip', key: rule.id, title: rule.title },
									(rule.title || '(无标题)') + (Array.isArray(rule.tags) && rule.tags.length > 0 ? ' · ' + rule.tags.join('、') : ''),
								),
							),
						)
					: null,
				h(
					'div',
					{ className: 'ar_section ar_sceneBox' },
					h('div', { className: 'ar_fieldLabel' }, '场景模拟：这句话会命中哪几条「按场景」规则？'),
					h(
						'div',
						{ className: 'ar_row' },
						h('input', {
							className: 'ar_input ar_pathInput',
							value: sceneText,
							placeholder: '例如：把依赖升级到最新版',
							onChange: (event) => setSceneText(event.target.value),
						}),
						h(Button, { onClick: runScene, disabled: sceneBusy || sceneText.trim() === '' }, sceneBusy ? '匹配中…' : '试试'),
					),
					sceneError !== '' ? h(Message, { kind: 'error', text: sceneError }) : null,
					scene === null
						? h(Hint, null, '匹配按「先看标签、再看标题、最后看正文」打分，低于阈值就不注入 —— 这里能看见每一条为什么进 / 没进。')
						: h(
								'div',
								{ className: 'ar_summary' },
								h('div', { className: 'ar_summaryLine' }, resultSummaryOfScene(scene)),
								scene.matched.length > 0
									? h(
											'div',
											{ className: 'ar_sizeList' },
											h('span', { className: 'ar_fieldLabel' }, '命中：'),
											scene.matched.map((entry) =>
												h('span', { className: 'ar_sizeChip', key: entry.id, title: entry.title }, (entry.title || '(无标题)') + ' · ' + String(entry.score)),
											),
										)
									: null,
								scene.near.length > 0
									? h(
											'div',
											{ className: 'ar_sizeList' },
											h('span', { className: 'ar_fieldLabel' }, '差一点命中（没到阈值 ' + String(scene.threshold) + '）：'),
											scene.near.map((entry) =>
												h('span', { className: 'ar_sizeChip', key: entry.id, title: entry.title }, (entry.title || '(无标题)') + ' · ' + String(entry.score)),
											),
										)
									: null,
							),
				),
				h('pre', { className: 'ar_preview' }, result === null ? '' : result.text === '' ? '（这个目录下没有任何生效规则，会话不会收到额外提示）' : result.text),
			);
		}

		/** 场景模拟结果的人话摘要（纯字符串，便于测试）。 */
		function resultSummaryOfScene(scene) {
			if (scene === null || scene.total === 0) return '这个目录下没有标「按场景」的规则 —— 先在规则卡片上勾上「按场景」。';
			if (!scene.sceneMatching) return '有 ' + String(scene.total) + ' 条按场景规则，但总开关还关着（「更多 → 按场景注入 → 启用按场景注入」）；下面是开机后会命中的结果。';
			if (scene.matched.length === 0) return '这句话与 ' + String(scene.total) + ' 条按场景规则都不相关：本轮不注入任何按场景规则。';
			const chars = scene.matched.reduce((sum, entry) => sum + entry.chars, 0);
			return '命中 ' + String(scene.matched.length) + ' / ' + String(scene.total) + ' 条 · 共 ' + String(chars) + ' 字（预算 ' + String(scene.budget) + ' 字）。';
		}

		/** 预览结果的人话摘要（纯字符串数组，便于测试）。 */
		function resultSummary(result) {
			if (result.injected === '') return ['当前不会注入：没有生效的规则，或总开关被关掉了。'];
			const lines = [
				result.matched === null
					? '没有单独的项目规则，只用全局规则（' + String(result.counts.global) + ' 条）。'
					: '命中项目「' + (result.matched.label || result.matched.path) + '」：' +
						(result.matched.mode === 'override'
							? '只用它的 ' + String(result.counts.project) + ' 条规则，全局规则在这个目录不生效。'
							: '全局 ' + String(result.counts.global) + ' 条 + 本项目 ' + String(result.counts.project) + ' 条。'),
			];
			if (result.counts.suppressed > 0) lines.push('被这个项目挡掉的全局规则：' + String(result.counts.suppressed) + ' 条。');
			lines.push(
				'共 ' + String(result.rules.length) + ' 条规则 · 约 ' + String(result.chars) + ' 字（约 ' + String(result.tokens) + ' token）' +
					(result.truncated ? '，超过上限已截断' : ''),
			);
			return lines;
		}

		function injectedSummary(result) {
			if (result.injected === '') return '当前不注入（无生效规则或总开关关闭）';
			if (result.truncated) {
				return '实际注入 ' + String(result.injectedChars) + ' / 全文 ' + String(result.chars) + ' 字符（已截断）· 约 ' + String(result.injectedTokens) + ' token';
			}
			return '注入 ' + String(result.chars) + ' 字符 · 约 ' + String(result.tokens) + ' token';
		}

		// ------------------------------------------------------------- 插件自更新状态

		/**
		 * 插件自更新的全部状态与副作用：探测能力 → 查更新 → 发起 → 轮询到终态。
		 * 判定逻辑都在上面的纯函数里，这里只负责「什么时候调用它们、什么时候清掉定时器」。
		 */
		function usePluginUpdate() {
			const [capabilities, setCapabilities] = useState(null);
			const [status, setStatus] = useState(null);
			const [operation, setOperation] = useState(null);
			const [operationId, setOperationId] = useState(null);
			const [checking, setChecking] = useState(false);
			const [note, setNote] = useState('');
			/** 只认最后一次检查：连点「检查更新」时，先发的响应可能后到。 */
			const seqRef = useRef(0);
			/**
			 * 卸载后到来的响应一律丢弃。fetch 在这里没法真取消，与文件里各处 cancelled
			 * 的写法是同一个目的：宁可丢一次状态更新，也不要往已卸载的组件里写。
			 */
			const aliveRef = useRef(true);

			useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);

			const check = useCallback(async (force) => {
				seqRef.current += 1;
				const seq = seqRef.current;
				setChecking(true);
				try {
					let caps = null;
					try {
						caps = await probeMarket();
					} catch {
						/* 没装插件市场是正常情况：整块不渲染 */
					}
					if (!aliveRef.current || seq !== seqRef.current) return;
					setCapabilities(caps);
					if (caps === null) {
						setStatus(null);
						setNote('没连上插件市场（dshmarket）。可以到插件市场里手动检查并更新本插件。');
						return;
					}
					try {
						const next = await requestUpdateCheck(force);
						if (!aliveRef.current || seq !== seqRef.current) return;
						setStatus(next);
						setNote(
							next === null
								? '插件市场里查不到本插件（可能没装在这个 profile 里）。'
								: next.updateAvailable === true
									? '有可用更新，见面板顶部。'
									: '已是最新版本（' + shortVersion(next.installedVersion) + '）。',
						);
						// 查到的是「现在」：已经结束的旧记录不该继续占着吸顶区，正在跑的那次不能丢
						setOperation((previous) => (previous === null || isOperationTerminal(previous) ? null : previous));
					} catch (cause) {
						if (!aliveRef.current || seq !== seqRef.current) return;
						setStatus(null);
						setNote('查更新失败：' + (cause instanceof Error ? cause.message : String(cause)));
						// 插件不在市场里（404）是正常回答，不值得往控制台里记一笔
						if (cause.status !== 404) console.error('[ian-rules] 查询插件更新失败', cause);
					}
				} finally {
					if (aliveRef.current && seq === seqRef.current) setChecking(false);
				}
			}, []);

			// 挂载时查一次：不带 force，走市场缓存，别每次开面板都打网络
			useEffect(() => {
				check(false);
			}, [check]);

			// 轮询进度：到终态就 setOperationId(null)，这个 effect 重建时清掉定时器
			useEffect(() => {
				if (operationId === null) return undefined;
				let cancelled = false;
				const timer = setInterval(async () => {
					try {
						const next = await requestOperation(operationId);
						if (cancelled || next === null) return;
						setOperation(next);
						if (isOperationTerminal(next)) {
							setOperationId(null);
							// 「更多」里的那句检查结果到这里就过期了：顶上那条提示才是现在的状态
							setNote('');
						}
					} catch (cause) {
						if (cancelled) return;
						console.error('[ian-rules] 读取更新进度失败', cause);
					}
				}, UPDATE_POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [operationId]);

			/** 失败一律走同一条展示路径：市场给了话就照它的说，没有才用面板的兜底文案。 */
			const applyFailure = (cause, action, retryable) => {
				const failed = failedOperation(isObject(cause) ? cause.payload : undefined, failureMessage(cause, action), retryable);
				if (failed !== null) setOperation(failed);
				setOperationId(null);
			};

			const startUpdate = async () => {
				setNote('');
				try {
					const next = await requestUpdate();
					if (!aliveRef.current || next === null) return;
					setOperation(next);
					if (!isOperationTerminal(next) && typeof next.operationId === 'string' && next.operationId !== '') setOperationId(next.operationId);
				} catch (cause) {
					if (!aliveRef.current) return;
					applyFailure(cause, '更新', true);
				}
			};

			/**
			 * 回滚。成功时市场会把记录改成 rolled-back 并标上需要重启，直接用它那份；
			 * 没成功时原因在市场写好的 outcome.rollback.detail 里，原样展示 —— 不给
			 * 「重试」，「重试」接的是发起更新那条路，不是再回滚一次。
			 */
			const runRollback = async (id) => {
				try {
					const next = await requestRollback(id);
					if (!aliveRef.current || next === null) return;
					if (next.state === 'rolled-back') {
						setOperation(next);
						return;
					}
					const rollback = isObject(next.outcome) && isObject(next.outcome.rollback) ? next.outcome.rollback : {};
					const detail = typeof rollback.detail === 'string' && rollback.detail !== '' ? rollback.detail : '回滚没有成功，插件市场没有给出原因。';
					setOperation({ state: 'failed', failure: { message: detail, retryable: false } });
				} catch (cause) {
					if (!aliveRef.current) return;
					applyFailure(cause, '回滚', false);
				}
			};

			const runRestart = async () => {
				try {
					await requestRestart();
				} catch (cause) {
					if (!aliveRef.current) return;
					applyFailure(cause, '重启', false);
				}
			};

			const run = (action) => {
				if (action === 'check') {
					check(true);
					return;
				}
				// 重启会掐断当前会话（包括这个页面），不可逆动作必须用户点头
				if (action === 'restart') {
					if (!window.confirm('重启 profile 会中断当前正在进行的会话（包括这个页面），确定现在重启吗？')) return;
					runRestart();
					return;
				}
				if (action === 'rollback') {
					if (!window.confirm('回滚会把这个插件退回更新前的版本，确定继续吗？')) return;
					if (isObject(operation) && typeof operation.operationId === 'string') runRollback(operation.operationId);
					return;
				}
				startUpdate();
			};

			return { notice: updateNotice(status, operation, capabilities), checking, note, run };
		}

		// --------------------------------------------------------------- 面板主体

		function DevRulesPanel() {
			const [status, setStatus] = useState('loading');
			const [doc, setDoc] = useState(null);
			const [meta, setMeta] = useState(null);
			const [workspaces, setWorkspaces] = useState([]);
			const [dirty, setDirty] = useState(false);
			const [tab, setTab] = useState('global');
			const [message, setMessage] = useState({ kind: '', text: '' });
			const [busy, setBusy] = useState(false);
			const [fatal, setFatal] = useState('');
			const [conflict, setConflict] = useState(null);
			const [pendingImport, setPendingImport] = useState(null);
			const [query, setQuery] = useState('');
			const [groupFilter, setGroupFilter] = useState('');
			/** 插件自更新（有更新 / 更新中 / 刚失败时才在吸顶区出现，见 updateNotice）。 */
			const update = usePluginUpdate();

			const revisionRef = useRef(0);
			const dirtyRef = useRef(false);
			const busyRef = useRef(false);
			const fileRef = useRef(null);
			// 只在提交之后同步：渲染期赋值碰上被打断丢弃的 render，会把一个根本没生效的
			// 状态写进 ref —— dirtyRef 一旦落成 false，轮询就会把未保存的改动当成可以静默覆盖。
			// 用 layout effect（提交后同步执行）而不是被动 effect：被动 effect 被排成宏任务，
			// 已经到点的轮询 timer 有机会抢在它前面读到上一次提交的旧值，正好落进要防的那个坑。
			useLayoutEffect(() => {
				dirtyRef.current = dirty;
				busyRef.current = busy;
			}, [dirty, busy]);

			const applyState = useCallback((payload, note) => {
				setDoc(payload.doc);
				setMeta(payload.meta);
				revisionRef.current = payload.meta.revision;
				setDirty(false);
				if (note !== undefined) setMessage(note);
			}, []);

			/**
			 * 取文档。`fromDisk` 只给用户的显式动作（「放弃修改并重新载入」）用：
			 * 宿主在目录监听装不上时会退回 15 秒轮询，此时宿主内存可能比磁盘旧，而
			 * revision 没变、随后的保存不会 409 —— 等于静默覆盖别人的改动。
			 * 首次装载与后台轮询仍读内存（宿主自己会 watch 磁盘），不必多跑一趟磁盘。
			 */
			const load = useCallback(async (fromDisk) => {
				setStatus('loading');
				setFatal('');
				setConflict(null);
				try {
					const payload = fromDisk === true ? await reloadState() : await loadState();
					applyState(payload, { kind: '', text: '' });
					setStatus('ready');
				} catch (cause) {
					setFatal(cause instanceof Error ? cause.message : String(cause));
					setStatus('error');
				}
			}, [applyState]);

			useEffect(() => {
				load();
			}, [load]);

			useEffect(() => {
				let cancelled = false;
				loadWorkspaces()
					.then((payload) => {
						if (!cancelled) setWorkspaces(Array.isArray(payload.workspaces) ? payload.workspaces : []);
					})
					.catch(() => {
						/* 拿不到工作区列表不影响使用 */
					});
				return () => {
					cancelled = true;
				};
			}, []);

			// 与磁盘同步：别人（另一个会话 / 手工编辑）改了规则时，没本地改动就静默跟上，
			// 有改动就明确提示，避免下一次保存覆盖别人。
			useEffect(() => {
				if (status !== 'ready') return undefined;
				const timer = setInterval(async () => {
					if (busyRef.current) return;
					try {
						const payload = await loadState();
						// 只认更新的 revision；往返期间可能已经起了保存，那一次才算数
						if (!isNewerRevision(payload.meta.revision, revisionRef.current)) return;
						if (busyRef.current) return;
						if (!dirtyRef.current) {
							applyState(payload, { kind: 'ok', text: '已同步外部改动（另一个会话或手工编辑）' });
						} else {
							setMessage({ kind: 'error', text: '磁盘上的规则被外部改过了，而你这边还有没保存的修改；建议先把你的改动「导出」备份，再点「放弃修改并重新载入」。' });
						}
					} catch {
						/* 宿主暂时不可用：下一轮再试 */
					}
				}, 5000);
				return () => clearInterval(timer);
			}, [status, applyState]);

			const mutate = useCallback((apply) => {
				setDoc((previous) => {
					if (previous === null) return previous;
					const draft = clone(previous);
					apply(draft);
					return draft;
				});
				setDirty(true);
				setMessage({ kind: '', text: '' });
			}, []);

			/**
			 * 保存。`applyMode='next-session'` 时，正在运行的会话继续用它们已经吃进
			 * 上下文的旧规则，只有新会话吃新规则。
			 *
			 * 为什么值得给用户这个选择：规则一改，系统提示就变了；正在跑的会话（已经
			 * 从缓存里读过旧提示的那些）下一次请求要重算整个提示前缀。有前缀缓存的
			 * 供应商上这一下可能是本插件一整天规则开销的几十倍 —— 而「下个会话生效」
			 * 是零代价的。
			 */
			const save = useCallback(
				async (applyMode) => {
					if (doc === null) return;
					const rejection = validateDoc(doc, limitsOf(meta));
					if (rejection !== null) {
						setTab(rejection.tab);
						setMessage({ kind: 'error', text: rejection.text });
						return;
					}
					setBusy(true);
					try {
						const payload = await saveState(doc, revisionRef.current, applyMode);
						applyState(payload, {
							kind: 'ok',
							text:
								typeof payload.notice === 'string' && payload.notice !== ''
									? payload.notice
									: '已保存并生效：正在进行的对话，下一步就会带上这些规则。',
						});
						setConflict(null);
					} catch (cause) {
						if (cause.status === 409 && cause.payload !== null && cause.payload !== undefined) {
							setConflict({ doc: cause.payload.doc, meta: cause.payload.meta });
							setMessage({ kind: 'error', text: '保存被拦下了：磁盘上的规则被别处改过，先选一个处理方式。' });
						} else {
							setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
						}
					} finally {
						setBusy(false);
					}
				},
				[doc, applyState, meta],
			);

			const saveNow = useCallback(() => save('now'), [save]);
			const saveDeferred = useCallback(() => save('next-session'), [save]);

			/** 让被「下个会话生效」钉住的会话改用当前规则（不写盘，只解冻）。 */
			const resumeLiveSessions = useCallback(async () => {
				setBusy(true);
				try {
					const payload = await saveState(doc, revisionRef.current, 'now');
					applyState(payload, { kind: 'ok', text: '正在运行的会话已改用当前规则（会重算一次提示缓存）。' });
				} catch (cause) {
					setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
				} finally {
					setBusy(false);
				}
			}, [doc, applyState]);

			const forceSaveNow = useCallback(async () => {
				if (doc === null) return;
				setBusy(true);
				try {
					const payload = await forceSave(doc);
					applyState(payload, { kind: 'ok', text: '已用你这里的版本覆盖磁盘，并生效。' });
					setConflict(null);
				} catch (cause) {
					setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
				} finally {
					setBusy(false);
				}
			}, [doc, applyState]);

			const doExport = useCallback(
				async (kind) => {
					if (doc === null) return;
					setBusy(true);
					try {
						const payload = await exportDoc(doc);
						if (kind === 'markdown') downloadText('开发规则备份.md', payload.markdown, 'text/markdown;charset=utf-8');
						else downloadText('开发规则备份.json', payload.json, 'application/json;charset=utf-8');
						setMessage({ kind: 'ok', text: '已导出备份（包含还没保存的改动）。' });
					} catch (cause) {
						setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
					} finally {
						setBusy(false);
					}
				},
				[doc],
			);

			const pickImport = useCallback(async (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = '';
				if (!file) return;
				setBusy(true);
				try {
					const text = await file.text();
					const payload = await importText(text);
					setPendingImport({ doc: payload.doc, summary: payload.summary, name: file.name });
					setMessage({ kind: '', text: '' });
				} catch (cause) {
					setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
				} finally {
					setBusy(false);
				}
			}, []);

			useEffect(() => {
				const onKeyDown = (event) => {
					if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
					event.preventDefault();
					// 用 ref 读最新值：这个 effect 只随 save 重建，不能靠闭包里的 busy / dirty
					if (!canShortcutSave(busyRef.current, dirtyRef.current)) return;
					saveNow();
				};
				window.addEventListener('keydown', onKeyDown);
				return () => window.removeEventListener('keydown', onKeyDown);
			}, [saveNow]);

			const totalRules = doc === null ? 0 : doc.global.length + doc.projects.reduce((sum, project) => sum + project.rules.length, 0);
			/** 标了「按场景」的规则数：总开关旁边要让用户看得见它有没有用。 */
			const autoRuleCount =
				doc === null
					? 0
					: doc.global.concat(doc.projects.flatMap((project) => project.rules)).filter((rule) => rule.mode === 'auto').length;
			/** 被「下个会话生效」钉住的运行中会话数（宿主 meta 下发）。 */
			const deferredCount =
				meta === null || meta.deferred === undefined || typeof meta.deferred.sessions !== 'number' ? 0 : meta.deferred.sessions;
			const tabItems = doc === null ? [] : panelTabs(doc);
			// 在当前项目页里把它删掉之后，tab 会指向一个不存在的页签 —— 退回「项目」名册，
			// 而不是渲染空页（也正是刚刚那个动作发生的地方）。
			const activeTab = tabItems.some((item) => item.key === tab) ? tab : 'projects';
			const activeProject = activeTab.startsWith('p:') ? doc.projects.find((project) => 'p:' + project.id === activeTab) : undefined;
			const activeRules = doc === null ? [] : activeTab === 'global' ? doc.global : activeProject === undefined ? [] : activeProject.rules;
			const isRuleTab = activeTab === 'global' || activeProject !== undefined;
			/** 分组下拉只列当前页出现过的分组；自动补全（datalist）用全文档的，跨页打字也能补。 */
			const tabGroups = collectGroups(activeRules);
			const allGroups = collectGroups([
				...(doc === null ? [] : doc.global),
				...(doc === null ? [] : doc.projects.flatMap((project) => project.rules)),
			]);
			/** 上限由宿主下发（meta.limits），保存校验与输入框的 maxLength 共用这一份。 */
			const limits = limitsOf(meta);
			/** 顶部更新条的内容：null＝此刻不该出现（没更新、也没在更新、也没刚失败）。 */
			const notice = update.notice;

			if (status === 'loading') {
				return h('div', { className: 'ar_panel' }, h('div', { className: 'ar_empty' }, '读取规则中…'));
			}
			if (status === 'error' || doc === null) {
				return h(
					'div',
					{ className: 'ar_panel' },
					h(Message, { kind: 'error', text: '读取失败：' + fatal }),
					h('div', { className: 'ar_row' }, h(Button, { onClick: load }, '重试')),
				);
			}

			return h(
				'div',
				{ className: 'ar_panel' },
				h(
					'div',
					{ className: 'ar_top' },
					h(
						'div',
						{ className: 'ar_topRow' },
						h('span', { className: 'ar_titleIcon' }, h(IconRules, { size: 15 })),
						h('span', { className: 'ar_title' }, '开发规则'),
						h(
							'button',
							{
								type: 'button',
								className: 'ar_statusChip',
								'data-on': doc.enabled !== false ? '1' : undefined,
								title: doc.enabled !== false ? '点一下可以整体停用（规则保留，但所有会话都不再收到）' : '点一下重新启用',
								onClick: () => mutate((draft) => { draft.enabled = !(draft.enabled !== false); }),
							},
							doc.enabled !== false ? '生效中' : '已停用',
						),
						// 顶部只留这一个主动作：导出 / 导入 / 重载都是低频动作，收在「更多」里
						// （同一件事在吸顶区再放一个按钮，只会让最该点的那个按钮失去焦点）。
						h(Button, { variant: 'primary', onClick: saveNow, disabled: busy || !dirty }, busy ? '保存中…' : dirty ? '保存并生效' : '已保存'),
					),
					notice === null ? null : h(UpdateBar, { notice, onAction: update.run }),
					h(
						'div',
						{ className: 'ar_topSub' },
						'这里写的规则会自动出现在对应会话的提示里，让 agent 按你的习惯干活。共 ' + String(totalRules) + ' 条，保存后下一步生效。',
					),
					// 选了「下个会话生效」时把状态摆在明面上：否则用户会以为规则没生效
					deferredCount > 0
						? h(
								'div',
								{ className: 'ar_topSub ar_deferred' },
								String(deferredCount) + ' 个正在运行的会话仍在使用保存前的旧规则。',
								h(Button, { onClick: resumeLiveSessions, disabled: busy }, '让它们改用新规则'),
							)
						: null,
				),
				h(Message, { kind: message.kind, text: message.text }),
				conflict !== null
					? h(
							'div',
							{ className: 'ar_banner' },
							h('div', null, '别处已经改过磁盘上的规则，直接保存会把那些改动覆盖掉。选一个：'),
							h(
								'span',
								{ className: 'ar_bannerActions' },
								h(
									Button,
									{
										disabled: busy,
										onClick: () => {
											applyState({ doc: conflict.doc, meta: conflict.meta }, { kind: 'ok', text: '已载入磁盘上的版本，你之前的本地修改已丢弃。' });
											setConflict(null);
										},
									},
									'载入磁盘版本（放弃我的修改）',
								),
								h(Button, { variant: 'danger', onClick: forceSaveNow, disabled: busy }, '用我的修改覆盖'),
							),
						)
					: null,
				pendingImport !== null
					? h(
							'div',
							{ className: 'ar_banner' },
							h('div', null, '读到了 ' + pendingImport.name + '：全局 ' + String(pendingImport.summary.global) + ' 条 · 项目 ' + String(pendingImport.summary.projects) + ' 个（共 ' + String(pendingImport.summary.projectRules) + ' 条项目规则）。要怎么用？'),
							h(
								'span',
								{ className: 'ar_bannerActions' },
								h(
									Button,
									{
										onClick: () => {
											setDoc(pendingImport.doc);
											setDirty(true);
											setPendingImport(null);
											setMessage({ kind: 'ok', text: '已替换成导入的内容，确认没问题后点「保存并生效」。' });
										},
									},
									'替换现有规则',
								),
								h(
									Button,
									{
										onClick: () => {
											const incoming = pendingImport.doc;
											mutate((draft) => {
												const merged = mergeDocs(draft, incoming);
												draft.global = merged.global;
												draft.projects = merged.projects;
											});
											setPendingImport(null);
											setMessage({ kind: 'ok', text: '已合并（重复的不会重复加），确认后点「保存并生效」。' });
										},
									},
									'合并进来',
								),
								h(Button, { onClick: () => setPendingImport(null) }, '算了'),
							),
						)
					: null,
				totalRules === 0
					? h(
							'div',
							{ className: 'ar_onboarding' },
							h('div', { className: 'ar_onboardingTitle' }, '还没有规则，两步就能用起来'),
							h(
								'ol',
								{ className: 'ar_onboardingList' },
								h('li', null, '在下面写 1~3 条「做什么项目都适用」的规则（比如：改完代码跑测试）。'),
								h('li', null, '以后需要区别对待时，到「项目」页加一个项目 —— 它会得到自己的一页。'),
							),
							h(
								'div',
								{ className: 'ar_row' },
								h(
									Button,
									{
										variant: 'primary',
										onClick: () =>
											mutate((draft) => {
												for (const sample of SAMPLE_RULES) {
													if (draft.global.some((rule) => rule.title === sample.title)) continue;
													draft.global.push({ id: newId('g'), ...sample, enabled: true });
												}
											}),
									},
									'先插入 4 条虚构示例',
								),
								h('span', { className: 'ar_hintInline' }, '插进来就能改，改完点右上角「保存并生效」。'),
							),
						)
					: null,
				h(
					'div',
					{ className: 'ar_tabs' },
					tabItems.map((item) =>
						h(
							'button',
							{
								key: item.key,
								type: 'button',
								role: 'tab',
								className: 'ar_tab',
								'data-on': activeTab === item.key ? '1' : undefined,
								title: item.key === 'projects' ? '项目名册：加项目、改目录与关系' : '',
								onClick: () => setTab(item.key),
							},
							item.count === null ? item.label : item.label + ' ' + String(item.count),
						),
					),
				),
				// 搜索与分组筛选只在**有规则卡片**的页签出现：名册页没有规则可筛，
				// 「效果预览」也不吃筛选 —— 摆一组不生效的控件，用户会以为结果被筛过。
				isRuleTab && shouldShowFilters(activeRules.length, query, groupFilter)
					? h(
							'div',
							{ className: 'ar_row ar_filterRow' },
							h('input', {
								className: 'ar_input ar_search',
								value: query,
								placeholder: '搜索规则…',
								onChange: (event) => setQuery(event.target.value),
							}),
							h(
								'select',
								{ className: 'ar_select', value: groupFilter, onChange: (event) => setGroupFilter(event.target.value) },
								h('option', { value: '' }, '全部分组'),
								h('option', { value: '__none__' }, '未分组'),
								tabGroups.map((name) => h('option', { key: name, value: name }, name)),
							),
						)
					: null,
				h(
					'div',
					{ className: 'ar_body' },
					activeTab === 'global'
						? h(GlobalTab, { doc, mutate, limits, query, groupFilter })
						: activeTab === 'projects'
							? h(ProjectsTab, { doc, mutate, limits, onOpenProject: (id) => setTab('p:' + id) })
							: activeProject === undefined
								? h(PreviewTab, { doc, initialPath: '' })
								: h(ProjectRulesTab, {
										project: activeProject,
										limits,
										query,
										groupFilter,
										onOpenRoster: () => setTab('projects'),
										onChangeRules: (rules) =>
											mutate((draft) => {
												const target = draft.projects.find((project) => 'p:' + project.id === activeTab);
												if (target !== undefined) target.rules = rules;
											}),
									}),
				),
				h(
					'details',
					{ className: 'ar_more' },
					h('summary', null, '更多（插件更新、备份、导入、文件位置、使用说明）'),
					h(
						'div',
						{ className: 'ar_moreBody' },
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '备份与迁移'),
							h(
								'div',
								{ className: 'ar_row' },
								h(Button, { onClick: () => doExport('markdown'), disabled: busy }, '导出备份（Markdown）'),
								h(Button, { onClick: () => doExport('json'), disabled: busy }, '导出备份（JSON）'),
								h(Button, { onClick: () => fileRef.current !== null && fileRef.current.click(), disabled: busy }, '从备份导入…'),
							),
							h(Hint, null, 'Markdown 备份可以直接改（`1. **标题**` 下面缩进的行算正文），也能导入回来。'),
						),
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '维护'),
							h(
								'div',
								{ className: 'ar_row' },
								h(
									Button,
									{
										onClick: saveDeferred,
										disabled: busy || !dirty,
										title: '规则改动只对新会话生效；已经在跑的会话继续用它们现在手里的规则',
									},
									'保存（只对新会话生效）',
								),
								h(
									Button,
									{
										onClick: () => {
											if (dirty && !window.confirm('还有没保存的修改，重新载入会丢掉它们。继续？')) return;
											load(true);
										},
									},
									'放弃修改并重新载入',
								),
							),
							h(
								Hint,
								null,
								'规则一改，系统提示就变了：正在运行的会话下一次请求要重算一遍提示缓存（长会话上这一下可能比一整天所有规则的开销还贵）。选「只对新会话生效」就没这个代价 —— 当前在跑的会话继续用旧规则，新开的会话用新规则。',
							),
						),
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '按场景注入'),
							h(
								'div',
								{ className: 'ar_row' },
								h(
									Check,
									{
										checked: doc !== null && doc.sceneMatching === 'auto',
										onChange: (value) => mutate((draft) => { draft.sceneMatching = value ? 'auto' : 'off'; }),
										title: '打开后：标了「按场景」的规则不再常驻系统提示，改成按当前任务匹配后送到对话末尾',
									},
									'启用按场景注入',
								),
							),
							h(
								Hint,
								null,
								'关着（默认）时所有规则都常驻注入，和以前完全一样。打开后：常驻规则照旧在系统提示里；标了「按场景」的规则只在系统提示里留一行目录，正文要等命中当前任务才送到对话末尾 —— 规则多的时候，这样既不会撑爆系统提示，也不会让 agent 被一墙规则稀释掉注意力。',
							),
							h(
								'div',
								{ className: 'ar_row' },
								h(
									Check,
									{
										checked: doc !== null && doc.sceneLog === true,
										onChange: (value) => mutate((draft) => { draft.sceneLog = value; }),
										title: '把每次按场景命中了哪几条记到 ian-rules.hits.jsonl，用于回头调阈值',
									},
									'记录命中日志',
								),
							),
							autoRuleCount > 0
								? h('div', { className: 'ar_hintInline' }, '当前有 ' + String(autoRuleCount) + ' 条规则标了「按场景」。')
								: null,
						),
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '插件更新'),
							h(
								'div',
								{ className: 'ar_row' },
								h(Button, { onClick: () => update.run('check'), disabled: busy || update.checking }, update.checking ? '检查中…' : '检查更新'),
							),
							update.note === '' ? null : h('div', { className: 'ar_hintInline' }, update.note),
							h(Hint, null, '向插件市场（dshmarket）查一次本插件有没有新版本。有更新时顶部会出现「更新」按钮；面板挂载时也会自动查一次（走市场缓存）。'),
						),
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '使用说明'),
							h(
								'ul',
								{ className: 'ar_help' },
								h('li', null, '「全局规则」对每个会话生效；每个项目在页签栏里有自己的一页，会话的工作目录落在它的目录下面才会用上那一页。'),
								h('li', null, '项目的两种用法：「全局规则 + 本项目规则」追加，或「只用本项目规则」把全局规则在这个项目里完全关掉 —— 在「项目」页里设。'),
								h('li', null, '规则卡按「分组」归拢；注入给会话的文本也是这两级标题：第一级是全局 / 哪个项目，第二级才是你的分组。')+
								h('li', null, '规则里的「约 N 字」是它给每轮对话增加的上下文量，规则越多、越长，模型每步要读的就越多。'),
								h('li', null, '保存后立即生效：正在进行的对话从下一步开始带上，不用重启。不想打断正在跑的会话时，用「更多 → 维护 → 保存（只对新会话生效）」。'),
								h('li', null, '不想让某条规则生效时，取消它的「生效」勾选即可，内容不会丢。'),
							),
						),
						h(
							'div',
							{ className: 'ar_moreGroup' },
							h('div', { className: 'ar_fieldLabel' }, '文件位置'),
							h('div', { className: 'ar_filePath' }, meta === null ? 'ian-rules.json' : prettyPath(meta.file, meta.home)),
							meta !== null && meta.backupFile !== undefined
								? h('div', { className: 'ar_filePath' }, '上一版备份：' + prettyPath(meta.backupFile, meta.home))
								: null,
							// 更名迁移只在发生的那一次启动里出现（migratedFrom 是内存里的）
							meta !== null && typeof meta.migratedFrom === 'string' && meta.migratedFrom !== ''
								? h('div', { className: 'ar_hintInline' }, '插件更名时已从 ' + prettyPath(meta.migratedFrom, meta.home) + ' 复制过来（原文件保留，可自行删除）。')
								: null,
							meta !== null && meta.error !== '' ? h('div', { className: 'ar_footError' }, '文件告警：' + meta.error) : null,
						),
					),
				),
				h('input', {
					ref: fileRef,
					type: 'file',
					accept: '.json,.md,.markdown,.txt,application/json,text/markdown,text/plain',
					className: 'ar_fileInput',
					onChange: pickImport,
				}),
				// 底部不再放第二个「保存」：主动作在吸顶条里、滚动时始终在视野里，
				// 两个同名按钮并排出现时，用户反而要判断该点哪一个。
				h(
					'datalist',
					{ id: 'ar-groups' },
					allGroups.map((name) => h('option', { key: name, value: name })),
				),
				h(
					'datalist',
					{ id: 'ar-tags' },
					collectTags([
						...(doc === null ? [] : doc.global),
						...(doc === null ? [] : doc.projects.flatMap((project) => project.rules)),
					]).map((tag) => h('option', { key: tag, value: tag })),
				),
				h(
					'datalist',
					{ id: 'ar-workspaces' },
					workspaces.map((entry) => h('option', { key: entry.path, value: entry.path }, entry.title)),
				),
			);
		}

		// ------------------------------------------------------------------ 样式

		const CSS = `
/*
 * 设计变量集中在这一层：卡片圆角 / 描边 / 底色 / 文字色阶只有一处定义。
 * 「统一风格」不是把每张卡都写一遍同样的数值，而是让所有卡都从同一组变量取值 ——
 * 以后改一个数字，规则卡、项目卡、空态、上手块、预览块一起变。
 * 回退值刻意用中性灰（而不是 rgba(0,0,0,…)）：token 万一缺失，暗色主题下也不会漏进一层浅色。
 */
.ar_panel { --ar-radius: 12px; --ar-radius-sm: 8px; --ar-gap: 10px; --ar-pad: 10px 12px; --ar-line: var(--dsw-alias-border-l1, rgba(127,127,127,.22)); --ar-line-strong: var(--dsw-alias-border-l2, rgba(127,127,127,.4)); --ar-surface: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07)); --ar-surface-2: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); --ar-text: var(--dsw-alias-label-primary, #1b1c1e); --ar-text-dim: var(--dsw-alias-label-secondary, #6b7280); --ar-brand: var(--dsw-alias-brand-primary, #4d6bfe); --ar-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; height: 100%; overflow: auto; padding: 0 14px 40px; container-type: inline-size; font-family: inherit; background: var(--dsw-alias-bg-base, transparent); color: var(--ar-text); font-size: 13px; line-height: 1.6; }
.ar_panel * { box-sizing: border-box; }
/* 没有吸顶条的两种状态（读取中 / 读取失败）自己补一点上边距 —— 面板的上内边距归零之后，
   它们是唯一会贴到面板顶边的内容 */
.ar_panel > .ar_empty:first-child, .ar_panel > .ar_msg:first-child { margin-top: 12px; }

/* ---------- 吸顶区：状态 + 唯一的主动作 ---------- */
/* 长列表滚下去时主动作「保存并生效」必须还在视野里；底色要不透明，否则规则会从条底下透出来。
   吸顶条自带面板的上内边距：top:0 贴住滚动口时，内容不会从它上方那条缝里漏出来
   （面板留 padding-top 的话，滚动的卡片会在吸顶条上方露出半行字）。 */
.ar_top { position: sticky; top: 0; z-index: 3; margin: 0 -14px var(--ar-gap); padding: 12px 14px 10px; border-bottom: 1px solid var(--ar-line); background: var(--dsw-alias-bg-base, #ffffff); }
.ar_topRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar_titleIcon { display: inline-flex; color: var(--ar-text-dim); }
.ar_title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.ar_topSub { margin-top: 5px; font-size: 11.5px; line-height: 1.5; color: var(--ar-text-dim); }
/* 场景模拟器：和上面的目录预览是一组，但状态各自独立 */
.ar_sceneBox { border-top: 1px dashed var(--ar-line); padding-top: 12px; }

/* 「下个会话生效」的状态行：只在真有被钉住的会话时出现，所以它不必低调 */
.ar_deferred { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--ar-text); }
.ar_deferred .ar_btn { padding: 2px 8px; font-size: 11.5px; }
.ar_topRow .ar_btnPrimary { margin-left: auto; }

/* 总开关胶囊：点一下整体停用 / 重新启用 */
.ar_statusChip { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 11.5px; line-height: 1.4; border: 1px solid var(--ar-line-strong); background: transparent; color: var(--ar-text-dim); border-radius: 999px; padding: 2px 9px; cursor: pointer; }
.ar_statusChip:hover { border-color: var(--ar-text-dim); color: var(--ar-text); }
.ar_statusChip[data-on] { border-color: var(--dsw-alias-state-success-primary, #2f9e6e); color: var(--ar-text); }
.ar_statusChip[data-on]::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2f9e6e); }

/* 插件更新条：紧跟在标题行下面的一条细行，滚下去也看得见；用描边色区分要紧程度，不占主动作的位置 */
.ar_update { margin-top: 8px; padding: 5px 9px; border: 1px solid var(--ar-brand); border-radius: var(--ar-radius-sm); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; background: var(--ar-surface); }
.ar_updateText { flex: 1 1 auto; }
.ar_update[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary, #2f9e6e); }
.ar_update[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary, #e5534b); }

/* ---------- 按钮 ---------- */
.ar_btn { font: inherit; font-size: 12px; line-height: 1.5; border: 1px solid var(--ar-line-strong); background: transparent; color: inherit; border-radius: var(--ar-radius-sm); padding: 5px 11px; cursor: pointer; transition: border-color .12s ease, background .12s ease, color .12s ease; }
.ar_btn:hover:not(:disabled) { border-color: var(--ar-brand); }
.ar_btn:disabled { opacity: .45; cursor: not-allowed; }
/* 主动作不填色：只加品牌色描边 + 加粗，文字始终用面板文字色，任何主题下都看得见 */
.ar_btnPrimary { border-color: var(--ar-brand); border-width: 1.5px; font-weight: 600; }
.ar_btnPrimary:disabled { border-color: var(--ar-line-strong); }
.ar_btnDanger { border-color: var(--dsw-alias-state-error-primary, #e5534b); color: var(--dsw-alias-state-error-primary, #e5534b); }
/* 安静按钮：「+ 加一条」「改目录 →」这类动作不该和「保存并生效」抢注意力 */
.ar_btnQuiet { border-color: transparent; color: var(--ar-text-dim); padding: 4px 8px; }
.ar_btnQuiet:hover:not(:disabled) { border-color: var(--ar-line-strong); color: var(--ar-text); }

.ar_iconBtn { font: inherit; font-size: 12px; border: 1px solid transparent; background: transparent; color: var(--ar-text-dim); border-radius: 6px; width: 24px; height: 24px; line-height: 1; cursor: pointer; }
.ar_iconBtn:hover:not(:disabled) { background: var(--ar-surface-2); color: var(--ar-text); }
.ar_iconBtn:disabled { opacity: .3; cursor: not-allowed; }
.ar_iconBtnDanger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #e5534b); }
.ar_confirmBtn { font: inherit; font-size: 11.5px; border: 1px solid var(--dsw-alias-state-error-primary, #e5534b); background: transparent; color: var(--dsw-alias-state-error-primary, #e5534b); border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; font-weight: 600; }

/* 键盘可达性：焦点必须看得见 —— 面板里所有可点元素共用这一条 */
.ar_btn:focus-visible, .ar_iconBtn:focus-visible, .ar_confirmBtn:focus-visible, .ar_tab:focus-visible, .ar_statusChip:focus-visible, .ar_check input:focus-visible, .ar_more summary:focus-visible { outline: 2px solid var(--ar-brand); outline-offset: 1px; }

/* ---------- 页签：3 + N 个，横向滚动而不是折行 ---------- */
/* 项目一多，折行的页签会把内容区越挤越靠下、每行长短还都不一样；一条可横滚的页面条
   高度恒定，滚动位置一眼能看出「还有更多页」。 */
.ar_tabs { display: flex; gap: 2px; margin: 0 0 var(--ar-gap); border-bottom: 1px solid var(--ar-line); overflow-x: auto; scrollbar-width: thin; }
.ar_tab { flex: 0 0 auto; font: inherit; font-size: 12.5px; border: none; background: transparent; color: var(--ar-text-dim); padding: 7px 10px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: var(--ar-radius-sm) var(--ar-radius-sm) 0 0; white-space: nowrap; }
.ar_tab:hover { color: var(--ar-text); background: var(--ar-surface); }
.ar_tab[data-on] { color: var(--ar-brand); border-bottom-color: var(--ar-brand); font-weight: 600; }
.ar_filterRow { margin-bottom: var(--ar-gap); }

/* ---------- 卡片系统 ---------- */
/* 规则卡 / 项目卡 / 空态 / 上手块 / 身份栏 / 预览块全部同形：同一个圆角、同一种描边、
   同一层底色、同一组内边距。状态只用**描边样式与颜色**区分，不另起一套形状。 */
.ar_card, .ar_empty, .ar_onboarding, .ar_identity { border: 1px solid var(--ar-line); border-radius: var(--ar-radius); background: var(--ar-surface); padding: var(--ar-pad); }
.ar_card:hover { border-color: var(--ar-line-strong); }
.ar_empty { font-size: 12.5px; line-height: 1.55; color: var(--ar-text-dim); }
.ar_onboarding { display: flex; flex-direction: column; gap: 8px; }
.ar_onboardingTitle { font-size: 13px; font-weight: 600; }
.ar_onboardingList { margin: 0; padding-left: 20px; font-size: 12.5px; line-height: 1.55; color: var(--ar-text-dim); display: flex; flex-direction: column; gap: 4px; }

/* ---------- 区块、行、分组 ---------- */
.ar_section { display: flex; flex-direction: column; gap: var(--ar-gap); }
.ar_row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar_row > .ar_pathInput { flex: 1 1 200px; min-width: 140px; }
/* 第一序列是「全局 / 哪个项目」（页签与身份栏），第二序列才是用户分组：这里画的是第二级 */
.ar_group { display: flex; flex-direction: column; gap: 8px; }
.ar_groupHead { display: flex; align-items: baseline; gap: 8px; padding: 0 2px; }
.ar_groupName { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--ar-text); }
.ar_groupCount { font-size: 11px; color: var(--ar-text-dim); }
/* 两列式：单张卡片窄下来，同一段文字的横向跨度就短了，眼睛不用长距离横扫。
   阈值量的是**内容盒**（栏宽减掉左右内边距），520px 是「两列各自还剩约 255px」的下限 ——
   再窄就该退回单列：两列挤到 200px 一栏反而更难读。侧边栏默认宽度（约窗口的 45%）下
   本来就是单列，把栏拉宽或全屏才会变两列。 */
.ar_rulesGrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--ar-gap); align-items: start; }
@container (min-width: 520px) { .ar_rulesGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* ---------- 规则卡片 ---------- */
.ar_card { display: flex; flex-direction: column; gap: 6px; }
/* 停用不是「消失」：内容弱化即可，但「生效」勾选框和右侧工具必须保持正常对比度 ——
   用户正是靠它们把这条规则重新启用回来，整卡一起变淡就点不着了。 */
.ar_card[data-off] { border-style: dashed; background: transparent; }
.ar_card[data-off] .ar_titleInput, .ar_card[data-off] .ar_textarea { color: var(--ar-text-dim); }
.ar_cardHead { display: flex; align-items: center; gap: 8px; }
.ar_cardIndex { font-size: 11px; line-height: 18px; min-width: 18px; height: 18px; text-align: center; border-radius: 999px; background: var(--ar-surface-2); color: var(--ar-text-dim); flex: 0 0 auto; }
.ar_offChip { flex: 0 0 auto; font-size: 10.5px; line-height: 1.7; padding: 0 7px; border-radius: 999px; border: 1px solid var(--ar-line-strong); color: var(--ar-text-dim); }
.ar_cardFoot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar_cardTools { margin-left: auto; display: flex; gap: 2px; align-items: center; }
.ar_size { font-size: 11px; color: var(--ar-text-dim); white-space: nowrap; }

/* ---------- 输入控件 ---------- */
.ar_input, .ar_textarea, .ar_select { border: 1px solid var(--ar-line); border-radius: var(--ar-radius-sm); background: var(--dsw-alias-bg-base, transparent); color: inherit; padding: 5px 9px; font-size: 12.5px; font-family: inherit; transition: border-color .12s ease, box-shadow .12s ease; }
.ar_input:hover, .ar_textarea:hover, .ar_select:hover { border-color: var(--ar-line-strong); }
.ar_input:focus, .ar_textarea:focus, .ar_select:focus { outline: none; border-color: var(--ar-brand); box-shadow: 0 0 0 3px var(--ar-surface-2); }
.ar_titleInput { flex: 1 1 auto; min-width: 120px; font-weight: 600; font-size: 13px; padding: 4px 7px; }
/* 标题与分组在卡片里读起来应该是「文字」，不是三个并排的输入框：平时不描边，
   hover / 聚焦时才浮出可编辑的形状 —— 一屏卡片立刻少了三分之二的线。 */
.ar_card .ar_titleInput, .ar_card .ar_groupInput, .ar_card .ar_tagInput { border-color: transparent; background: transparent; }
.ar_card .ar_titleInput:hover, .ar_card .ar_groupInput:hover, .ar_card .ar_tagInput:hover { border-color: var(--ar-line); }
.ar_card .ar_titleInput:focus, .ar_card .ar_groupInput:focus, .ar_card .ar_tagInput:focus { border-color: var(--ar-brand); background: var(--dsw-alias-bg-base, transparent); }
.ar_groupInput { flex: 0 1 120px; min-width: 84px; font-size: 11.5px; padding: 3px 7px; color: var(--ar-text-dim); }
.ar_groupInput:focus { color: var(--ar-text); }
/* 标签输入：比分组再窄一点 —— 它只在「按场景」时才有用，不该占掉卡片底行的宽度 */
.ar_tagInput { flex: 0 1 110px; min-width: 76px; font-size: 11.5px; padding: 3px 7px; color: var(--ar-text-dim); }
.ar_tagInput:focus { color: var(--ar-text); }
.ar_textarea { width: 100%; resize: vertical; line-height: 1.6; font-family: var(--ar-mono); }

/* 列式字段（标签在上、控件在下）的 flex-basis 会被当成**高度**用：只要它落在
   column 容器（.ar_projectCard）里，flex: 1 1 200px 就让整个字段块高 200px，
   中间空出一大段。所以字段自身不带 basis，横向怎么分交给**行**容器决定。 */
.ar_field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ar_projectRow > .ar_field, .ar_row > .ar_field { flex: 1 1 200px; }
.ar_field > .ar_input, .ar_field > .ar_select, .ar_field > .ar_textarea { flex: 0 0 auto; width: 100%; }
.ar_fieldLabel { font-size: 11.5px; color: var(--ar-text-dim); }
.ar_fieldHint { font-size: 11px; line-height: 1.5; color: var(--ar-text-dim); }
.ar_pathInput { font-family: var(--ar-mono); }
.ar_select { flex: 0 0 auto; max-width: 100%; }
.ar_check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ar-text-dim); cursor: pointer; white-space: nowrap; }
.ar_check:hover { color: var(--ar-text); }
.ar_check input { accent-color: var(--ar-brand); margin: 0; }

/* ---------- 项目名册与项目身份栏 ---------- */
.ar_projectCard { display: flex; flex-direction: column; gap: 8px; }
.ar_projectBadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--ar-surface-2); color: var(--ar-text-dim); flex: 0 0 auto; }
.ar_projectName { font-size: 13px; font-weight: 600; }
.ar_projectRow { display: flex; gap: 10px; flex-wrap: wrap; }
.ar_identity { display: flex; flex-direction: column; gap: 4px; }
.ar_identityMain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar_identityName { font-size: 13.5px; font-weight: 600; }
.ar_identityPath { font-family: var(--ar-mono); font-size: 11.5px; line-height: 1.5; color: var(--ar-text-dim); overflow-wrap: anywhere; }
.ar_identityFoot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
.ar_chip { font-size: 11px; line-height: 1.7; padding: 0 8px; border-radius: 999px; border: 1px solid var(--ar-line-strong); color: var(--ar-text-dim); }

/* ---------- 提示、消息、横幅 ---------- */
.ar_hint { font-size: 12px; line-height: 1.55; color: var(--ar-text-dim); }
.ar_hintInline { font-size: 11.5px; color: var(--ar-text-dim); }
.ar_msg { margin: 0 0 var(--ar-gap); font-size: 12.5px; }
.ar_msg[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #2f9e6e); }
.ar_msg[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #e5534b); }
.ar_banner { margin: 0 0 var(--ar-gap); border: 1px solid var(--dsw-alias-state-warn-primary, #d29922); border-radius: var(--ar-radius); background: var(--ar-surface); padding: var(--ar-pad); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
.ar_bannerActions { display: flex; gap: 8px; flex-wrap: wrap; }

/* ---------- 效果预览 ---------- */
.ar_summary { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.55; color: var(--ar-text-dim); }
.ar_sizeList { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
.ar_sizeChip { padding: 1px 8px; border-radius: 999px; background: var(--ar-surface-2); font-family: var(--ar-mono); }
/* 等宽正文按**字符数**限宽：面板拉宽到上千像素时，一行 150 个字符没人读得舒服，
   84ch 是等宽正文常用的舒适上限 */
.ar_preview { margin: 0; padding: 12px; max-width: 84ch; border-radius: var(--ar-radius); border: 1px solid var(--ar-line); background: var(--ar-surface-2); font-family: var(--ar-mono); font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 55vh; overflow: auto; }

/* ---------- 更多 ---------- */
.ar_more { margin-top: 18px; border-top: 1px solid var(--ar-line); padding-top: 10px; }
.ar_more summary { cursor: pointer; font-size: 12px; color: var(--ar-text-dim); }
.ar_more summary:hover { color: var(--ar-text); }
.ar_moreBody { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
.ar_moreGroup { display: flex; flex-direction: column; gap: 6px; }
.ar_help { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.55; color: var(--ar-text-dim); display: flex; flex-direction: column; gap: 4px; }
.ar_filePath { font-size: 11.5px; color: var(--ar-text-dim); overflow-wrap: anywhere; font-family: var(--ar-mono); }
.ar_footError { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5534b); }
.ar_fileInput { display: none; }
`;

		// ------------------------------------------------------------ 插件注册

		const inject = ['slots'];

		/**
		 * 右侧栏页签的身份（与 Docker 容器面板同一套宿主契约）。
		 *
		 * - `id` 是这份实现在页签系统里的标识，**按契约就用包名**（文档原话：a package name is
		 *   the natural value），所以它和 `package.json` 的 name 一起改。
		 * - `kind` 是「打开哪种页面」的枚举；`dsh.sidebar-right.v1.<session>` 里持久化的正是它。
		 */
		const TAB_IMPL_ID = 'dsh-ian-rules';
		const TAB_KIND = 'ian-rules';
		/**
		 * 更名前历代的 kind（由新到旧）。**只为兼容一个真实场景**：用户升级前右侧栏里正开着这个
		 * 页签，持久化记录里存的是旧 kind，改名后那个页签就会变成孤儿（正文挂不上，只剩一句
		 * 「这类内容还没有可用的查看方式」）。这里给每个旧 kind 补一个**不带 `guide`** 的注册 ——
		 * 页面列表的条目由 `guide` 贡献，所以它不会多出一行「开发规则」，只让旧页签继续渲染。
		 * 等确认没有人的持久化记录里还留着旧 kind（下一个版本之后），删掉这一整块即可。
		 */
		const LEGACY_TAB_KINDS = ['agent-rules', 'dev-rules'];
		/** 兼容注册的实现 id：带旧 kind 后缀，既不复用当前 id（同一 id 二次注册会抛错），也能看出它是哪一代。 */
		const legacyTabImplId = (kind) => TAB_IMPL_ID + ':legacy-' + kind;

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;

			ctx.effect(() => {
				const style = document.createElement('style');
				style.setAttribute('data-plugin', 'ian-rules');
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => {
					if (style.parentNode) style.parentNode.removeChild(style);
				};
			}, 'ian-rules: 样式');

			// 右侧栏标签：像「Docker 容器」那样，在右侧栏的页面列表里出现一行「开发规则」，
			// 点开后在右列打开面板本身（tab 体注册进 sidebar.right.pane.tab）。
			// 服务可能比本插件晚出现，所以走 ctx.inject 等它，而不是硬依赖。
			ctx.inject(['sidebarRightTabs'], (injected) => {
				const tabs = injected.get('sidebarRightTabs');
				if (tabs === undefined) return;
				const panelBody = () => h(PanelBoundary, null, h(DevRulesPanel));
				// 注册一份「类型 + 正文」：`id` 既是页签实现的标识，也是正文注册的 key
				const registerPanel = (definition) => {
					const disposeType = tabs.register(definition);
					const disposeBody = slots.inject('sidebar.right.pane.tab', () =>
						slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, panelBody),
					);
					return () => {
						disposeBody();
						disposeType();
					};
				};
				const disposePanel = registerPanel({
					id: TAB_IMPL_ID,
					kind: TAB_KIND,
					priority: 'extension',
					title: () => '开发规则',
					guide: [
						{
							order: 95,
							title: () => '开发规则',
							description: () => '让 agent 按你的习惯干活：全局 + 按项目',
						},
					],
				});
				// 更名兼容：无 guide，所以页面列表不会多出一行（见 LEGACY_TAB_KINDS 的说明）
				const disposeLegacy = LEGACY_TAB_KINDS.map((kind) =>
					registerPanel({
						id: legacyTabImplId(kind),
						kind,
						priority: 'extension',
						title: () => '开发规则',
					}),
				);
				return () => {
					for (const dispose of disposeLegacy) dispose();
					disposePanel();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数内部件：只给测试用（与 dsh-docker 的 __pick/__overview 同类做法）。
		exports.__internal = {
			estimateTokens,
			mergeDocs,
			injectedSummary,
			resultSummary,
			resultSummaryOfScene,
			shouldShowFilters,
			canShortcutSave,
			isNewerRevision,
			limitsOf,
			sizeLabel,
			prettyPath,
			projectTabLabel,
			panelTabs,
			collectGroups,
			collectTags,
			splitTags,
			groupBuckets,
			matchesFilter,
			legacyRouteFor,
			callWithRouteFallback,
			validateDoc,
			shortVersion,
			isOperationTerminal,
			updatingLabel,
			capabilitiesOf,
			updateStatusOf,
			operationOf,
			failedOperation,
			failureMessage,
			updateNotice,
		};
		return module.exports;
	},
});
