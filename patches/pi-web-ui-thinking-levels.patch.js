#!/usr/bin/env node
/**
 * pi-web-ui 补丁：让「刷新模型列表」从网关的 reasoning_levels / supported_reasoning_levels
 * 推导 thinkingLevelMap，使极高(xhigh)/最大(max) 等模型特有思考档位出现在 WebUI 下拉中。
 *
 * 背景（v0.112.0 验证）：
 *  - WebUI 前端本身支持 off/minimal/low/medium/high/xhigh/max 7 档；
 *  - 但 pi-ai 的 getSupportedThinkingLevels() 只在模型带 thinkingLevelMap 时才开放 xhigh/max；
 *  - parseOpenAiModel() 丢弃了网关 /v1/models 返回的 reasoning_levels 元数据，
 *    刷新后的自定义服务商模型永远只有 off~high。
 *
 * 用法：node ~/.pi/agent/patches/pi-web-ui-thinking-levels.patch.js
 * 幂等：重复执行无副作用（oldText 唯一匹配才替换）。
 * 适用版本：pi-web-ui 0.112.0（升级后若 replace 失败会打印SKIP，需人工核对）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// pi-web-ui 装在 pi 的包目录（~/.pi/agent/npm/node_modules），从 PATH 全局 require 未必可见，
// 这里按 pi 的固定安装布局解析，找不到时再退回 require.resolve。
const candidates = [
  homedir() + "/.pi/agent/npm/node_modules/pi-web-ui/package.json",
];
let pkgPath = candidates.find((p) => existsSync(p));
if (!pkgPath) {
  try {
    const { createRequire } = await import("node:module");
    pkgPath = createRequire(import.meta.url).resolve("pi-web-ui/package.json");
  } catch {
    console.error("✗ 找不到 pi-web-ui 安装位置（~/.pi/agent/npm/node_modules）");
    process.exit(1);
  }
}
const pkgDir = pkgPath.replace(/package\.json$/, "");
const target = pkgDir + "dist/server/model-admin.js";
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;

if (!existsSync(target)) {
  console.error(`✗ 找不到 ${target}`);
  process.exit(1);
}

let src = readFileSync(target, "utf8");
let applied = 0, skipped = 0;

function replace(name, oldText, newText, marker) {
  // marker：补丁里独有的片段；命中即视为已打过，避免误判重复插入。
  if (marker && src.includes(marker)) {
    console.log(`· ${name}: 已打过，跳过`);
    skipped++;
    return;
  }
  if (!src.includes(oldText)) {
    console.log(`✗ ${name}: 未找到锚点（pi-web-ui 版本可能已变化，需人工核对）`);
    skipped++;
    return;
  }
  src = src.replace(oldText, newText);
  applied++;
  console.log(`✓ ${name}`);
}

// ── 1) 辅助函数：从网关元数据构建 thinkingLevelMap ──
replace(
  "helper: buildThinkingLevelMapFromMeta",
  `function parseOpenAiModel(m) {
    const r = (m ?? {});
    const id = typeof r.id === "string" ? r.id : "";
    const name = (typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
        (typeof r.display_name === "string" && r.display_name.trim() ? r.display_name : undefined);
    const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
    const vision = modalities?.includes("image") === true ||
        boolMeta(r.supports_vision) === true ||
        boolMeta(r.vision) === true ||
        strArrMeta(r.input)?.includes("image") === true;
    // 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
    // 只增不减：取消勾选靠手填（编辑页/刷新合并都只补缺）。
    const reasoning = detectReasoningCapability(id, r);`,
  `function buildThinkingLevelMapFromMeta(r, reasoning) {
    if (!reasoning)
        return undefined;
    const supportedSet = new Set();
    const levels = strArrMeta(r?.reasoning_levels) ?? strArrMeta(r?.reasoningLevels) ?? strArrMeta(r?.supported_reasoning_levels?.map?.((x) => (typeof x === "string" ? x : x?.effort)));
    if (levels)
        for (const l of levels)
            if (typeof l === "string")
                supportedSet.add(l);
    if (Array.isArray(r?.supported_reasoning_levels))
        for (const e of r.supported_reasoning_levels)
            if (e && typeof e.effort === "string")
                supportedSet.add(e.effort);
    if (supportedSet.size === 0)
        return undefined;
    const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const map = {};
    for (const lvl of allLevels) {
        if (lvl === "off") {
            if (supportedSet.has("none"))
                map.off = "none";
            else if (supportedSet.has("off"))
                map.off = "off";
            else
                map.off = null;
        }
        else {
            map[lvl] = supportedSet.has(lvl) ? lvl : null;
        }
    }
    return map;
}
function parseOpenAiModel(m) {
    const r = (m ?? {});
    const id = typeof r.id === "string" ? r.id : "";
    const name = (typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
        (typeof r.display_name === "string" && r.display_name.trim() ? r.display_name : undefined);
    const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
    const vision = modalities?.includes("image") === true ||
        boolMeta(r.supports_vision) === true ||
        boolMeta(r.vision) === true ||
        strArrMeta(r.input)?.includes("image") === true;
    // 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
    // 只增不减：取消勾选靠手填（编辑页/刷新合并都只补缺）。
    const reasoning = detectReasoningCapability(id, r);`,
  "function buildThinkingLevelMapFromMeta"
);

// ── 2) 模块级 parseOpenAiModel：返回值携带 thinkingLevelMap ──
replace(
  "parseOpenAiModel (module) 返回 thinkingLevelMap",
  `    const reasoning = detectReasoningCapability(id, r);
    const contextWindow = numMeta(r.context_window) ?? numMeta(r.context_length) ?? numMeta(r.max_model_len) ?? numMeta(r.max_context_length);
    const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
    return {
        id,
        ...(name ? { name } : {}),
        ...(reasoning ? { reasoning: true } : {}),
        ...(vision ? { input: ["text", "image"] } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
    };
}
/** google-generative-ai /models shape:`,
  `    const reasoning = detectReasoningCapability(id, r);
    const contextWindow = numMeta(r.context_window) ?? numMeta(r.context_length) ?? numMeta(r.max_model_len) ?? numMeta(r.max_context_length);
    const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
    // 从端点暴露的 reasoning_levels / supported_reasoning_levels 推导 thinkingLevelMap，
    // 使模型真正支持的极高(xhigh)/最大(max) 等档位在 UI 中可见。
    const thinkingLevelMap = buildThinkingLevelMapFromMeta(r, reasoning);
    return {
        id,
        ...(name ? { name } : {}),
        ...(reasoning ? { reasoning: true } : {}),
        ...(vision ? { input: ["text", "image"] } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
}
/** google-generative-ai /models shape:`,
  "使模型真正支持的极高(xhigh)/最大(max) 等档位在 UI 中可见"
);

// ── 3) 静态方法 ModelAdminService.parseOpenAiModel：同样返回 thinkingLevelMap ──
replace(
  "ModelAdminService.parseOpenAiModel 返回 thinkingLevelMap",
  `        // 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
        const reasoning = detectReasoningCapability(id, r);
        const contextWindow = numMeta(r.context_window) ??
            numMeta(r.context_length) ??
            numMeta(r.max_model_len) ??
            numMeta(r.max_context_length);
        const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
        return {
            id,
            ...(name ? { name } : {}),
            ...(reasoning ? { reasoning: true } : {}),
            ...(vision ? { input: ["text", "image"] } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxTokens ? { maxTokens } : {}),
        };
    }`,
  `        // 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
        const reasoning = detectReasoningCapability(id, r);
        const contextWindow = numMeta(r.context_window) ??
            numMeta(r.context_length) ??
            numMeta(r.max_model_len) ??
            numMeta(r.max_context_length);
        const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
        const thinkingLevelMap = buildThinkingLevelMapFromMeta(r, reasoning);
        return {
            id,
            ...(name ? { name } : {}),
            ...(reasoning ? { reasoning: true } : {}),
            ...(vision ? { input: ["text", "image"] } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxTokens ? { maxTokens } : {}),
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        };
    }`,
  "        const thinkingLevelMap = buildThinkingLevelMapFromMeta(r, reasoning);"
);

// ── 4) toModelRow：UI 提交的模型行保留 thinkingLevelMap ──
replace(
  "toModelRow 保留 thinkingLevelMap",
  `            ...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
            ...(m.api?.trim() ? { api: m.api.trim() } : {}),
            ...(m.baseUrl?.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
        };`,
  `            ...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
            ...(m.api?.trim() ? { api: m.api.trim() } : {}),
            ...(m.baseUrl?.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
            ...(m.thinkingLevelMap && typeof m.thinkingLevelMap === "object" ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        };`,
  "m.thinkingLevelMap && typeof m.thinkingLevelMap === \"object\" ? { thinkingLevelMap: m.thinkingLevelMap } : {}"
);

// ── 5) mergeProviderConfigEntry：合并不丢 thinkingLevelMap ──
replace(
  "mergeProviderConfigEntry 保留 thinkingLevelMap",
  `        if (model.reasoning)
            merged.reasoning = true;
        else
            delete merged.reasoning;`,
  `        if (model.reasoning)
            merged.reasoning = true;
        else
            delete merged.reasoning;
        if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object")
            merged.thinkingLevelMap = model.thinkingLevelMap;`,
  "merged.thinkingLevelMap = model.thinkingLevelMap;"
);


// ── 6) 前端 bundle：候选模型采纳器默认只勾选现有模型 ──
// 位置：web/dist/assets/index-*.js（文件名带内容 hash，先动态发现）。

const webDist = pkgDir + "web/dist";
const indexPath = join(webDist, "index.html");
const CUR_BUILD = "Dh8BX-lP2";
const OLD_BUILD = "Dh8BX-lP";

function patchFrontend() {
  if (!existsSync(indexPath)) {
    console.log("✗ web/dist/index.html 不存在，跳过前端补丁");
    return;
  }
  let html = readFileSync(indexPath, "utf8");
  // 6a. index.html 已指向新文件名则跳过；否则复制 bundle 到新名字并改引用（assets 强缓存 1 年，必须换名）
  const curRef = `/assets/index-${CUR_BUILD}.js`;
  if (html.includes(curRef)) {
    console.log("· frontend: index.html 已指向新 bundle，跳过");
  } else {
    const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+)\.js/);
    if (!m) {
      console.log("✗ frontend: index.html 中找不到主 bundle 引用");
      return;
    }
    const srcBundle = join(webDist, m[0].slice(1));
    if (!existsSync(srcBundle)) {
      console.log(`✗ frontend: bundle 不存在 ${srcBundle}`);
      return;
    }
    let js = readFileSync(srcBundle, "utf8");
    // 6b. 候选模型采纳器：默认勾选现有模型（传 preselectedIds），仅当为空才回退"全部勾选"
    const pickOld = "function Lw({candidates:e,onAdopt:t,onClose:n}){let r=Z(),[i,a]=(0,_.useState)(``),[o,s]=(0,_.useState)(()=>{let t=new Set;";
    if (js.includes(pickOld)) {
      js = js.replace(pickOld,
        "function Lw({candidates:e,onAdopt:t,onClose:n,preselectedIds:r0}){let r=Z(),[i,a]=(0,_.useState)(``),[o,s]=(0,_.useState)(()=>{if(r0&&r0.length>0){let p=new Set(r0);let t0=new Set;for(let n of e)if(p.has(n.id))t0.add(n.id);if(t0.size>0)return t0}let t=new Set;", 1);
      // 补齐原逻辑剩余部分保持不变（初始 Set 填充在 pickOld 之后的代码里，无需改动）
      const callOld = "x&&(0,X.jsx)(Lw,{candidates:x,onAdopt:et,onClose:()=>S(null)})";
      if (js.includes(callOld)) {
        js = js.replace(callOld,
          "x&&(0,X.jsx)(Lw,{candidates:x,onAdopt:et,onClose:()=>S(null),preselectedIds:y?.models?.map(e=>e.id.trim()).filter(Boolean)??[]})", 1);
      } else {
        console.log("✗ frontend: 未找到候选器调用点锚点");
        return;
      }
      // 6c. 热重载比较常量：容忍新旧 buildId，避免升级窗口期循环刷新
      js = js.replace("a.buildId!==`" + OLD_BUILD + "`",
        "a.buildId!==`" + CUR_BUILD + "`&&a.buildId!==`" + OLD_BUILD + "`", 1);
      const dst = join(webDist, "assets", `index-${CUR_BUILD}.js`);
      writeFileSync(dst, js);
      html = html.replace(m[0], curRef);
      writeFileSync(indexPath, html);
      console.log(`✓ frontend: 已生成 ${basename(dst)} 并更新 index.html 引用`);
    } else if (js.includes("preselectedIds:r0")) {
      console.log("· frontend: 候选器补丁已存在（当前 bundle），跳过");
      return;
    } else {
      console.log("✗ frontend: 未找到候选器锚点（pi-web-ui 版本可能已变化）");
      return;
    }
  }
}
patchFrontend();

writeFileSync(target, src);
console.log(`\n完成：${applied} 个补丁应用，${skipped} 个跳过/缺失（pi-web-ui ${version}）`);
if (applied > 0) {
  console.log("提醒：重启 pi-web-ui 生效：sudo systemctl restart pi-web-ui");
}
