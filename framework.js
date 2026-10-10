/**
 * clothesicon — 状态栏顶部的服装图标条（基于 maplebirch 框架）
 *
 * 数据模型（DoL 0.5.12.13 + Breeze b1.3.4 实测）：
 *   V.worn[slot]        当前穿着的服装对象；name === "naked" 表示空
 *   V.carried[slot]     脱下后随身拿着的服装对象
 *   V.wardrobe[slot]    卧室衣柜里该部位的服装数组；V.wardrobe.space 是容量
 *   setup.clothes[slot] 该部位的服装定义数组（iconFile 等字段只存在于定义里）
 *   连衣裙这类套装会在 upper 与 lower 各放一个同名实例，所以两个格子自然显示同一图标。
 *
 * 图标条注入 `CaptionAfterDescription` 区（StoryCaption 里 `<<caption_clamp>>` 之后、
 * `<div id="statmeters">` 之前），固定 5 格：上装 / 下装 / 袜子 / 鞋子 / 衣柜，
 * 前四格即使没穿也照样显示（空栏显示部位名），但**只有衣柜格可点**，其余四格纯展示。
 * 点衣柜格弹出悬浮页，按原版衣柜的 11 个页签顺序列出全部部位；点选某部位后该格高亮，
 * 第三行最右侧那格变成「脱下」，下方衣柜区固定两行高、超出就在容器内直接滚动，
 * 上方部位格不跟着滚。
 * 悬浮页高度写死：桌面 5 列、移动端 4 列，11 个部位 + 脱下恒为 3 行。
 *
 * 换装一律调用原版 widget（generalWearFromWardrobe / generalUndress / generalOn），
 * 不自己搬运对象，诅咒、套装、孕期、史莱姆等限制全部由原版判定。
 */
(() => {
	'use strict';

	if (window.clothesiconInstalled) return;

	const mb = window.maplebirch;
	const tool = mb && mb.get('tool');
	if (!tool) return;

	window.clothesiconInstalled = true;

	const P = 'ci';
	const NAKED = 'naked';
	const MAX_CACHE = 400;

	// 与原版衣柜页签同名、同顺序（游戏里没有外衣/私部页签，就不凭空造）
	const TAB_SLOTS = [
		['head', '头饰'], ['face', '面饰'], ['neck', '颈部'],
		['upper', '上装'], ['lower', '下装'],
		['under_upper', '内衣上装'], ['under_lower', '内衣下装'],
		['hands', '手饰'], ['handheld', '手持物品'], ['legs', '腿饰'], ['feet', '鞋子'],
	];

	// 图标条固定这几格 + 最右侧衣柜格；腿饰习惯叫袜子
	const BAR_SLOTS = [
		['upper', '上装'], ['lower', '下装'], ['legs', '袜子'], ['feet', '鞋子'],
	];

	const WARDROBE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="1.2"/><path d="M12 3v18M9.6 10.6v3M14.4 10.6v3"/></svg>';

	// 脱下：T 恤轮廓 + 向下的箭头
	const UNDRESS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 4.5 6.5 6 10l2.5-1.2V20h7V8.8L18 10l1.5-3.5L15 4a3 3 0 0 1-6 0Z"/><path d="M12 10.5v6M9.75 14.25 12 16.5l2.25-2.25"/></svg>';

	let panelOpen = false;
	let openSlot = null;
	let notice = '';
	let renderCount = 0;
	let lastError = null;
	const iconCache = new Map();

	const sc = () => mb.host.sugarcube.require();

	const esc = (text) => String(text).replace(/[&<>"']/g, (ch) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[ch]));

	const labelOf = (slot) => {
		const hit = TAB_SLOTS.find(([s]) => s === slot) || BAR_SLOTS.find(([s]) => s === slot);
		return hit ? hit[1] : slot;
	};

	/** 悬浮页要列的部位：原版衣柜那 11 个页签，且当前版本确实存在的 */
	function slots() {
		const V = window.V;
		if (!V || !V.worn) return [];
		return TAB_SLOTS.map(([s]) => s).filter(s => s in V.worn);
	}

	const wornItem = (V, slot) => {
		const item = V.worn[slot];
		return item && item.name !== NAKED ? item : null;
	};

	/** 在衣柜上下文中执行：强制 selectWardrobe() 指向卧室衣柜，与索引来源一致 */
	function inWardrobe(fn) {
		const V = window.V;
		const prev = V.wardrobe_location;
		V.wardrobe_location = 'wardrobe';
		try {
			return fn();
		} finally {
			V.wardrobe_location = prev;
		}
	}

	/** 执行一段 Twee，返回其产生的文字（原版用它报告穿不上、诅咒等原因） */
	function runTwee(source) {
		const holder = document.createElement('div');
		holder.appendChild(window.Wikifier.wikifyEval(source));
		return holder.textContent.replace(/\s+/g, ' ').trim();
	}

	function itemName(item) {
		if (!item || typeof item !== 'object') return '';
		return item.cn_name_cap || item.name_cap || item.name || '';
	}

	/** 复用原版 clothingicon widget 生成缩略图（含配饰层、配色滤镜） */
	function iconHTML(item, slot) {
		if (!item || item.name === NAKED) return '';
		const key = [slot, item.variable, item.name, item.colour, item.accessory_colour, item.pattern].join('|');
		let html = iconCache.get(key);
		if (html === undefined) {
			html = buildIcon(item, slot);
			if (iconCache.size > MAX_CACHE) iconCache.clear();
			iconCache.set(key, html);
		}
		return html;
	}

	function buildIcon(item, slot) {
		// 临时变量必须用 `_` 前缀在 Twee 中引用：`_ciIconItem` 才是 SugarCube 的临时变量写法。
		const temp = sc().State.temporary;
		temp.ciIconItem = item;
		const trySlot = (s) => {
			const holder = document.createElement('div');
			try {
				holder.appendChild(window.Wikifier.wikifyEval(`<<clothingicon _ciIconItem "${s}">>`));
			} catch (error) {
				return '';
			}
			return holder.querySelector('img') ? holder.innerHTML : '';
		};
		try {
			// 连衣裙这类套装在 lower 定义里 iconFile 是 "0"（下半身没有独立图），
			// 这时回退到另一格的图标，让上装/下装两格显示同一个套装图标。
			const sibling = slot === 'upper' ? 'lower' : (slot === 'lower' ? 'upper' : null);
			return trySlot(slot) || (sibling ? trySlot(sibling) : '');
		} finally {
			delete temp.ciIconItem;
		}
	}

	function title(item) {
		const name = itemName(item) || (item && item.name) || '???';
		const integrity = item && item.integrity != null ? ` ${Math.round(item.integrity)}%` : '';
		return esc(name + integrity);
	}

	function chip(item, slot, action, extraClass) {
		// action 传 null = 纯展示格（图标条上那四格），不带 data-ci，点不动。
		const act = action == null ? '' : ` data-${P}="${action}"`;
		const cls = `${P}-chip ${action == null ? `${P}-static` : ''} ${extraClass || ''}`.trim().replace(/\s+/g, ' ');
		const icon = iconHTML(item, slot);
		const inner = icon || esc(itemName(item).slice(0, 2)) || '·';
		return `<span class="${cls}"${act} title="${title(item)}">${inner}</span>`;
	}

	function nameChip(slot, label, action, extraClass) {
		const act = action == null ? '' : ` data-${P}="${action}"`;
		const cls = `${P}-chip ${P}-name ${action == null ? `${P}-static` : ''} ${extraClass || ''}`.trim().replace(/\s+/g, ' ');
		return `<span class="${cls}"${act} title="${esc(label)}（空）">${esc(label)}</span>`;
	}

	function wardrobeRows(V, slot) {
		const list = Array.isArray(V.wardrobe[slot]) ? V.wardrobe[slot] : [];
		const rows = list.map((item, index) => item && item.name !== NAKED
			? chip(item, slot, `wear:${slot}:${index}`, `${P}-opt`) : '');
		const carried = V.carried && V.carried[slot];
		if (carried && carried.name !== NAKED) {
			rows.push(chip(carried, slot, `on:${slot}`, `${P}-opt ${P}-carried`));
		}
		return rows.filter(Boolean).join('');
	}

	// ---------------------------------------------------------------- 图标条
	function barInner(V) {
		const cells = BAR_SLOTS.map(([slot, label]) => {
			const worn = slot in V.worn ? wornItem(V, slot) : null;
			return worn ? chip(worn, slot, null) : nameChip(slot, label, null);
		}).join('');
		return `<div id="${P}-bar" class="${P}-bar">${cells}`
			+ `<span class="${P}-chip ${P}-wardrobe" data-${P}="panel" title="衣柜">${WARDROBE_SVG}</span></div>`;
	}

	function render() {
		renderCount++;
		try {
			const V = window.V;
			if (!V || !V.worn || !V.wardrobe || !window.Wikifier) return '';
			if (panelOpen) drawPanel();
			return barInner(V);
		} catch (error) {
			lastError = error && error.stack ? error.stack : String(error);
			return '';
		}
	}

	function refreshBar() {
		const bar = document.getElementById(`${P}-bar`);
		if (bar && window.V) bar.outerHTML = barInner(window.V);
	}

	// ---------------------------------------------------------------- 悬浮页
	function panelNode() {
		return document.getElementById(`${P}-pop`);
	}

	function panelBody(V) {
		const cells = slots().map((slot) => {
			const sel = slot === openSlot ? `${P}-sel` : '';
			const worn = wornItem(V, slot);
			return worn ? chip(worn, slot, `slot:${slot}`, sel) : nameChip(slot, labelOf(slot), `slot:${slot}`, sel);
		});
		// 最后一格：脱下按钮，只在点选了部位后出现。用 CSS 把它钉在第三行最右侧，
		// 中间空出来的格子保持空白。
		if (openSlot) {
			const worn = wornItem(V, openSlot);
			const label = labelOf(openSlot);
			cells.push(`<span class="${P}-chip ${P}-undress${worn ? '' : ` ${P}-static ${P}-dim`}"`
				+ (worn ? ` data-${P}="off:${openSlot}"` : '')
				+ ` title="${esc(worn ? `脱下${label}` : `${label}（未穿着）`)}">${UNDRESS_SVG}</span>`);
		}
		const parts = [`<div class="${P}-cells">${cells.join('')}</div>`];
		if (openSlot) {
			parts.push(`<div class="${P}-detail">`
				+ `<div class="${P}-label">${esc(labelOf(openSlot))} 衣柜</div>`
				+ `<div class="${P}-grid">${wardrobeRows(V, openSlot) || `<span class="${P}-none">这里没有可穿的</span>`}</div>`
				+ `</div>`);
		}
		if (notice) parts.push(`<div class="${P}-notice">${esc(notice)}</div>`);
		return parts.join('');
	}

	function drawPanel() {
		const V = window.V;
		if (!V || !V.worn) return hidePanel();
		let mask = document.getElementById(`${P}-mask`);
		if (!mask) {
			mask = document.createElement('div');
			mask.id = `${P}-mask`;
			mask.className = `${P}-mask`;
			mask.dataset[P] = 'hide';
			document.body.appendChild(mask);
		}
		let pop = panelNode();
		if (!pop) {
			pop = document.createElement('div');
			pop.id = `${P}-pop`;
			pop.className = `${P}-pop`;
			// 弹窗自己是遮罩的子节点，得挂一个 no-op 动作，
			// 否则点弹窗空白处会 closest('[data-ci]') 命中遮罩而误关。
			pop.dataset[P] = 'keep';
		}
		if (pop.parentElement !== mask) mask.appendChild(pop);
		pop.innerHTML = `<div class="${P}-pophead"><span>衣柜</span>`
			+ `<span class="${P}-btn" data-${P}="hide">关闭</span></div>`
			+ `<div class="${P}-popbody">${panelBody(V)}</div>`;
		pop.style.display = '';
		document.getElementById(`${P}-mask`).style.display = '';
		// 弹窗宽度会被 `max-width:100%` 收窄（移动端尤其明显），
		// 所以格子尺寸不能只按 vw 算，得量真实渲染值再回写，行高与总高才跟着自适应。
		const first = pop.querySelector(`.${P}-cells .${P}-chip`);
		if (first && first.offsetWidth > 0) pop.style.setProperty(`--${P}-cell`, `${first.offsetWidth}px`);
	}

	function hidePanel() {
		panelOpen = false;
		const pop = panelNode();
		const mask = document.getElementById(`${P}-mask`);
		if (pop) pop.style.display = 'none';
		if (mask) mask.style.display = 'none';
	}

	// ---------------------------------------------------------------- 换装动作
	function act(source) {
		const V = window.V;
		let message = '';
		inWardrobe(() => {
			try {
				message = runTwee(source);
			} catch (error) {
				lastError = String(error && error.message || error);
				message = '换装失败：' + lastError;
			}
		});
		V.clothing_update = 1;
		notice = message;
		try {
			// 三个原版 widget 各管一块：立绘、"你穿着…"那段描述、魅力值
			runTwee('<<updatesidebarimg>><<updatesidebardescription>><<updateallure>>');
		} catch (error) {
			/* 侧栏刷新失败不影响换装结果 */
		}
	}

	function onClick(event) {
		const link = event.target.closest && event.target.closest(`[data-${P}]`);
		if (!link) return;
		if (!link.closest(`#${P}-bar`) && !link.closest(`#${P}-pop`) && !link.closest(`#${P}-mask`)) return;
		const V = window.V;
		if (!V) return;
		const parts = String(link.dataset[P] || '').split(':');
		const action = parts[0];
		event.preventDefault();
		notice = '';
		if (action === 'panel') {
			panelOpen = !panelOpen;
			if (!panelOpen) return hidePanel();
			openSlot = null;
		} else if (action === 'hide') {
			return hidePanel();
		} else if (action === 'slot') {
			openSlot = openSlot === parts[1] ? null : parts[1];
			panelOpen = true;
		} else if (action === 'wear') {
			const index = Number(parts[2]);
			if (Number.isInteger(index) && index >= 0) act(`<<generalWearFromWardrobe "${parts[1]}" ${index}>>`);
		} else if (action === 'off') {
			act(`<<generalUndress "wardrobe" "${parts[1]}">>`);
		} else if (action === 'on') {
			act(`<<generalOn "${parts[1]}">>`);
		} else {
			return;
		}
		if (panelOpen) drawPanel();
		refreshBar();
	}

	function onKey(event) {
		if (panelOpen && (event.key === 'Escape' || event.keyCode === 27)) {
			hidePanel();
			refreshBar();
		}
	}

	document.head.insertAdjacentHTML('beforeend', `<style>
#${P}-bar.ci-bar{--ci-gap:4px;box-sizing:border-box;display:flex;justify-content:center;align-items:center;gap:var(--ci-gap);width:100%;max-width:100%;margin:.45em 0 .35em;font-size:.75em;line-height:1.4;user-select:none;-webkit-tap-highlight-color:transparent}
#${P}-bar .${P}-chip{box-sizing:border-box;flex:0 1 auto;display:flex;align-items:center;justify-content:center;position:relative;width:clamp(34px,calc((100% - var(--ci-gap) * 4)/ 5),54px);aspect-ratio:1/1;overflow:hidden;border:1px solid rgba(255,255,255,.28);border-radius:4px;cursor:default;background:rgba(0,0,0,.25);color:inherit}
#${P}-bar .${P}-chip img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
#${P}-bar .${P}-name{font-size:1.2em;opacity:.7}
#${P}-bar .${P}-wardrobe svg{width:70%;height:70%}
#${P}-bar .${P}-wardrobe{border-color:rgba(255,255,255,.5);cursor:pointer}
.${P}-mask{position:fixed;inset:0;z-index:5000;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:8px;background:rgba(0,0,0,.55)}
.${P}-pop{--ci-cols:5;--ci-gap:8px;--ci-popW:min(94vw,420px);--ci-cell:calc((var(--ci-popW) - 34px - var(--ci-gap) * (var(--ci-cols) - 1)) / var(--ci-cols));position:relative;z-index:5001;box-sizing:border-box;width:var(--ci-popW);max-width:100%;max-height:100%;overflow:hidden;padding:1em 1.1em 1.2em;font-size:.95em;line-height:1.5;border:1px solid rgba(255,255,255,.3);border-radius:8px;background:#1c1c22;color:#eee;box-shadow:0 8px 28px rgba(0,0,0,.65);user-select:none;-webkit-tap-highlight-color:transparent}
.${P}-pop .${P}-popbody{box-sizing:border-box;height:min(calc(100vh - 170px), calc(var(--ci-cell) * 5 + var(--ci-gap) * 4 + 2.2em));/* 移动端 100vh 含被地址栏挡住的部分，可见高度要用 dvh */height:min(calc(100dvh - 170px), calc(var(--ci-cell) * 5 + var(--ci-gap) * 4 + 2.2em));display:flex;flex-direction:column;overflow:hidden}
.${P}-pop *{box-sizing:border-box;touch-action:manipulation}
.${P}-pophead{display:flex;justify-content:space-between;align-items:center;font-size:1.05em;font-weight:bold;margin-bottom:.75em}
.${P}-pop .${P}-cells{flex:0 0 auto;display:grid;grid-template-columns:repeat(var(--ci-cols),minmax(0,1fr));gap:var(--ci-gap)}
.${P}-pop .${P}-detail{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;margin-top:var(--ci-gap)}
.${P}-pop .${P}-chip{display:flex;align-items:center;justify-content:center;position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border:1px solid rgba(255,255,255,.28);border-radius:4px;cursor:pointer;background:rgba(255,255,255,.07);color:inherit}
.${P}-pop .${P}-chip img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.${P}-pop .${P}-name{font-size:.76em;line-height:1.15;opacity:.85;padding:2px;text-align:center}
.${P}-pop .${P}-undress{grid-column:-2 / -1}
.${P}-pop .${P}-undress svg{width:62%;height:62%}
.${P}-pop .${P}-sel{border-color:#fbd06a;box-shadow:0 0 0 2px rgba(251,208,106,.5),0 0 12px rgba(251,208,106,.35);background:rgba(251,208,106,.16)}
.${P}-pop .${P}-dim{opacity:.32}
.${P}-pop .${P}-static{cursor:default}
.${P}-pop .${P}-label{flex:0 0 auto;margin:.1em 0 .45em;opacity:.85}
.${P}-pop .${P}-grid{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:repeat(var(--ci-cols),minmax(0,1fr));grid-auto-rows:var(--ci-cell);gap:var(--ci-gap);align-content:start;overflow-y:auto;overscroll-behavior:contain;padding-right:3px}
.${P}-pop .${P}-none{grid-column:1 / -1;opacity:.6}
.${P}-btn{display:inline-flex;align-items:center;min-height:30px;padding:3px 13px;border:1px solid rgba(255,255,255,.3);border-radius:4px;cursor:pointer;background:rgba(255,255,255,.08);color:inherit}
.${P}-btn:active{background:rgba(255,255,255,.22)}
.${P}-notice{flex:0 0 auto;margin-top:.6em;color:#f7a;word-break:break-word}
@media (max-width:760px),(pointer:coarse){
.${P}-pop{--ci-cols:4;--ci-gap:10px;--ci-popW:min(96vw,440px);font-size:1em}
.${P}-btn{min-height:38px;padding:5px 16px}
}
</style>`);

	tool.addTo('CaptionAfterDescription', render);
	document.addEventListener('click', onClick);
	document.addEventListener('keyup', onKey);

	// ---------------------------------------------------------------- 诊断 / 调试台
	// 无参调用 = 打印诊断报告；带命令调用 = 直接驱动面板状态，方便在控制台里试布局。
	window.clothesicon_debug = (command, arg) => {
		if (typeof command === 'string') {
			if (command === 'open') { panelOpen = true; openSlot = arg || null; }
			else if (command === 'close') { hidePanel(); }
			else if (command === 'reset') { openSlot = null; notice = ''; }
			else return '未知命令：' + command;
			drawPanel();
			refreshBar();
			const state = { panelOpen, openSlot };
			console.log('[clothesicon]', JSON.stringify(state));
			return state;
		}
		const V = window.V;
		const lines = [];
		const push = (label, value) => lines.push(`${label}: ${value}`);
		push('maplebirch', mb.version || (mb.meta && mb.meta.version) || '未知');
		push('render 次数', String(renderCount) + (renderCount === 0 ? '  <- 区域从未被渲染' : ''));
		push('最近异常', lastError || '无');
		const bar = document.getElementById(`${P}-bar`);
		push('DOM #ci-bar', bar ? `存在，宽 ${bar.clientWidth}px` : '不存在');
		const pop = panelNode();
		push('悬浮页', pop && panelOpen ? `打开，openSlot=${openSlot}` : '关闭');
		if (pop && panelOpen) {
			const cell = pop.querySelector(`.${P}-cells .${P}-chip`);
			const grid = pop.querySelector(`.${P}-grid`);
			const cols = getComputedStyle(pop).getPropertyValue('--ci-cols').trim();
			push('  布局', cell && grid
				? `格 ${cell.offsetWidth}x${cell.offsetHeight}px，列 ${cols}，部位格 ${(pop.querySelectorAll(`.${P}-cells .${P}-chip`) || []).length}，衣柜可视高 ${grid.clientHeight}/${grid.scrollHeight}px，选中 ${(pop.querySelectorAll(`.${P}-sel`) || []).length}`
				: '（未选部位，无衣柜区）');
		}
		push('CaptionAfterDescription 注册数', String((tool.zone.data.CaptionAfterDescription || []).length));
		const all = slots();
		const equipped = all.filter(s => wornItem(V, s));
		push('已装备部位', equipped.map(labelOf).join(',') || '无');
		push('图标条', bar
			? `${bar.children.length - 1} 格固定 + 衣柜，宽 ${bar.clientWidth}px`
			: '不存在（区域没渲染）');
		if (V && V.worn) {
			for (const s of all) {
				const worn = V.worn[s];
				push(`  ${labelOf(s)}(${s})`, `穿=${worn && worn.name} 衣柜=${Array.isArray(V.wardrobe[s]) ? V.wardrobe[s].length : -1}`);
			}
		}
		const report = lines.join('\n');
		console.log('[clothesicon]\n' + report);
		return report;
	};

	mb.log('clothesicon 已加载', 'info');
})();
