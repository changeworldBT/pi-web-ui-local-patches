/**
 * model-schedule —— pi-web-ui 服务端入口。
 *
 * 为 ~/.pi/agent/model-schedule.jsonc（主 bot / 子 bot 按时段的模型调度配置）提供
 * 网页配置面的 HTTP 层，路由挂在 /plugins-api/model-schedule/api/* 下：
 *   GET  /api/config     读配置文件，解析为 JSON 返回
 *   POST /api/config     校验 + JSONC 序列化写回（保留文件头注释块）
 *   GET  /api/models     读 models.json，输出 [{ id: "magpie/<modelId>", label }]
 *   GET  /api/effective  用与扩展侧一致的窗口匹配逻辑算当前生效窗口
 *
 * 权限：只读 models.json / model-schedule.jsonc、写 model-schedule.jsonc，
 * 不碰其它文件，manifest 只声明 fs 权限族（无 net / llm / tools）。
 */
import { definePlugin } from "./sdk/index.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 配置文件：与扩展侧 configPath() 同构（MODEL_SCHEDULE_CONFIG 可覆盖，测试用）。 */
function configPath() {
	return process.env.MODEL_SCHEDULE_CONFIG || join(homedir(), ".pi", "agent", "model-schedule.jsonc");
}

/** 模型清单：~/.pi/agent/models.json。 */
function modelsJsonPath() {
	return process.env.MODEL_SCHEDULE_MODELS || join(homedir(), ".pi", "agent", "models.json");
}

/** pi-web-ui 内置子 bot 模板源（BUILTIN_TEMPLATES 所在 dist 文件）。 */
function builtinTemplatesPath() {
	return (
		process.env.MODEL_SCHEDULE_BUILTIN_TEMPLATES ||
		join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-ui", "dist", "server", "subagent-templates.js")
	);
}

/** 用户自定义子 bot 模板（pi-web-ui 数据目录，缺省 ~/.pi-web）。 */
function userTemplatesPath() {
	const dataDir = process.env.MODEL_SCHEDULE_USER_TEMPLATES_DIR || process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
	return join(dataDir, "subagent-templates.json");
}

/** 思考档位（与扩展侧 MODEL_THINKING_LEVELS 一致）。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 内置子 bot 模板：优先动态 import 内置 BUILTIN_TEMPLATES，失败则回退到文本正则抽取。
 * 结果按 name 去重并缓存（内置模板几乎不变，避免每次请求都解析 dist 文件）。
 */
let _builtinTemplatesCache = null;
async function loadBuiltinTemplates() {
	if (_builtinTemplatesCache) return _builtinTemplatesCache;
	const list = [];
	try {
		const mod = await import(pathToFileURL(builtinTemplatesPath()).href);
		if (Array.isArray(mod.BUILTIN_TEMPLATES)) {
			for (const t of mod.BUILTIN_TEMPLATES) {
				if (t && typeof t.name === "string" && t.name) {
					list.push({
						name: t.name,
						description: String(t.description || ""),
						descriptionEn: String(t.descriptionEn || ""),
						enabled: t.enabled !== false,
					});
					}
				}
			return (_builtinTemplatesCache = list);
		}
	} catch {
		/* import 失败（路径变化/内部模块异常）→ 走文本回退 */
	}
	try {
		const src = readFileSync(builtinTemplatesPath(), "utf8");
		const names = [...src.matchAll(/name:\s*"([^"]*)"/g)].map((m) => m[1]);
		const descs = [...src.matchAll(/description:\s*"([^"]*)"/g)].map((m) => m[1]);
		const descsEn = [...src.matchAll(/descriptionEn:\s*"([^"]*)"/g)].map((m) => m[1]);
		for (let i = 0; i < names.length; i++) {
			list.push({
				name: names[i],
				description: descs[i] || "",
				descriptionEn: descsEn[i] || "",
				enabled: true,
			});
		}
	} catch {
		/* 连文件都读不到：返回空清单 */
	}
	return (_builtinTemplatesCache = list);
}

/** 用户自定义模板（<dataDir>/subagent-templates.json，JSON 数组；不存在/损坏返回 []）。 */
function loadUserTemplates() {
	const path = userTemplatesPath();
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(data)) return [];
		return data
			.filter((t) => t && typeof t.name === "string" && t.name)
			.map((t) => ({
				name: t.name,
				description: String(t.description || ""),
				descriptionEn: String(t.descriptionEn || ""),
				enabled: t.enabled !== false,
			}));
	} catch {
		return [];
	}
}

/**
 * 汇总「全部可用子 bot 模板」：内置 + 用户自定义按 name 合并（用户覆盖内置），
 * 过滤掉 enabled=false 的，输出 [{ id, label, description }]。
 * id = 模板名（即 config.agents 的键），label = 模板名，description = 中文简介。
 */
async function collectSubagents() {
	const builtin = await loadBuiltinTemplates();
	const user = loadUserTemplates();
	const byName = new Map();
	for (const t of builtin) byName.set(t.name, t);
	for (const t of user) byName.set(t.name, t); // 用户同名覆盖内置
	const out = [];
	for (const t of byName.values()) {
		if (t.enabled === false) continue;
		out.push({ id: t.name, label: t.name, description: t.description || t.descriptionEn || t.name });
	}
	return out;
}

/** 去 JSONC 注释与尾逗号（与扩展侧 stripJsonc 同构，字符串字面量内的 // 与 /* 不受影响）。 */
export function stripJsonc(src) {
	let out = "";
	let i = 0;
	let inStr = false;
	while (i < src.length) {
		const c = src[i];
		if (inStr) {
			out += c;
			if (c === "\\" && i + 1 < src.length) {
				out += src[i + 1];
				i += 2;
				continue;
			}
			if (c === '"') inStr = false;
			i++;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** 解析 JSONC 文本为对象；失败抛错（由路由层转 400/500）。 */
export function parseJsonc(src) {
	return JSON.parse(stripJsonc(src));
}

/** 抽取文件头部注释块：从首个非空行起连续收集注释行（含多行块注释），遇到第一行代码即停。
 *  没有头注释返回空串。 */
function headerComment(src) {
	const lines = src.split("\n");
	const header = [];
	let inBlock = false;
	for (const line of lines) {
		if (inBlock) {
			header.push(line);
			if (line.includes("*/")) inBlock = false;
			continue;
		}
		const t = line.trimStart();
		if (t === "") {
			if (header.length > 0) header.push("");
			continue;
		}
		if (t.startsWith("//")) {
			header.push(line);
			continue;
		}
		if (t.startsWith("/*")) {
			header.push(line);
			if (!t.includes("*/")) inBlock = true;
			continue;
		}
		break;
	}
	// 去掉尾部空行
	while (header.length > 0 && header[header.length - 1] === "") header.pop();
	return header.length > 0 ? header.join("\n") + "\n" : "";
}

// ------------------------------------------------------------ 配置结构处理（与扩展侧 parseConfig 同构）

function asModelAndLevel(v) {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v;
	const out = {};
	if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
	if (typeof o.thinking === "string" && THINKING_LEVELS.includes(o.thinking)) out.thinking = o.thinking;
	return Object.keys(out).length > 0 ? out : undefined;
}

function asSubagents(v) {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v;
	const out = {};
	const def = asModelAndLevel(o.default);
	if (def) out.default = def;
	if (typeof o.agents === "object" && o.agents !== null) {
		out.agents = {};
		for (const [name, entry] of Object.entries(o.agents)) {
			if (typeof entry !== "object" || entry === null) continue;
			const override = { ...(asModelAndLevel(entry) ?? {}) };
			if (entry.enabled === false) override.enabled = false;
			out.agents[name] = override;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 宽松解析为内部配置对象：只丢弃类型不符的字段（与扩展侧 parseConfig 行为一致）。 */
export function parseConfigLoose(data) {
	const cfg = {};
	if (typeof data.timezone === "string" && data.timezone.trim()) cfg.timezone = data.timezone.trim();
	const windows = [];
	if (Array.isArray(data.windows)) {
		for (const w of data.windows) {
			if (typeof w !== "object" || w === null) continue;
			const o = w;
			const entry = {};
			if (typeof o.start === "string" && o.start.trim()) entry.start = o.start.trim();
			if (typeof o.end === "string" && o.end.trim()) entry.end = o.end.trim();
			if (Array.isArray(o.days)) {
				const days = o.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
				if (days.length > 0) entry.days = days;
			}
			const main = asModelAndLevel(o.main);
			if (main) entry.main = main;
			const sub = asSubagents(o.subagents);
			if (sub) entry.subagents = sub;
			windows.push(entry);
		}
	}
	if (windows.length > 0) cfg.windows = windows;
	if (typeof data.default === "object" && data.default !== null) {
		const o = data.default;
		const def = {};
		const main = asModelAndLevel(o.main);
		if (main) def.main = main;
		const sub = asSubagents(o.subagents);
		if (sub) def.subagents = sub;
		if (def.main || def.subagents) cfg.default = def;
	}
	return cfg;
}

// ------------------------------------------------------------ POST 校验（严格：失败 400 不落盘）

const HHMM_RE = /^([01]\d|2[0-4]):[0-5]\d$/;

function validateModelAndLevel(v, where, errors) {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "object" || Array.isArray(v)) {
		errors.push(`${where} 必须是对象`);
		return undefined;
	}
	const out = {};
	if (v.model !== undefined) {
		if (typeof v.model !== "string" || !v.model.trim()) {
			errors.push(`${where}.model 必须是非空字符串`);
		} else {
			out.model = v.model.trim();
		}
	}
	if (v.thinking !== undefined) {
		if (typeof v.thinking !== "string" || !THINKING_LEVELS.includes(v.thinking)) {
			errors.push(`${where}.thinking 非法（可选：${THINKING_LEVELS.join("|")}）`);
		} else {
			out.thinking = v.thinking;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validateSubagents(v, where, errors) {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "object" || Array.isArray(v)) {
		errors.push(`${where} 必须是对象`);
		return undefined;
	}
	const out = {};
	const def = validateModelAndLevel(v.default, `${where}.default`, errors);
	if (def) out.default = def;
	if (v.agents !== undefined && v.agents !== null) {
		if (typeof v.agents !== "object" || Array.isArray(v.agents)) {
			errors.push(`${where}.agents 必须是对象`);
		} else {
			out.agents = {};
			for (const [name, entry] of Object.entries(v.agents)) {
				if (typeof entry !== "object" || entry === null) {
					errors.push(`${where}.agents.${name} 必须是对象`);
					continue;
				}
				const override = { ...(validateModelAndLevel(entry, `${where}.agents.${name}`, errors) ?? {}) };
				if (entry.enabled !== undefined) {
					if (typeof entry.enabled !== "boolean") {
						errors.push(`${where}.agents.${name}.enabled 必须是布尔值`);
					} else if (entry.enabled === false) {
						override.enabled = false;
					}
				}
				out.agents[name] = override;
			}
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 严格校验 POST 的配置对象；返回 { cfg } 或 { errors }。
 * 规则：windows 是数组、每窗 start/end 形如 HH:MM、days 是 0-6 整数数组、
 * model 是非空字符串、thinking 属于合法档位、enabled 是布尔。
 */
export function validateConfig(data) {
	const errors = [];
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { errors: ["配置体必须是 JSON 对象"] };
	}
	const cfg = {};
	if (data.timezone !== undefined && data.timezone !== null && data.timezone !== "") {
		if (typeof data.timezone !== "string") {
			errors.push("timezone 必须是字符串");
		} else {
			try {
				new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone.trim() });
				cfg.timezone = data.timezone.trim();
			} catch {
				errors.push(`timezone 不是合法的 IANA 时区：${data.timezone}`);
			}
		}
	}
	if (data.windows !== undefined && data.windows !== null) {
		if (!Array.isArray(data.windows)) {
			errors.push("windows 必须是数组");
		} else {
			const windows = [];
			data.windows.forEach((w, i) => {
				const where = `windows[${i}]`;
				if (typeof w !== "object" || w === null || Array.isArray(w)) {
					errors.push(`${where} 必须是对象`);
					return;
				}
				const entry = {};
				for (const k of ["start", "end"]) {
					if (w[k] === undefined || w[k] === null || w[k] === "") continue;
					if (typeof w[k] !== "string" || !HHMM_RE.test(w[k].trim())) {
						errors.push(`${where}.${k} 必须是 "HH:MM"（如 08:00）`);
					} else {
						entry[k] = w[k].trim();
					}
				}
				if (w.days !== undefined && w.days !== null) {
					if (!Array.isArray(w.days) || w.days.length === 0) {
						errors.push(`${where}.days 必须是非空数组（0=周日 … 6=周六）`);
					} else if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
						errors.push(`${where}.days 只能是 0-6 的整数`);
					} else {
						entry.days = [...new Set(w.days)];
					}
				}
				const main = validateModelAndLevel(w.main, `${where}.main`, errors);
				if (main) entry.main = main;
				const sub = validateSubagents(w.subagents, `${where}.subagents`, errors);
				if (sub) entry.subagents = sub;
				windows.push(entry);
			});
			cfg.windows = windows;
		}
	}
	if (data.default !== undefined && data.default !== null) {
		if (typeof data.default !== "object" || Array.isArray(data.default)) {
			errors.push("default 必须是对象");
		} else {
			const def = {};
			const main = validateModelAndLevel(data.default.main, "default.main", errors);
			if (main) def.main = main;
			const sub = validateSubagents(data.default.subagents, "default.subagents", errors);
			if (sub) def.subagents = sub;
			cfg.default = def;
		}
	}
	if (errors.length > 0) return { errors };
	return { cfg };
}

/**
 * JSONC 序列化：与手写配置同风格的紧凑 JSONC。
 * depth=0 时若提供 header 则把头注释原样拼在最前面（保留文件头注释块）。
 */
export function serializeJsonc(value, { header = "", indent = "\t" } = {}) {
	const body = JSON.stringify(value, null, indent).replace(/,(\s*[}\]])/g, "$1");
	return header ? header + body + "\n" : body + "\n";
}

// ------------------------------------------------------------ 时段匹配（与扩展侧 nowInTz / matchWindow 同构）

export function nowInTz(tz) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz || "UTC",
		hourCycle: "h23",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(new Date());
	const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
	const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	const day = weekdays[get("weekday")] ?? 0;
	const hour = Number(get("hour"));
	const minute = Number(get("minute"));
	return { minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0), day };
}

function toMinutes(hhmm) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
	if (!m) return undefined;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 24 || min > 59) return undefined;
	return h * 60 + min;
}

/** 窗口匹配：数组顺序第一个命中的窗口生效；跨午夜窗口归属日按 start 那天算。 */
export function matchWindow(cfg, now) {
	for (const w of cfg.windows ?? []) {
		const bothUnset = w.start === undefined && w.end === undefined;
		if (bothUnset) {
			if (!w.days || w.days.includes(now.day)) return w;
			continue;
		}
		const s = w.start !== undefined ? toMinutes(w.start) : 0;
		const e = w.end !== undefined ? toMinutes(w.end) : 24 * 60;
		if (s === undefined || e === undefined || s === e) continue;
		const onDay = (day) => !w.days || w.days.includes(day);
		if (s < e) {
			if (onDay(now.day) && now.minutes >= s && now.minutes < e) return w;
		} else {
			if (onDay(now.day) && now.minutes >= s) return w;
			if (onDay((now.day + 6) % 7) && now.minutes < e) return w;
		}
	}
	return undefined;
}

// ------------------------------------------------------------ 插件主体

export default definePlugin({
	activate(host) {
		const offRoutes = [];

		function registerRoute(method, path, handler) {
			const off = host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					host.log?.("error", `[model-schedule] ${method} ${path} 抛错: ${err?.message || err}`);
					if (!res.headersSent) res.status(500).json({ ok: false, error: err?.message || "Internal error" });
				}
			});
			offRoutes.push(off);
		}

		// 1. GET /api/config —— 读配置解析为 JSON 返回
		registerRoute("GET", "/api/config", async (_req, res) => {
			const path = configPath();
			let raw;
			try {
				raw = readFileSync(path, "utf8");
			} catch (err) {
				if (err?.code === "ENOENT") {
					res.json({ ok: true, exists: false, config: {}, header: "", path });
					return;
				}
				res.status(500).json({ ok: false, error: `读取配置失败：${err?.message || err}` });
				return;
			}
			try {
				const config = parseJsonc(raw);
				res.json({ ok: true, exists: true, config, header: headerComment(raw), path });
			} catch (err) {
				res.status(500).json({ ok: false, error: `配置解析失败：${err?.message || err}` });
			}
		});

		// 2. POST /api/config —— 校验 + 序列化写回（保留原文件头注释块）
		// 宿主 express.json 只在 Content-Type: application/json 时填充 req.body；
		// 缺头/空体一律拒绝，防止误把空配置写盘清空现有时段表。
		registerRoute("POST", "/api/config", async (req, res) => {
			const rawType = String(req.headers?.["content-type"] ?? "");
			if (!rawType.includes("application/json")) {
				res.status(400).json({ ok: false, errors: [`Content-Type 必须是 application/json（收到 "${rawType || "无"}"）`] });
				return;
			}
			const body = req.body;
			if (typeof body !== "object" || body === null || Object.keys(body).length === 0) {
				res.status(400).json({ ok: false, errors: ["请求体为空：POST 需要完整的配置对象（可先 GET /api/config 取当前值）"] });
				return;
			}
			const data = typeof body.config === "object" && body.config !== null ? body.config : body;
			if (Object.keys(data).length === 0) {
				res.status(400).json({ ok: false, errors: ["配置对象为空：拒绝写入（至少包含 default 或 windows 之一）"] });
				return;
			}
			const result = validateConfig(data);
			if (result.errors) {
				res.status(400).json({ ok: false, errors: result.errors });
				return;
			}
			const path = configPath();
			let header = "";
			try {
				header = headerComment(readFileSync(path, "utf8"));
			} catch {
				header = "";
			}
			try {
				const text = serializeJsonc(result.cfg, { header });
				writeFileSync(path, text, "utf8");
				host.log?.("info", `[model-schedule] 配置已写回 ${path}`);
				res.json({ ok: true, path, bytes: Buffer.byteLength(text, "utf8") });
			} catch (err) {
				res.status(500).json({ ok: false, error: `写回失败：${err?.message || err}` });
			}
		});

		// 3. GET /api/models —— 模型清单（完整 id = "magpie/<modelId>"）
		registerRoute("GET", "/api/models", async (_req, res) => {
			const path = modelsJsonPath();
			try {
				if (!existsSync(path)) {
					res.json({ ok: true, models: [], error: `models.json 不存在：${path}` });
					return;
				}
				const data = JSON.parse(readFileSync(path, "utf8"));
				const magpie = data.providers?.magpie;
				const list = Array.isArray(magpie?.models) ? magpie.models : [];
				res.json({
					ok: true,
					models: list.map((m) => ({ id: `magpie/${m.id}`, label: String(m.name || m.id) })),
				});
			} catch (err) {
				res.status(500).json({ ok: false, error: `读取模型清单失败：${err?.message || err}` });
			}
		});

		// 3b. GET /api/subagents —— 全部可用子 bot 模板（内置 + 用户自定义，按 name 合并）
		registerRoute("GET", "/api/subagents", async (_req, res) => {
			try {
				const agents = await collectSubagents();
				res.json({ ok: true, agents });
			} catch (err) {
				res.status(500).json({ ok: false, error: `读取子 bot 模板失败：${err?.message || err}` });
			}
		});

		// 4. GET /api/effective —— 当前生效窗口（含时区与命中原因）
		registerRoute("GET", "/api/effective", async (_req, res) => {
			const path = configPath();
			let cfg = {};
			try {
				cfg = parseJsonc(readFileSync(path, "utf8"));
			} catch (err) {
				res.status(500).json({ ok: false, error: `配置解析失败：${err?.message || err}` });
				return;
			}
			const normalized = parseConfigLoose(cfg);
			const tz = normalized.timezone || "UTC";
			const now = nowInTz(normalized.timezone);
			const win = matchWindow(normalized, now);
			// 前端要高亮「当前生效的窗口卡」，只回窗口内容无法定位到第几张卡（内容可能重复），
			// 所以额外回一个下标。命中 default 时为 -1。
			const windowIndex = win && Array.isArray(normalized.windows) ? normalized.windows.indexOf(win) : -1;
			const hhmm = `${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`;
			let matched = "default";
			if (win) {
				if (win.start !== undefined || win.end !== undefined) {
					const s = win.start !== undefined ? toMinutes(win.start) : 0;
					const e = win.end !== undefined ? toMinutes(win.end) : 24 * 60;
					if (s !== undefined && e !== undefined && s > e && now.minutes < e) {
						matched = "cross-midnight-tail";
					} else {
						matched = "window";
					}
				} else {
					matched = "window";
				}
			}
			const reasons = {
				window: "命中 windows[] 顺序第一个匹配的时间窗",
				"cross-midnight-tail": "命中跨午夜窗口（归属昨天的 start 日）的尾段",
				default: "无窗口命中，落 default",
			};
			res.json({
				ok: true,
				timezone: tz,
				localTime: `${DAY_NAMES[now.day]} ${hhmm}`,
				day: now.day,
				minutes: now.minutes,
				matched,
				reason: reasons[matched],
				windowIndex,
				window: win
					? {
							start: win.start ?? "00:00",
							end: win.end ?? "24:00",
							...(win.days ? { days: win.days, daysLabel: win.days.map((d) => DAY_NAMES[d]).join("、") } : {}),
							main: win.main ?? null,
							subagents: win.subagents ?? null,
						}
					: null,
				default: normalized.default ?? null,
			});
		});

		host.log?.("info", "model-schedule 插件服务端已就绪（config/models/effective 路由挂载完成）");

		return () => {
			for (const off of offRoutes) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			offRoutes.length = 0;
		};
	},
});
