/**
 * model-schedule 插件自测 —— 不启动宿主，直接 import 服务端入口，
 * 用 createMockHost 的路由表驱动 HTTP handler。
 *
 * 跑法：node test/run.mjs
 * 通过 MODEL_SCHEDULE_CONFIG / MODEL_SCHEDULE_MODELS 指到临时文件。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { serializeJsonc, stripJsonc, parseJsonc, matchWindow, nowInTz } from "../index.mjs";
import { createMockHost } from "../sdk/index.mjs";

const HEADER = [
	"// model-schedule 配置 — 按时段路由主 bot 与子 bot 的模型/思考档位。",
	"// 保留头注释验证用。",
	"",
].join("\n");

const SAMPLE = `${HEADER}{
	"timezone": "Asia/Shanghai",
	"windows": [
		{
			// 工作日白天
			"start": "08:00",
			"end": "20:00",
			"days": [1, 2, 3, 4, 5],
			"main": { "model": "magpie/auto/glm-5.3-flash", "thinking": "medium" },
			"subagents": {
				"default": { "model": "magpie/auto/glm-5.3-flash" },
				"agents": { "oracle": { "enabled": false } }
			}
		},
		{
			// 晚间跨午夜
			"start": "22:00",
			"end": "06:00",
			"main": { "model": "magpie/zcode/GLM-5.3-Flash", "thinking": "max" }
		}
	],
	"default": { "main": { "model": "magpie/auto/deepseek-v4.1-flash" } }
}
`;

const MODELS = {
	providers: {
		magpie: {
			models: [
				{ id: "auto/glm-5.3-flash", name: "GLM-5.3 Flash (auto)" },
				{ id: "zcode/GLM-5.3-Flash", name: "GLM-5.3-Flash" },
			],
		},
	},
};

function setup(tmp) {
	const cfgPath = join(tmp, "model-schedule.jsonc");
	const modelsPath = join(tmp, "models.json");
	writeFileSync(cfgPath, SAMPLE, "utf8");
	writeFileSync(modelsPath, JSON.stringify(MODELS), "utf8");
	process.env.MODEL_SCHEDULE_CONFIG = cfgPath;
	process.env.MODEL_SCHEDULE_MODELS = modelsPath;
	return cfgPath;
}

/** 在 mock host 上 activate，返回 { host, call }；call(method, path) 模拟宿主分发。 */
async function activate() {
	const host = createMockHost();
	await plugin.activate(host);
	const routes = host.mock.routes;
	assert.ok(routes.length >= 4, `应有 4 条路由，实际 ${routes.length}`);
	const call = async (method, path, body, headers) => {
		const r = routes.find((x) => x.method === method && x.path === path);
		assert.ok(r, `路由未注册: ${method} ${path}`);
		const res = {
			_code: 200,
			_json: null,
			headersSent: false,
			status(c) {
				this._code = c;
				return this;
			},
			json(o) {
				this._json = o;
				return this;
			},
			end() {
				this._ended = true;
			},
		};
		// 带 body 的请求默认补上 JSON Content-Type（POST /api/config 有该守卫）；
		// 需要测「缺头被拒」时显式传 headers={} 覆盖。
		const hdrs = headers ?? (body === undefined ? {} : { "content-type": "application/json" });
		const req = { body, headers: hdrs };
		await r.handler(req, res);
		await new Promise((r2) => setImmediate(r2));
		return { code: res._code, json: res._json };
	};
	return { call, routes };
}

describe("model-schedule 插件路由", () => {
	const tmp = mkdtempSync(join(tmpdir(), "ms-test-"));
	const cfgPath = setup(tmp);

	it("GET /api/config —— JSONC 解析往返", async () => {
		const { call } = await activate();
		const r = await call("GET", "/api/config");
		assert.equal(r.code, 200);
		assert.equal(r.json.ok, true);
		assert.equal(r.json.exists, true);
		assert.equal(r.json.config.timezone, "Asia/Shanghai");
		assert.equal(r.json.config.windows.length, 2);
		assert.ok(r.json.header.includes("保留头注释验证用"), "头注释应被提取");
	});

	it("POST /api/config —— 写回保留头注释且再读一致", async () => {
		const { call } = await activate();
		const get1 = await call("GET", "/api/config");
		const cfg = get1.json.config;
		cfg.windows[0].main.model = "magpie/zcode/GLM-5.3-Flash";
		const post = await call("POST", "/api/config", { config: cfg });
		assert.equal(post.code, 200, JSON.stringify(post.json));
		assert.equal(post.json.ok, true);
		const text = readFileSync(cfgPath, "utf8");
		assert.ok(text.startsWith("// model-schedule 配置"), "写回应保留头注释块");
		assert.ok(!text.includes("// 工作日白天"), "窗口内注释按 JSONC 语义不保留（只保留头注释块）");
		const get2 = await call("GET", "/api/config");
		assert.equal(get2.json.config.windows[0].main.model, "magpie/zcode/GLM-5.3-Flash");
		assert.equal(get2.json.config.windows[1].main.thinking, "max");
	});

	it("POST /api/config —— 非法输入 400 不落盘", async () => {
		const { call } = await activate();
		const before = readFileSync(cfgPath, "utf8");
		const bad1 = await call("POST", "/api/config", { config: { windows: [{ start: "8am", end: "20:00" }] } });
		assert.equal(bad1.code, 400);
		assert.ok(bad1.json.errors.some((e) => e.includes("start")));
		const bad2 = await call("POST", "/api/config", { config: { windows: [{ days: [7] }] } });
		assert.equal(bad2.code, 400);
		const bad3 = await call("POST", "/api/config", { config: { default: { main: { model: 42 } } } });
		assert.equal(bad3.code, 400);
		const bad4 = await call("POST", "/api/config", { config: { default: { main: { thinking: "ultra" } } } });
		assert.equal(bad4.code, 400);
		// 缺 Content-Type 一律 400（防止宿主没解 body 时误写空配置）
		const noType = await call("POST", "/api/config", { config: { windows: [] } }, {});
		assert.equal(noType.code, 400);
		assert.ok(noType.json.errors.some((e) => e.includes("Content-Type")));
		assert.equal(readFileSync(cfgPath, "utf8"), before, "校验失败不应落盘");
	});

	it("GET /api/models —— magpie/<id> 列表", async () => {
		const { call } = await activate();
		const r = await call("GET", "/api/models");
		assert.equal(r.code, 200);
		assert.deepEqual(r.json.models, [
			{ id: "magpie/auto/glm-5.3-flash", label: "GLM-5.3 Flash (auto)" },
			{ id: "magpie/zcode/GLM-5.3-Flash", label: "GLM-5.3-Flash" },
		]);
	});

	it("GET /api/subagents —— 全部可用子 bot 模板（内置 + 用户自定义合并）", async () => {
		const { call } = await activate();
		const r = await call("GET", "/api/subagents");
		assert.equal(r.code, 200);
		assert.equal(r.json.ok, true);
		assert.ok(Array.isArray(r.json.agents), "agents 应为数组");
		assert.ok(r.json.agents.length >= 1, "至少应列出内置模板");
		for (const a of r.json.agents) {
			assert.ok(typeof a.id === "string" && a.id, "每个模板应有 id");
			assert.ok("label" in a && "description" in a, "每个模板应有 label/description");
		}
		// id 唯一（内置 + 用户自定义按 name 合并后不应有重复）
		const ids = r.json.agents.map((a) => a.id);
		assert.equal(new Set(ids).size, ids.length, "agent id 不应重复");
	});

	it("GET /api/effective —— 白天窗口命中", async () => {
		const { call } = await activate();
		const r = await call("GET", "/api/effective");
		assert.equal(r.code, 200);
		assert.equal(r.json.ok, true);
		assert.equal(r.json.timezone, "Asia/Shanghai");
		assert.ok(["window", "cross-midnight-tail", "default"].includes(r.json.matched));
		// windowIndex：前端靠它高亮「当前生效」的卡片，必须与 matched 一致
		assert.equal(typeof r.json.windowIndex, "number", "应返回 windowIndex");
		if (r.json.matched === "default") assert.equal(r.json.windowIndex, -1);
		else assert.ok(r.json.windowIndex >= 0, "命中窗口时 windowIndex 应 >= 0");
		// 不断言具体命中的窗口（取决于真实时钟），但窗口命中时必须带 main 与原因
		if (r.json.matched !== "default") {
			assert.ok(r.json.window, "命中窗口时应返回 window 详情");
			assert.ok(r.json.reason);
		}
	});

	it("GET /api/effective —— matchWindow 纯函数定向验证（跨午夜尾段 + default）", async () => {
		const cfg = {
			timezone: "Asia/Shanghai",
			windows: [
				{ start: "22:00", end: "06:00", main: { model: "magpie/zcode/GLM-5.3-Flash" } },
				{ start: "08:00", end: "20:00", days: [1, 2, 3, 4, 5], main: { model: "magpie/auto/glm-5.3-flash" } },
			],
			default: { main: { model: "magpie/auto/deepseek-v4.1-flash" } },
		};
		// 23:30 周三 → 第一窗命中
		const night = matchWindow(cfg, { minutes: 23 * 60 + 30, day: 3 });
		assert.equal(night.main.model, "magpie/zcode/GLM-5.3-Flash");
		// 03:00 周四 → 跨午夜尾段仍命中第一窗（归属周三 start 日）
		const tail = matchWindow(cfg, { minutes: 3 * 60, day: 4 });
		assert.equal(tail.main.model, "magpie/zcode/GLM-5.3-Flash");
		// 03:00 周日 → start 日是周六，不在窗口 days（未设 days = 每天）→ 仍命中（无 days 限制）
		const tailSun = matchWindow(cfg, { minutes: 3 * 60, day: 0 });
		assert.equal(tailSun.main.model, "magpie/zcode/GLM-5.3-Flash");
		// 12:00 周六 → 白天窗口 days=[1-5] 不含周六 → default
		const weekend = matchWindow(cfg, { minutes: 12 * 60, day: 6 });
		assert.equal(weekend, undefined);
		// nowInTz 与扩展侧同构：返回分钟与星期
		const now = nowInTz("UTC");
		assert.ok(now.minutes >= 0 && now.minutes < 1440);
		assert.ok(now.day >= 0 && now.day <= 6);
	});

	it("serializeJsonc —— JSONC 风格输出（头注释拼接 + 尾逗号清理）", () => {
		const text = serializeJsonc({ a: 1, list: [1, 2] }, { header: "// 头\n" });
		assert.ok(text.startsWith("// 头\n"));
		assert.ok(text.includes('"a": 1'));
		assert.equal(parseJsonc(stripJsonc(text)).a, 1);
	});

	it("反激活注销路由", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		// 5 条：GET/POST /api/config、/api/models、/api/subagents、/api/effective
		assert.equal(host.mock.routes.length, 5);
		cleanup();
		assert.equal(host.mock.routes.length, 0);
	});

	after(() => {
		delete process.env.MODEL_SCHEDULE_CONFIG;
		delete process.env.MODEL_SCHEDULE_MODELS;
		rmSync(tmp, { recursive: true, force: true });
	});
});
