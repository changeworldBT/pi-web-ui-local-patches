/**
 * model-schedule —— 客户端配置页。
 *
 * 设计原则：列头只出现一次，行内不重复小标签；说明性文字收进 title 提示；
 * 主 bot 与子 bot 共用同一套网格，保证纵向对齐。
 *
 *   - 顶部：标题 + 当前生效状态（一行）
 *   - 吸顶工具条：时区选择器 / 加窗口 / 展开收起 / 重读 / 保存（带未保存标记）
 *   - 每个时间窗一张可折叠卡片：窗口头（展开箭头 + 序号 + 时间摘要 + 生效中/永不生效标记 + 删除）、
 *     时间与星期一行、主 bot 一行、子 bot 表格（列头：模板/状态/模型/思考档）、子 bot 兜底一行
 *   - 子 bot 三态：继承（不写配置）/ 覆盖（写 model+thinking）/ 禁用（enabled:false）
 *
 * 本轮改动（v0.2.0）：
 *   1. 时区从自由文本输入换成**可搜索选择器**（Intl.supportedValuesOf 全量 IANA + 分组 +
 *      实时偏移/当地时间 + 「本机时区」快捷），彻底消灭手打错时区导致窗口全错位；
 *   2. 模型下拉换成可搜索组合框（52 个模型时原生 select 无法查找，且旧 label 重复完整 id）；
 *   3. 思考档下拉改中文（关闭/极简/低/中/高/极高/最大），保留括号内原始档位名；
 *   4. 星期加「工作日 / 周末 / 全选 / 清空」快捷；
 *   5. 窗口卡可折叠，当前生效窗口自动展开并高亮描边；
 *   6. 未保存修改有 dirty 标记 + 离开页面拦截 + 「重读」二次确认；
 *   7. 「永不生效」告警直接说明是被第几个窗口遮蔽的。
 */
/** 与 SDK defineView 同构的轻量校验包装（完整 SDK 顶层 import node:path，浏览器不可用）。 */
function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	return view;
}

/** 从 bundle 自己的 URL 推 API 前缀：<base>/plugins/model-schedule/client/entry.mjs → <base>/plugins-api/model-schedule */
function getApiBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/model-schedule\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins-api/model-schedule`;
	} catch {
		return "/plugins-api/model-schedule";
	}
}

const API_BASE = getApiBase();

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** 思考档中文名：界面其余部分全中文，下拉里不该只有 off/minimal/… */
const THINKING_LABELS = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
};
const DAY_CHIPS = [
	{ v: 1, label: "一" },
	{ v: 2, label: "二" },
	{ v: 3, label: "三" },
	{ v: 4, label: "四" },
	{ v: 5, label: "五" },
	{ v: 6, label: "六" },
	{ v: 0, label: "日" },
];
const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const HHMM_RE = /^([01]\d|2[0-4]):[0-5]\d$/;
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

/** 把 "HH:MM" 转成当天的分钟数；"24:00" → 1440。非法返回 null。 */
function toMin(v) {
	if (typeof v !== "string" || !HHMM_RE.test(v.trim())) return null;
	const [h, m] = v.trim().split(":").map(Number);
	return h * 60 + m;
}

/** 模型 id 去掉 provider 前缀（"magpie/zcode/x" → "zcode/x"），用于紧凑展示。 */
function shortId(id) {
	return String(id ?? "").replace(/^magpie\//, "");
}

/** id 是否比显示名多出信息（避免「GLM-5.3-Flash zcode/GLM-5.3-Flash」这种重复）。 */
function idAddsInfo(label, sid) {
	const last = String(sid).split("/").pop() || "";
	const norm = (s) => String(s).toLowerCase().replace(/[\s_()（）]/g, "");
	return norm(label) !== norm(last);
}

/**
 * 算出一个窗口实际覆盖的 (day, minute) 槽位集合（7×1440）。
 * 与扩展侧语义一致：start>end 为跨午夜，且归属 start 那一天。
 */
function windowSlots(win) {
	const slots = new Set();
	if (!win) return slots;
	const days = Array.isArray(win.days) && win.days.length ? win.days : [0, 1, 2, 3, 4, 5, 6];
	const s = toMin(win.start);
	const e = toMin(win.end);
	for (const d of days) {
		if (s === null && e === null) {
			for (let m = 0; m < 1440; m++) slots.add(d * 1440 + m);
			continue;
		}
		if (s !== null && e !== null && s > e) {
			for (let m = s; m < 1440; m++) slots.add(d * 1440 + m);
			const nd = (d + 1) % 7;
			for (let m = 0; m < e; m++) slots.add(nd * 1440 + m);
		} else {
			const a = s === null ? 0 : s;
			const b = e === null ? 1440 : e;
			for (let m = a; m < b; m++) slots.add(d * 1440 + m);
		}
	}
	return slots;
}

/**
 * 找出「永远命中不了」的窗口：前面的窗口已覆盖它的全部槽位。
 * 返回 { [index]: 原因文案 }，原因里点名是被第几个窗口遮蔽的（旧版只说"被前面的窗口覆盖"，用户无从下手）。
 */
function findShadowedWindows(windows) {
	const out = {};
	/** slot → 最早覆盖它的窗口下标 */
	const coveredBy = new Map();
	(windows || []).forEach((w, i) => {
		const mine = windowSlots(w);
		if (mine.size === 0) return;
		let allCovered = true;
		let firstBlocker = null;
		for (const slot of mine) {
			if (!coveredBy.has(slot)) {
				allCovered = false;
				break;
			}
			if (firstBlocker === null) firstBlocker = coveredBy.get(slot);
		}
		if (allCovered) {
			out[i] = `该窗口所有时段已被窗口 ${firstBlocker + 1} 覆盖，永远不会生效`;
		}
		for (const slot of mine) if (!coveredBy.has(slot)) coveredBy.set(slot, i);
	});
	return out;
}

/** 窗口的时间摘要文案，用于卡片头。 */
function windowSummary(win) {
	const s = win.start || "";
	const e = win.end || "";
	let time;
	if (!s && !e) time = "全天";
	else if (!s) time = `00:00–${e}`;
	else if (!e) time = `${s}–24:00`;
	else time = `${s}–${e}`;
	const days = Array.isArray(win.days) && win.days.length ? win.days : null;
	if (!days) return `${time} · 每天`;
	if (days.length === 7) return `${time} · 每天`;
	if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return `${time} · 工作日`;
	if (days.length === 2 && WEEKEND.every((d) => days.includes(d))) return `${time} · 周末`;
	return `${time} · ${days.map((d) => DAY_NAMES[d]).join("")}`;
}

// ------------------------------------------------------------ 时区工具

/** 全量 IANA 时区（浏览器原生，零依赖）；不支持时回退到常用清单。 */
const FALLBACK_TZ = [
	"UTC",
	"Asia/Shanghai",
	"Asia/Hong_Kong",
	"Asia/Taipei",
	"Asia/Tokyo",
	"Asia/Seoul",
	"Asia/Singapore",
	"Asia/Bangkok",
	"Asia/Kolkata",
	"Asia/Dubai",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Europe/Moscow",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Sao_Paulo",
	"Australia/Sydney",
	"Pacific/Auckland",
];
let _tzCache = null;
function allTimezones() {
	if (_tzCache) return _tzCache;
	let list = [];
	try {
		if (typeof Intl.supportedValuesOf === "function") list = Intl.supportedValuesOf("timeZone") || [];
	} catch {
		list = [];
	}
	if (!Array.isArray(list) || list.length === 0) list = FALLBACK_TZ.slice();
	if (!list.includes("UTC")) list = ["UTC", ...list];
	return (_tzCache = list);
}

/** 机器所在时区（用于「本机时区」快捷按钮）。 */
function localTimezone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** UTC 偏移文案，如 "GMT+8"；非法时区返回空串。 */
function tzOffsetLabel(tz) {
	try {
		const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(
			new Date(),
		);
		const v = parts.find((p) => p.type === "timeZoneName")?.value || "";
		return v.replace(/^GMT\+?0?0:00$/, "GMT").replace(/^GMT/, "UTC");
	} catch {
		return "";
	}
}

/** 该时区的当前时间（HH:MM），用于让用户一眼确认时区填对了。 */
function tzNowLabel(tz) {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: tz,
			hourCycle: "h23",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date());
	} catch {
		return "";
	}
}

/** 时区分组：常用置顶，其余按 IANA 区域前缀归并成中文组名。 */
const REGION_LABELS = {
	Asia: "亚洲",
	Europe: "欧洲",
	America: "美洲",
	Africa: "非洲",
	Australia: "大洋洲",
	Pacific: "太平洋",
	Atlantic: "大西洋",
	Indian: "印度洋",
	Antarctic: "南极",
	Arctic: "北极",
	Etc: "其他 / UTC",
	US: "美洲（旧式）",
	Canada: "美洲（旧式）",
	Mexico: "美洲（旧式）",
	Brazil: "美洲（旧式）",
	Chile: "美洲（旧式）",
};
const PINNED_TZ = [
	"Asia/Shanghai",
	"Asia/Hong_Kong",
	"Asia/Taipei",
	"Asia/Tokyo",
	"Asia/Singapore",
	"UTC",
	"Europe/London",
	"Europe/Berlin",
	"America/New_York",
	"America/Los_Angeles",
	"Australia/Sydney",
];

function tzGroupOf(tz) {
	if (tz === "UTC") return "常用";
	const region = String(tz).split("/")[0];
	return REGION_LABELS[region] || "其他";
}

const CSS = `
.ms-wrap { max-width: 900px; margin: 0 auto; padding: 4px 4px 60px; color: #d7dae0; font-size: 13px; line-height: 1.5; }
.ms-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.ms-head h2 { font-size: 15px; margin: 0; color: #e8ebf0; font-weight: 600; }
.ms-head .ms-now { color: #8a919e; font-size: 12px; }
.ms-head .ms-now b { color: #cfe0ff; font-weight: 600; }
.ms-banner { border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 12.5px; display: none; }
.ms-banner.ok { display: block; background: #16321f; border: 1px solid #2f6b40; color: #9fe0b5; }
.ms-banner.err { display: block; background: #38191c; border: 1px solid #7a3038; color: #f0a5a5; white-space: pre-wrap; }
.ms-banner.warn { display: block; background: #362c14; border: 1px solid #6b5a20; color: #e8d38a; }
.ms-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 0; margin-bottom: 8px; position: sticky; top: 0; z-index: 6; background: #0b0d11; border-bottom: 1px solid #1d222b; }
.ms-toolbar .ms-spacer { flex: 1; }
.ms-toolbar label { font-size: 11.5px; color: #8a919e; }
.ms-tz-now { font-size: 11.5px; color: #7f8794; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ms-tz-now b { color: #a9c4f5; font-weight: 600; }
.ms-dirty { font-size: 11.5px; color: #e8b06a; display: none; align-items: center; gap: 4px; }
.ms-dirty.on { display: inline-flex; }
.ms-card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
.ms-card-shadowed { border-color: #6b4a1f; background: #1a1611; }
.ms-card-current { border-color: #4c6ef5; box-shadow: 0 0 0 1px rgba(76,110,245,.45) inset, 0 2px 12px rgba(76,110,245,.12); }
.ms-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ms-card-head.ms-clickable { cursor: pointer; user-select: none; margin-bottom: 0; }
.ms-card-head.ms-clickable:hover .ms-title { color: #fff; }
.ms-card.ms-open .ms-card-head { margin-bottom: 10px; }
.ms-chev { color: #6f7683; font-size: 10px; width: 10px; flex: 0 0 10px; }
.ms-card-head .ms-title { font-size: 13px; font-weight: 600; color: #e8ebf0; white-space: nowrap; }
.ms-card-head .ms-sum { font-size: 12px; color: #8a919e; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-card-head .ms-spacer { flex: 1; }
.ms-tag { font-size: 10.5px; font-weight: 600; color: #f0b060; border: 1px solid #6b4a1f; background: #2a1f10; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
.ms-tag.live { color: #9fe0b5; border-color: #2f6b40; background: #16321f; }
.ms-card-body { display: none; }
.ms-card.ms-open .ms-card-body { display: block; }
.ms-shadow-hint { font-size: 11.5px; color: #e8b06a; background: #2a1f10; border: 1px solid #6b4a1f; border-radius: 6px; padding: 5px 9px; margin-bottom: 10px; }
.ms-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ms-inline > label { font-size: 11.5px; color: #8a919e; }
.ms-sep { color: #4a515e; }
.ms-chips { display: flex; gap: 3px; }
.ms-chip { border: 1px solid #2c3340; background: #0f1115; color: #8a919e; border-radius: 5px; padding: 2px 7px; font-size: 11.5px; cursor: pointer; user-select: none; }
.ms-chip.on { background: #24304a; border-color: #7aa2f7; color: #cfe0ff; }
.ms-dayquick { display: flex; gap: 4px; margin-left: 2px; }
.ms-dayquick button { background: none; border: 1px solid #2c3340; color: #7f8794; border-radius: 5px; padding: 1px 6px; font-size: 11px; cursor: pointer; }
.ms-dayquick button:hover { color: #cfe0ff; border-color: #3a4a6d; background: #1b2230; }
.ms-input, .ms-select { background: #0f1115; color: #d7dae0; border: 1px solid #2c3340; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; outline: none; min-width: 0; }
.ms-input:focus, .ms-select:focus { border-color: #7aa2f7; }
.ms-input.ms-time { width: 108px; font-variant-numeric: tabular-nums; }
.ms-btn { background: #24304a; color: #cfe0ff; border: 1px solid #3a4a6d; border-radius: 7px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
.ms-btn:hover { background: #2c3b5c; }
.ms-btn:disabled { opacity: .55; cursor: default; }
.ms-btn.primary { background: #3b5bdb; border-color: #4c6ef5; color: #fff; }
.ms-btn.primary:hover { background: #4263eb; }
.ms-btn.danger { background: transparent; border-color: #5c3a3a; color: #e08e8e; padding: 3px 9px; font-size: 11.5px; }
.ms-btn.danger:hover { background: #3a2525; }
.ms-btn.mini { padding: 4px 10px; font-size: 11.5px; }
.ms-grid { display: grid; grid-template-columns: minmax(104px, 1fr) 88px minmax(150px, 1.9fr) 100px 30px; gap: 8px; align-items: center; }
.ms-grid-head { padding: 4px 0; margin-top: 2px; border-bottom: 1px solid #262b36; }
.ms-grid-head span { font-size: 11px; color: #6f7683; }
.ms-grid-row { padding: 4px 0; }
.ms-grid-row + .ms-grid-row { border-top: 1px solid #1d222b; }
.ms-grid-row .ms-name { font-size: 12.5px; color: #d7dae0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-grid-row .ms-name.main { color: #cfe0ff; font-weight: 600; }
.ms-grid-row .ms-name.def { color: #aeb6c2; font-weight: 600; }
.ms-grid .ms-select, .ms-grid .ms-combo { width: 100%; box-sizing: border-box; }
.ms-grid .ms-na { color: #3f4653; font-size: 12px; text-align: center; }
.ms-section { margin-top: 12px; }
.ms-section-head { font-size: 11.5px; color: #8a919e; margin-bottom: 2px; }
.ms-expand { background: none; border: none; color: #7aa2f7; font-size: 11.5px; cursor: pointer; padding: 6px 0 0; }
.ms-expand:hover { text-decoration: underline; }
.ms-x { background: none; border: none; color: #6f7683; font-size: 15px; line-height: 1; cursor: pointer; padding: 0 2px; border-radius: 4px; }
.ms-x:hover { color: #e08e8e; background: #2a1a1a; }
.ms-loading { color: #8a919e; padding: 24px 0; text-align: center; }
/* 组合框（可搜索下拉） */
.ms-combo { display: flex; align-items: center; gap: 6px; background: #0f1115; color: #d7dae0; border: 1px solid #2c3340; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; cursor: pointer; text-align: left; min-width: 0; font-family: inherit; }
.ms-combo:hover { border-color: #3a4a6d; }
.ms-combo-open, .ms-combo:focus { border-color: #7aa2f7; outline: none; }
.ms-combo .ms-combo-val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-combo .ms-combo-sub { color: #6f7683; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
.ms-combo .ms-combo-ph { color: #5f6673; }
.ms-combo .ms-caret { margin-left: auto; color: #5f6673; font-size: 9px; flex: 0 0 auto; }
.ms-pop { position: fixed; z-index: 9999; width: 320px; max-width: calc(100vw - 16px); max-height: 340px; display: flex; flex-direction: column; background: #12151b; border: 1px solid #2c3340; border-radius: 9px; box-shadow: 0 12px 32px rgba(0,0,0,.6); overflow: hidden; }
.ms-pop-search { margin: 8px; padding: 6px 8px; background: #0b0d11; border: 1px solid #2c3340; border-radius: 6px; color: #d7dae0; font-size: 12.5px; outline: none; font-family: inherit; }
.ms-pop-search:focus { border-color: #7aa2f7; }
.ms-pop-list { overflow-y: auto; padding: 0 4px 6px; }
.ms-pop-group { font-size: 10.5px; color: #5f6673; padding: 8px 8px 3px; text-transform: uppercase; letter-spacing: .04em; }
.ms-pop-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; color: #d7dae0; }
.ms-pop-item:hover { background: #1b2230; }
.ms-pop-item.on { background: #24304a; color: #cfe0ff; }
.ms-pop-item .ms-pop-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-pop-item .ms-pop-sub { margin-left: auto; color: #6f7683; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: 0 0 auto; }
.ms-pop-empty { padding: 14px 8px; text-align: center; color: #5f6673; font-size: 12px; }
.ms-pop-foot { border-top: 1px solid #262b36; padding: 6px; display: flex; gap: 6px; }
.ms-pop-foot button { flex: 1; background: #1b2230; border: 1px solid #2c3340; color: #cfe0ff; border-radius: 6px; padding: 5px 8px; font-size: 11.5px; cursor: pointer; }
.ms-pop-foot button:hover { background: #24304a; }
@media (max-width: 760px) {
	.ms-grid { grid-template-columns: minmax(88px, 1fr) 78px minmax(110px, 1.4fr) 92px 26px; gap: 6px; }
	.ms-input.ms-time { width: 96px; }
	.ms-card-head .ms-sum { display: none; }
}
`;

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** 扁平下拉。 */
function flatSelect(options, value, cls) {
	const s = el("select", cls || "ms-select");
	for (const o of options) {
		const opt = document.createElement("option");
		opt.value = o.value;
		opt.textContent = o.label;
		if (o.value === value) opt.selected = true;
		s.appendChild(opt);
	}
	return s;
}

/**
 * 模型下拉分组键：id 形如 "magpie/workbuddy/deepseek-v4.1-flash"。
 * 第一段对所有模型都一样，取第二段作为组名（auto / zcode / workbuddy …）。
 */
function groupKeyOf(id) {
	const parts = String(id).split("/").filter(Boolean);
	if (parts.length === 0) return "其他";
	if (parts.length === 1) return parts[0];
	return parts[1];
}

// ------------------------------------------------------------ 浮动弹层（可搜索下拉的公共壳）

/** 当前打开的弹层；同一时刻只允许一个。 */
let activePopup = null;

function closePopup() {
	if (!activePopup) return;
	const p = activePopup;
	activePopup = null;
	try {
		p.cleanup();
	} catch {
		/* ignore */
	}
	p.el.remove();
	p.anchor?.classList.remove("ms-combo-open");
}

/**
 * 弹层挂载点：默认 document.body；若视图被宿主隔离进 Shadow DOM，
 * 则挂到同一个 shadow root 并把样式表复制进去（否则弹层会丢样式）。
 */
function popupHost(container) {
	try {
		const root = container?.getRootNode?.();
		if (root && root !== document && root.nodeType === 11) return root;
	} catch {
		/* ignore */
	}
	return document.body;
}

function openPopup(anchor, host, build) {
	closePopup();
	const pop = el("div", "ms-pop");
	build(pop, closePopup);
	host.appendChild(pop);

	// 定位：默认贴 anchor 下方，空间不足翻到上方，左右夹在视口内。
	const r = anchor.getBoundingClientRect();
	const pw = pop.offsetWidth || 320;
	const ph = pop.offsetHeight || 300;
	let left = Math.min(r.left, window.innerWidth - pw - 8);
	left = Math.max(8, left);
	let top = r.bottom + 4;
	if (top + ph > window.innerHeight - 8) {
		const above = r.top - ph - 4;
		top = above >= 8 ? above : Math.max(8, window.innerHeight - ph - 8);
	}
	pop.style.left = `${Math.round(left)}px`;
	pop.style.top = `${Math.round(top)}px`;

	const onDown = (ev) => {
		if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
		closePopup();
	};
	const onKey = (ev) => {
		if (ev.key === "Escape") {
			ev.stopPropagation();
			closePopup();
		}
	};
	const onScroll = (ev) => {
		if (!pop.contains(ev.target)) closePopup();
	};
	document.addEventListener("pointerdown", onDown, true);
	document.addEventListener("keydown", onKey, true);
	window.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", closePopup);
	activePopup = {
		el: pop,
		anchor,
		cleanup() {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", closePopup);
		},
	};
	anchor.classList.add("ms-combo-open");
}

/** 弹层里的一行：主文案 + 右侧次要信息。 */
function popItem(main, sub, isOn, title) {
	const it = el("div", "ms-pop-item" + (isOn ? " on" : ""));
	it.appendChild(el("span", "ms-pop-main", main));
	if (sub) it.appendChild(el("span", "ms-pop-sub", sub));
	if (title) it.title = title;
	return it;
}

// ------------------------------------------------------------ 具体组件

/**
 * 可搜索模型下拉。原生 <select> 在 50+ 模型时无法查找，且旧实现把完整 id
 * 重复进 label 导致下拉宽度爆炸；这里换成按钮 + 浮层（全量搜索 + 按 provider 分组）。
 */
function modelCombo(models, value, opts = {}, host) {
	const { emptyLabel = "（继承）", onChange } = opts;
	const btn = el("button", "ms-combo");
	btn.type = "button";
	const known = new Map((models || []).map((m) => [m.id, m]));
	let cur = value || "";

	function paint() {
		btn.textContent = "";
		btn.title = cur ? cur : emptyLabel;
		if (!cur) {
			btn.appendChild(el("span", "ms-combo-ph", emptyLabel));
		} else {
			const m = known.get(cur);
			const sid = shortId(cur);
			btn.appendChild(el("span", "ms-combo-val", m ? m.label : sid));
			// 只在 id 尾段与显示名确实不同时补 id，否则「GLM-5.3-Flash zcode/GLM-5.3-Flash」这种重复很吵。
			if (m && idAddsInfo(m.label, sid)) btn.appendChild(el("span", "ms-combo-sub", sid));
		}
		btn.appendChild(el("span", "ms-caret", "▼"));
	}
	paint();

	btn.addEventListener("click", () => {
		openPopup(btn, host, (pop, close) => {
			const search = el("input", "ms-pop-search");
			search.type = "search";
			search.placeholder = "搜索模型名 / id / 分组…";
			pop.appendChild(search);
			const list = el("div", "ms-pop-list");
			pop.appendChild(list);

			const pick = (v) => {
				cur = v;
				paint();
				onChange?.(v);
				close();
			};

			const rebuild = () => {
				list.textContent = "";
				const q = search.value.trim().toLowerCase();
				if (!q) {
					const it = popItem(emptyLabel, "", cur === "", "不覆盖，跟随上一级配置");
					it.addEventListener("click", () => pick(""));
					list.appendChild(it);
				}
				const groups = new Map();
				for (const m of models || []) {
					const hay = `${m.label} ${m.id}`.toLowerCase();
					if (q && !hay.includes(q)) continue;
					const g = groupKeyOf(m.id);
					if (!groups.has(g)) groups.set(g, []);
					groups.get(g).push(m);
				}
				if (groups.size === 0) {
					list.appendChild(el("div", "ms-pop-empty", "没有匹配的模型"));
					return;
				}
				for (const [g, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
					list.appendChild(el("div", "ms-pop-group", `${g}（${items.length}）`));
					for (const m of items) {
						const it = popItem(m.label, shortId(m.id), m.id === cur, m.id);
						it.addEventListener("click", () => pick(m.id));
						list.appendChild(it);
					}
				}
			};
			search.addEventListener("input", rebuild);
			search.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					const first = list.querySelector(".ms-pop-item");
					if (first) first.click();
				}
			});
			rebuild();
			setTimeout(() => search.focus(), 0);
		});
	});

	return btn;
}

/**
 * 时区选择器：全量 IANA + 分组 + 实时偏移与当地时间 + 「本机时区」快捷。
 * 旧版是自由文本输入，用户必须背 Asia/Shanghai，打错就整表错位且无任何提示。
 */
function timezoneCombo(current, opts = {}, host) {
	const { onChange } = opts;
	const btn = el("button", "ms-combo");
	btn.type = "button";
	let cur = current || "";
	const local = localTimezone();

	function paint() {
		btn.textContent = "";
		if (!cur) {
			btn.appendChild(el("span", "ms-combo-ph", "未设置（按 UTC 计算）"));
		} else {
			btn.appendChild(el("span", "ms-combo-val", cur));
			const off = tzOffsetLabel(cur);
			if (off) btn.appendChild(el("span", "ms-combo-sub", off));
		}
		btn.appendChild(el("span", "ms-caret", "▼"));
		btn.title = cur ? `${cur} · ${tzOffsetLabel(cur)} · 当地 ${tzNowLabel(cur)}` : "未设置时区，窗口按 UTC 计算";
	}
	paint();

	btn.addEventListener("click", () => {
		openPopup(btn, host, (pop, close) => {
			const search = el("input", "ms-pop-search");
			search.type = "search";
			search.placeholder = "搜索时区（如 shanghai / tokyo / 东京）…";
			pop.appendChild(search);
			const list = el("div", "ms-pop-list");
			pop.appendChild(list);
			const foot = el("div", "ms-pop-foot");
			const localBtn = el("button", null, `使用本机时区（${local}）`);
			localBtn.type = "button";
			localBtn.addEventListener("click", () => pick(local));
			foot.appendChild(localBtn);
			pop.appendChild(foot);

			const pick = (tz) => {
				cur = tz;
				paint();
				onChange?.(tz);
				close();
			};

			const rebuild = () => {
				list.textContent = "";
				const q = search.value.trim().toLowerCase();
				const all = allTimezones();
				const groups = new Map();
				for (const tz of all) {
					const g = PINNED_TZ.includes(tz) ? "常用" : tzGroupOf(tz);
					if (q) {
						const hay = `${tz} ${g}`.toLowerCase();
						if (!hay.includes(q)) continue;
					}
					if (!groups.has(g)) groups.set(g, []);
					groups.get(g).push(tz);
				}
				if (groups.size === 0) {
					list.appendChild(el("div", "ms-pop-empty", "没有匹配的时区"));
					return;
				}
				const order = ["常用", ...Object.values(REGION_LABELS), "其他"];
				const keys = [...groups.keys()].sort((a, b) => {
					const ia = order.indexOf(a);
					const ib = order.indexOf(b);
					return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
				});
				for (const g of keys) {
					list.appendChild(el("div", "ms-pop-group", g));
					for (const tz of groups.get(g)) {
						const off = tzOffsetLabel(tz);
						const now = tzNowLabel(tz);
						const sub = [off, now].filter(Boolean).join(" ");
						const it = popItem(tz, sub, tz === cur, `${tz} · ${off} · 当地 ${now}`);
						it.addEventListener("click", () => pick(tz));
						list.appendChild(it);
					}
				}
			};
			search.addEventListener("input", rebuild);
			search.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					const first = list.querySelector(".ms-pop-item");
					if (first) first.click();
				}
			});
			rebuild();
			setTimeout(() => search.focus(), 0);
		});
	});

	return btn;
}

/** 思考档下拉：中文名 + 括号内原始档位（配置里写的是原始值，保留可读性）。 */
function thinkingSelect(current, cls) {
	const opts = [{ value: "", label: "（继承）" }];
	for (const lv of THINKING_LEVELS) opts.push({ value: lv, label: `${THINKING_LABELS[lv]}（${lv}）` });
	if (current && !THINKING_LEVELS.includes(current)) opts.push({ value: current, label: `${current}（非法）` });
	const s = flatSelect(opts, current || "", cls);
	s.title = "思考强度档位；不同模型支持的档位不同";
	return s;
}

function stateSelect(current, cls) {
	return flatSelect(
		[
			{ value: "inherit", label: "继承" },
			{ value: "override", label: "覆盖" },
			{ value: "disabled", label: "禁用" },
		],
		current,
		cls,
	);
}

export default defineView({
	mount(container, ctx) {
		const style = document.createElement("style");
		style.textContent = CSS;
		container.appendChild(style);

		const wrap = el("div", "ms-wrap");
		wrap.innerHTML = `<div class="ms-loading">加载中…</div>`;
		container.appendChild(wrap);

		const host = popupHost(container);
		// 视图被隔离进 Shadow DOM 时，弹层挂到了 shadow root，样式得再塞一份进去。
		if (host !== document.body && !host.querySelector?.("style[data-ms-pop]")) {
			const s2 = document.createElement("style");
			s2.setAttribute("data-ms-pop", "1");
			s2.textContent = CSS;
			host.appendChild(s2);
		}

		const state = {
			config: null,
			models: [],
			agents: null,
			exists: true,
			/** 有未保存修改 */
			dirty: false,
			/** 当前生效窗口下标（-1 = default） */
			effectiveIndex: -1,
		};
		/** 哪些卡片展开了「继承中」的子 bot 行。 */
		const expandedSets = Object.create(null);
		let subKeySeq = 0;
		const subKeys = new WeakMap();
		function subKey(sub) {
			let k = subKeys.get(sub);
			if (!k) {
				k = `s${++subKeySeq}`;
				subKeys.set(sub, k);
			}
			return k;
		}
		/** 卡片折叠状态（按配置对象身份记，重绘不丢）。 */
		const cardOpen = new WeakMap();
		function isOpen(obj) {
			return cardOpen.get(obj) === true;
		}
		function setOpen(obj, v) {
			cardOpen.set(obj, v);
		}

		async function fetchJson(url, opts) {
			const res = await fetch(url, opts);
			let body = null;
			try {
				body = await res.json();
			} catch {
				/* 非 JSON 响应体 */
			}
			return { ok: res.ok, status: res.status, body };
		}

		function markDirty() {
			state.dirty = true;
			const chip = wrap.querySelector(".ms-dirty");
			if (chip) chip.classList.add("on");
		}
		function clearDirty() {
			state.dirty = false;
			const chip = wrap.querySelector(".ms-dirty");
			if (chip) chip.classList.remove("on");
		}

		// ------------------------------------------------------------ 状态条

		function renderEffective(data) {
			const box = wrap.querySelector(".ms-now");
			if (!box) return;
			box.textContent = "";
			const body = data?.body;
			if (!data?.ok || !body?.ok) {
				box.textContent = "生效状态获取失败";
				return;
			}
			const win = body.window;
			const label = body.matched === "default" ? "兜底" : "窗口";
			box.appendChild(document.createTextNode(`${body.localTime} · ${label} `));
			const b = el("b", null, win ? windowSummary(win) : "default");
			box.appendChild(b);
			if (win?.main?.model) {
				box.appendChild(document.createTextNode(` · ${shortId(win.main.model)}`));
			}
			// 当前生效窗口下标变了就刷新卡片高亮
			const nextIdx = typeof body.windowIndex === "number" ? body.windowIndex : body.matched === "default" ? -1 : -2;
			if (nextIdx !== state.effectiveIndex) {
				state.effectiveIndex = nextIdx;
				refreshHighlight();
			}
		}

		/** 只刷新卡片的「生效中」高亮与描边，不重建 DOM。 */
		function refreshHighlight() {
			const cards = wrap.querySelectorAll(".ms-card[data-idx]");
			for (const card of cards) {
				const idx = Number(card.getAttribute("data-idx"));
				const isCur = idx === state.effectiveIndex;
				card.classList.toggle("ms-card-current", isCur);
				const tag = card.querySelector(".ms-tag.live");
				if (isCur && !tag) {
					const t = el("span", "ms-tag live", "生效中");
					t.title = "当前时段命中的就是这个窗口";
					const head = card.querySelector(".ms-card-head");
					const spacer = head?.querySelector(".ms-spacer");
					if (spacer) head.insertBefore(t, spacer);
				} else if (!isCur && tag) {
					tag.remove();
				}
			}
		}

		// ------------------------------------------------------------ 行构造

		/** 主 bot 行：名称列固定「主 bot」，状态列留空。 */
		function mainRow(target, labelText, isDefault) {
			const row = el("div", "ms-grid ms-grid-row");
			row.appendChild(el("div", "ms-name" + (isDefault ? " def" : " main"), labelText));
			row.appendChild(el("div", "ms-na", "—"));
			const mSel = modelCombo(
				state.models,
				target.model,
				{
					onChange: (v) => {
						if (v) target.model = v;
						else delete target.model;
						markDirty();
					},
				},
				host,
			);
			row.appendChild(mSel);
			const tSel = thinkingSelect(target.thinking);
			tSel.addEventListener("change", () => {
				if (tSel.value) target.thinking = tSel.value;
				else delete target.thinking;
				markDirty();
			});
			row.appendChild(tSel);
			row.appendChild(el("div"));
			return row;
		}

		/** 子 bot 行：模板名 / 三态 / 模型 / 思考档 / 删除。 */
		function templateRow(sub, name, label, description, isUnknown) {
			const entry = sub.agents[name];
			const stateVal = !entry ? "inherit" : entry.enabled === false ? "disabled" : "override";
			const row = el("div", "ms-grid ms-grid-row");

			const nameCell = el("div", "ms-name", label + (isUnknown ? " ⚠" : ""));
			if (description) nameCell.title = description;
			row.appendChild(nameCell);

			const st = stateSelect(stateVal, "ms-state-sel");
			row.appendChild(st);

			const modelCell = el("div");
			const thinkCell = el("div");
			if (stateVal === "override") {
				const mSel = modelCombo(
					state.models,
					entry?.model,
					{
						onChange: (v) => {
							const e = (sub.agents[name] ||= {});
							delete e.enabled;
							if (v) e.model = v;
							else delete e.model;
							markDirty();
						},
					},
					host,
				);
				modelCell.appendChild(mSel);
				const tSel = thinkingSelect(entry?.thinking);
				tSel.addEventListener("change", () => {
					const e = (sub.agents[name] ||= {});
					delete e.enabled;
					if (tSel.value) e.thinking = tSel.value;
					else delete e.thinking;
					markDirty();
				});
				thinkCell.appendChild(tSel);
			} else {
				modelCell.appendChild(el("div", "ms-na", stateVal === "disabled" ? "不启用" : "—"));
				thinkCell.appendChild(el("div", "ms-na", "—"));
			}
			row.appendChild(modelCell);
			row.appendChild(thinkCell);

			st.addEventListener("change", () => {
				if (st.value === "inherit") delete sub.agents[name];
				else if (st.value === "disabled") sub.agents[name] = { enabled: false };
				else {
					const e = (sub.agents[name] ||= {});
					delete e.enabled;
				}
				markDirty();
				refreshBody();
			});

			const del = el("button", "ms-x", "×");
			del.type = "button";
			del.title = "清除该模板的配置（回到继承）";
			del.addEventListener("click", () => {
				delete sub.agents[name];
				markDirty();
				refreshBody();
			});
			row.appendChild(del);
			return row;
		}

		/** 列头，每个卡片一次。 */
		function gridHead() {
			const head = el("div", "ms-grid ms-grid-head");
			for (const t of ["模板", "状态", "模型", "思考档", ""]) head.appendChild(el("span", null, t));
			return head;
		}

		/** 子 bot 区：已配置常驻，继承中折叠。 */
		function renderSubagents(parent, sub) {
			parent.textContent = "";
			if (!sub) return;
			if (!sub.agents) sub.agents = {};

			const list = state.agents && state.agents.length ? state.agents : [];
			const seen = new Set();
			const known = [];
			for (const t of list) {
				seen.add(t.id);
				known.push({ name: t.id, label: t.label, description: t.description, unknown: false });
			}
			for (const name of Object.keys(sub.agents)) {
				if (!seen.has(name)) known.push({ name, label: name, description: "配置中存在但当前模板清单未列出", unknown: true });
			}

			const isActive = (name) => {
				const e = sub.agents[name];
				return !!e && (e.enabled === false || e.model || e.thinking);
			};
			const activeRows = known.filter((k) => isActive(k.name));
			const idleRows = known.filter((k) => !isActive(k.name));

			parent.appendChild(gridHead());
			for (const k of activeRows) {
				parent.appendChild(templateRow(sub, k.name, k.label, k.description, k.unknown));
			}

			if (idleRows.length > 0) {
				const key = subKey(sub);
				const expanded = !!expandedSets[key];
				const toggle = el(
					"button",
					"ms-expand",
					expanded ? `▾ 收起（${idleRows.length} 个继承中）` : `▸ 添加 / 修改子 bot（${idleRows.length} 个继承中）`,
				);
				toggle.type = "button";
				toggle.addEventListener("click", () => {
					expandedSets[key] = !expanded;
					refreshBody();
				});
				parent.appendChild(toggle);
				if (expanded) {
					for (const k of idleRows) {
						parent.appendChild(templateRow(sub, k.name, k.label, k.description, k.unknown));
					}
				}
			}
		}

		/** 原生时间输入；"24:00" 原生选择器不支持 → 留空表示当天结束。 */
		function timeInput(value, placeholder) {
			const inp = el("input", "ms-input ms-time");
			inp.type = "time";
			if (value && value !== "24:00") inp.value = value;
			inp.title = placeholder ? `留空 = ${placeholder}` : "";
			return inp;
		}

		/** 一张窗口卡（isDefault=true 时无时间/星期/删除）。 */
		function renderWindowCard(win, index, isDefault, shadowedReason) {
			const card = el("div", "ms-card" + (shadowedReason ? " ms-card-shadowed" : ""));
			card.setAttribute("data-idx", String(isDefault ? -1 : index));

			// ---- 卡片头（可点击折叠）
			const head = el("div", "ms-card-head ms-clickable");
			const chev = el("span", "ms-chev", "▸");
			head.appendChild(chev);
			head.appendChild(el("span", "ms-title", isDefault ? "兜底" : `窗口 ${index + 1}`));
			if (!isDefault) head.appendChild(el("span", "ms-sum", windowSummary(win)));
			if (shadowedReason) {
				const tag = el("span", "ms-tag", "永不生效");
				tag.title = shadowedReason;
				head.appendChild(tag);
			}
			head.appendChild(el("span", "ms-spacer"));
			if (!isDefault) {
				const del = el("button", "ms-btn danger", "删除");
				del.type = "button";
				del.addEventListener("click", (ev) => {
					ev.stopPropagation();
					if (!confirm(`确定删除窗口 ${index + 1}（${windowSummary(win)}）？`)) return;
					state.config.windows.splice(index, 1);
					markDirty();
					refreshBody();
				});
				head.appendChild(del);
			}
			head.addEventListener("click", (ev) => {
				if (ev.target.closest("button")) return;
				setOpen(win, !isOpen(win));
				syncCardOpen(card, win);
			});
			card.appendChild(head);

			// ---- 卡片体
			const bodyEl = el("div", "ms-card-body");
			card.appendChild(bodyEl);
			if (shadowedReason) {
				const hint = el("div", "ms-shadow-hint", `⚠ ${shadowedReason}`);
				bodyEl.appendChild(hint);
			}

			// 时间 + 星期（一行）
			if (!isDefault) {
				const line = el("div", "ms-inline");
				line.appendChild(el("label", null, "时间"));
				const start = timeInput(win.start, "00:00");
				start.addEventListener("change", () => {
					if (start.value) win.start = start.value;
					else delete win.start;
					markDirty();
					refreshSummaries();
				});
				line.appendChild(start);
				line.appendChild(el("span", "ms-sep", "–"));
				const end = timeInput(win.end, "24:00");
				end.addEventListener("change", () => {
					if (end.value) win.end = end.value;
					else delete win.end;
					markDirty();
					refreshSummaries();
				});
				line.appendChild(end);

				line.appendChild(el("label", null, "星期"));
				const chips = el("div", "ms-chips");
				const setDays = (arr) => {
					const uniq = [...new Set(arr)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
					if (uniq.length === 0) delete win.days;
					else win.days = uniq;
					markDirty();
					refreshSummaries();
				};
				const paintChips = () => {
					const days = Array.isArray(win.days) ? win.days : [];
					chips.textContent = "";
					for (const d of DAY_CHIPS) {
						const chip = el("span", "ms-chip" + (days.includes(d.v) ? " on" : ""), d.label);
						chip.title = d.v === 0 ? "周日" : `周${d.label}`;
						chip.addEventListener("click", () => {
							const cur = Array.isArray(win.days) ? [...win.days] : [];
							const at = cur.indexOf(d.v);
							if (at >= 0) cur.splice(at, 1);
							else cur.push(d.v);
							setDays(cur);
							paintChips();
						});
						chips.appendChild(chip);
					}
				};
				paintChips();
				line.appendChild(chips);

				// 快捷选择（逐天点 7 次太累）
				const quick = el("div", "ms-dayquick");
				const mk = (label, arr, title) => {
					const b = el("button", null, label);
					b.type = "button";
					b.title = title;
					b.addEventListener("click", () => {
						setDays(arr);
						paintChips();
					});
					quick.appendChild(b);
				};
				mk("工作日", WEEKDAYS, "周一至周五");
				mk("周末", WEEKEND, "周六、周日");
				mk("全周", [0, 1, 2, 3, 4, 5, 6], "七天都生效");
				mk("清空", [], "清空 = 每天生效");
				line.appendChild(quick);
				bodyEl.appendChild(line);
			}

			// 主 bot
			bodyEl.appendChild(mainRow((win.main ??= {}), isDefault ? "主 bot（兜底）" : "主 bot", isDefault));

			// 子 bot
			const sec = el("div", "ms-section");
			sec.appendChild(el("div", "ms-section-head", "子 bot"));
			const subRows = el("div");
			sec.appendChild(subRows);
			bodyEl.appendChild(sec);
			renderSubagents(subRows, (win.subagents ??= {}));

			// 兜底（子 bot 默认模型）
			const defWrap = el("div", "ms-section");
			defWrap.appendChild(el("div", "ms-section-head", "子 bot 兜底"));
			const defRow = el("div", "ms-grid ms-grid-row");
			const defName = el("div", "ms-name def", "未单独配置的子 bot");
			defName.title = "所有未单独覆盖/禁用的子 bot 统一使用此项";
			defRow.appendChild(defName);
			defRow.appendChild(el("div", "ms-na", "—"));
			const sub = (win.subagents ??= {});
			const def = (sub.default ||= {});
			const mSel = modelCombo(
				state.models,
				def.model,
				{
					onChange: (v) => {
						if (v) def.model = v;
						else delete def.model;
						markDirty();
					},
				},
				host,
			);
			defRow.appendChild(mSel);
			const tSel = thinkingSelect(def.thinking);
			tSel.addEventListener("change", () => {
				if (tSel.value) def.thinking = tSel.value;
				else delete def.thinking;
				markDirty();
			});
			defRow.appendChild(tSel);
			defRow.appendChild(el("div"));
			defWrap.appendChild(defRow);
			bodyEl.appendChild(defWrap);

			syncCardOpen(card, win);
			return card;
		}

		function syncCardOpen(card, win) {
			const open = isOpen(win);
			card.classList.toggle("ms-open", open);
			const chev = card.querySelector(".ms-chev");
			if (chev) chev.textContent = open ? "▾" : "▸";
		}

		/** 只刷新所有卡片的「时间摘要 + 永不生效标记」，不重建行（避免输入框失焦）。 */
		function refreshSummaries() {
			const cfg = state.config;
			if (!cfg) return;
			const windows = Array.isArray(cfg.windows) ? cfg.windows : [];
			const shadowed = findShadowedWindows(windows);
			const cards = [...wrap.querySelectorAll(".ms-card[data-idx]")];
			for (const card of cards) {
				const idx = Number(card.getAttribute("data-idx"));
				const win = idx === -1 ? cfg.default : windows[idx];
				if (!win) continue;
				const sum = card.querySelector(".ms-sum");
				if (sum) sum.textContent = windowSummary(win);
				const head = card.querySelector(".ms-card-head");
				const existing = head?.querySelector(".ms-tag:not(.live)");
				const reason = shadowed[idx];
				if (reason) {
					if (existing) {
						existing.title = reason;
					} else if (head) {
						const tag = el("span", "ms-tag", "永不生效");
						tag.title = reason;
						const spacer = head.querySelector(".ms-spacer");
						head.insertBefore(tag, spacer);
					}
					card.classList.add("ms-card-shadowed");
				} else {
					existing?.remove();
					card.classList.remove("ms-card-shadowed");
				}
			}
		}

		function renderBody() {
			const body = wrap.querySelector(".ms-body");
			if (!body) return;
			body.textContent = "";
			const cfg = state.config;
			if (!cfg) return;

			const windows = Array.isArray(cfg.windows) ? cfg.windows : (cfg.windows = []);
			if (windows.length === 0) {
				body.appendChild(el("div", "ms-card", "还没有时间窗。点上方「+ 窗口」添加，或只保留下方兜底配置。"));
			}
			const shadowed = findShadowedWindows(windows);
			windows.forEach((w, i) => body.appendChild(renderWindowCard(w, i, false, shadowed[i])));
			if (!cfg.default) cfg.default = {};
			body.appendChild(renderWindowCard(cfg.default, -1, true));
			refreshHighlight();
		}

		function refreshBody() {
			renderBody();
		}

		// ------------------------------------------------------------ 校验与保存

		function clientValidate() {
			const errs = [];
			const cfg = state.config;
			(cfg.windows || []).forEach((w, i) => {
				for (const k of ["start", "end"]) {
					if (w[k] !== undefined && w[k] !== null && w[k] !== "" && !HHMM_RE.test(w[k])) {
						errs.push(`窗口 ${i + 1} 的 ${k} 不是 HH:MM 格式：${w[k]}`);
					}
				}
			});
			const checkSub = (sub, where) => {
				if (!sub || !sub.agents) return;
				for (const [name, entry] of Object.entries(sub.agents)) {
					if (entry && entry.enabled === false) continue;
					if (!entry || (!entry.model && !entry.thinking)) {
						errs.push(`${where} · ${name} 选了「覆盖」但没选模型/思考档`);
					}
				}
			};
			(cfg.windows || []).forEach((w, i) => checkSub(w.subagents, `窗口 ${i + 1}`));
			checkSub(cfg.default, "兜底");
			return errs;
		}

		function showBanner(kind, text) {
			const banner = wrap.querySelector(".ms-banner");
			if (!banner) return;
			banner.className = `ms-banner ${kind}`;
			banner.textContent = text;
			if (kind) {
				try {
					banner.scrollIntoView({ block: "nearest", behavior: "smooth" });
				} catch {
					/* 忽略 */
				}
			}
		}

		async function save() {
			const errs = clientValidate();
			if (errs.length > 0) {
				showBanner("err", `未提交：\n${errs.join("\n")}`);
				return;
			}
			const btn = wrap.querySelector(".ms-save");
			btn.disabled = true;
			btn.textContent = "保存中…";
			try {
				const { ok, status, body } = await fetchJson(`${API_BASE}/api/config`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ config: state.config }),
				});
				if (ok && body?.ok) {
					showBanner("ok", "✅ 已保存，立即生效");
					clearDirty();
				} else if (status === 400 && Array.isArray(body?.errors)) {
					showBanner("err", `❌ 服务端拒绝：\n${body.errors.join("\n")}`);
				} else {
					showBanner("err", `❌ 保存失败（HTTP ${status}）：${body?.error || "未知错误"}`);
				}
			} catch (err) {
				showBanner("err", `❌ 请求异常：${err?.message || err}`);
			} finally {
				btn.disabled = false;
				btn.textContent = "保存";
			}
			refreshEffective();
		}

		async function refreshEffective() {
			try {
				const data = await fetchJson(`${API_BASE}/api/effective`);
				renderEffective(data);
			} catch (err) {
				renderEffective({ ok: false, body: { error: err?.message || String(err) } });
			}
		}

		/** 时区旁的「当地时间」提示：改时区后立即反映，让用户确认没填错。 */
		function updateTzNow() {
			const box = wrap.querySelector(".ms-tz-now");
			if (!box) return;
			const tz = state.config?.timezone;
			box.textContent = "";
			if (!tz) {
				box.appendChild(document.createTextNode("按 UTC 计算"));
				return;
			}
			box.appendChild(document.createTextNode("当地 "));
			box.appendChild(el("b", null, tzNowLabel(tz)));
			box.appendChild(document.createTextNode(` · ${tzOffsetLabel(tz)}`));
		}

		// ------------------------------------------------------------ 初始骨架

		const onBeforeUnload = (ev) => {
			if (!state.dirty) return;
			ev.preventDefault();
			ev.returnValue = "";
			return "";
		};

		async function load() {
			const [cfgRes, modelsRes, agentsRes, effRes] = await Promise.allSettled([
				fetchJson(`${API_BASE}/api/config`),
				fetchJson(`${API_BASE}/api/models`),
				fetchJson(`${API_BASE}/api/subagents`),
				fetchJson(`${API_BASE}/api/effective`),
			]);
			const cfg = cfgRes.status === "fulfilled" ? cfgRes.value : null;
			const mdl = modelsRes.status === "fulfilled" ? modelsRes.value : null;
			const ag = agentsRes.status === "fulfilled" ? agentsRes.value : null;
			const eff = effRes.status === "fulfilled" ? effRes.value : null;

			wrap.textContent = "";

			// 标题 + 当前生效状态
			const head = el("div", "ms-head");
			head.appendChild(el("h2", null, "模型调度"));
			head.appendChild(el("div", "ms-now", "…"));
			wrap.appendChild(head);

			const banner = el("div", "ms-banner");
			wrap.appendChild(banner);

			if (cfg && !cfg.ok) {
				wrap.appendChild(el("div", "ms-banner err", `配置读取失败：${cfg.body?.error || `HTTP ${cfg.status}`}`));
			}
			if (mdl && !mdl.ok) wrap.appendChild(el("div", "ms-banner warn", "模型清单读取失败，下拉将为空"));
			if (ag && !ag.ok) wrap.appendChild(el("div", "ms-banner warn", "子 bot 模板清单读取失败"));

			state.config = cfg?.ok ? cfg.body.config : { timezone: "Asia/Shanghai", windows: [], default: {} };
			state.exists = cfg?.body?.exists !== false;
			state.models = mdl?.ok ? mdl.body.models : [];
			state.agents = ag?.ok ? ag.body.agents : null;
			state.effectiveIndex =
				eff?.ok && typeof eff.body?.windowIndex === "number" ? eff.body.windowIndex : -1;

			// 折叠初值：只展开当前生效的窗口（没有命中就都不展开，一屏看全所有窗口）
			const wins = Array.isArray(state.config.windows) ? state.config.windows : [];
			if (state.effectiveIndex >= 0 && wins[state.effectiveIndex]) {
				setOpen(wins[state.effectiveIndex], true);
			}

			// 吸顶工具条
			const toolbar = el("div", "ms-toolbar");
			toolbar.appendChild(el("label", null, "时区"));
			const tzCombo = timezoneCombo(
				state.config.timezone,
				{
					onChange: (v) => {
						if (v) state.config.timezone = v;
						else delete state.config.timezone;
						markDirty();
						updateTzNow();
						refreshEffective();
					},
				},
				host,
			);
			toolbar.appendChild(tzCombo);
			toolbar.appendChild(el("span", "ms-tz-now"));

			const addWin = el("button", "ms-btn mini", "+ 窗口");
			addWin.type = "button";
			addWin.addEventListener("click", () => {
				const w = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5], main: {} };
				state.config.windows.push(w);
				setOpen(w, true);
				markDirty();
				refreshBody();
			});
			toolbar.appendChild(addWin);

			const toggleAll = el("button", "ms-btn mini", "全部收起");
			toggleAll.type = "button";
			toggleAll.addEventListener("click", () => {
				const list = Array.isArray(state.config.windows) ? state.config.windows : [];
				const objs = [...list, state.config.default].filter(Boolean);
				const anyOpen = objs.some((o) => isOpen(o));
				for (const o of objs) setOpen(o, !anyOpen);
				toggleAll.textContent = anyOpen ? "全部展开" : "全部收起";
				refreshBody();
			});
			toolbar.appendChild(toggleAll);

			toolbar.appendChild(el("span", "ms-spacer"));

			const reload = el("button", "ms-btn mini", "重读");
			reload.type = "button";
			reload.title = "放弃本地修改，重新从文件读取";
			reload.addEventListener("click", () => {
				if (state.dirty && !confirm("有未保存的修改，重新读取会丢弃它们。继续？")) return;
				clearDirty();
				load();
			});
			toolbar.appendChild(reload);

			const dirtyChip = el("span", "ms-dirty", "● 未保存");
			dirtyChip.title = "改动还没写入配置文件";
			toolbar.appendChild(dirtyChip);

			const saveBtn = el("button", "ms-btn primary mini ms-save", "保存");
			saveBtn.type = "button";
			saveBtn.addEventListener("click", save);
			toolbar.appendChild(saveBtn);
			wrap.appendChild(toolbar);

			const body = el("div", "ms-body");
			wrap.appendChild(body);
			renderBody();
			updateTzNow();
			renderEffective(eff ?? { ok: false });
			window.addEventListener("beforeunload", onBeforeUnload);
		}

		load().catch((err) => {
			wrap.textContent = "";
			wrap.appendChild(el("div", "ms-banner err", `初始化失败：${err?.message || err}`));
		});

		return () => {
			window.removeEventListener("beforeunload", onBeforeUnload);
			closePopup();
			wrap.textContent = "";
			container.replaceChildren();
		};
	},
});
