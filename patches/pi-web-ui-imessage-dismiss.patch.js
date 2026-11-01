#!/usr/bin/env node
/**
 * pi-web-ui 补丁：iMessage 会话管理（imessage-dismiss）
 *
 * 三件事：
 *  1. 历史去重：本端运行列表持有的 transcript 会话不再重复出现在「历史对话」；
 *     对话移出/关闭后 800ms 内重推历史列表（pushSessions 展示侧过滤）。
 *  2. 插件移出链路：host.dismissConversation → conversationDismisser → dismissForPlugins
 *     → dismissConversation（转录保留，可从历史重开）；假成功防护=移除后核实确实不在。
 *  3. 子代理不出现在插件的运行列表（listRunningForPlugins 跳过 isSubagent）。
 *
 * 用法：node ~/.pi/agent/patches/pi-web-ui-imessage-dismiss.patch.js
 * 适用版本：pi-web-ui 0.114.2（dist/server 四个文件）。
 * 幂等：指纹行已存在 → SKIP 该处；锚点命中数 ≠1 → 明确报 SKIP，不写坏文件。
 * 打完需重启：sudo systemctl restart pi-web-ui
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPS = [
  {
    "file": "agent-service.js",
    "anchor": "                await this.interruptRun(conv, \"插件已中止运行\");\n                this.flushSnapshot();\n            }\n            return { ok: true };\n        }\n        catch (err) {\n            return { ok: false, error: err.message };\n        }\n    }",
    "insert": "\n    /** 插件扩展点 v2（供会话移出）：只移出空闲对话，转录保留可从历史重开。\n     *  dismissConversation 本身是 async 且内部已有流式/保留态保护，这里的预检\n     *  只为返回更明确的错误文案。 */\n    async dismissForPlugins(id) {\n        try {\n            const conv = this.convs.get(String(id ?? \"\").trim());\n            if (!conv)\n                return { ok: false, error: `未知对话：${id}` };\n            if (conv.isSubagent)\n                return { ok: false, error: \"子代理请在网页端管理\" };\n            if (this.conversationStreaming(conv))\n                return { ok: false, error: \"对话正在运行，请先停止\" };\n            await this.dismissConversation(String(id), false, false);\n            // dismissConversation 被拒时只发 WebUI notice、不返回结果（终端未关/\n            // 后台任务/已结束子代理等路径），这里以移除结果为准回执，杜绝假成功。\n            if (this.convs.get(String(id ?? \"\").trim()))\n                return { ok: false, error: \"移出被拒绝：对话存在未收尾状态（终端/后台任务/子代理），请在网页端处理后重试\" };\n            return { ok: true };\n        }\n        catch (err) {\n            return { ok: false, error: err.message };\n        }\n    }",
    "fp": "插件扩展点 v2（供会话移出）",
    "join": "append"
  },
  {
    "file": "agent-service.js",
    "anchor": "            void conv.runtime.dispose().catch(() => { });\n",
    "insert": "        // 对话已移出：runtime 释放后 transcript 文件不再被本端持有，pushSessions 的\n        // heldFiles 过滤会放行它 —— 必须重推历史列表，否则刚关掉的会话在历史面板里\n        // 缺一条。防抖 800ms（见 scheduleSessionsRefresh），批量关闭只推一次。\n        this.scheduleSessionsRefresh();\n",
    "fp": "// 对话已移出：runtime 释放后 transcript 文件不再被本端持有，pushSess",
    "join": "append"
  },
  {
    "file": "agent-service.js",
    "anchor": "            const visibleInfos = filterForkedParentSessions(infos, showForkedParents);",
    "insert": "\n            // 本端已打开的对话（运行列表里持有其 transcript 文件的会话）：历史列表不再\n            // 重复展示 —— 同一条记录只出现在「运行的对话」里，不两处各留一份。写入侧\n            // switchSession 已有单 writer 保护（同一文件复用已有 runtime，绝不重复打开），\n            // 这里补的是展示侧口径：本端持有 → 从历史里隐藏；runtime 释放、对话关闭\n            // （removeConversation / dismissConversation 收尾都会重推）后集合缩小，\n            // 条目自然回到历史列表。\n            const heldFiles = new Set();\n            for (const conv of this.convs.values()) {\n                try {\n                    const f = conv.session.sessionFile;\n                    if (f)\n                        heldFiles.add(normalizePathKey(f));\n                }\n                catch {\n                    // 会话替换中——按未持有处理\n                }\n            }",
    "fp": "// 本端已打开的对话（运行列表里持有其 transcript 文件的会话）：历史列表不再",
    "join": "newline"
  },
  {
    "file": "agent-service.js",
    "anchor": "            for (const s of visibleInfos) {",
    "insert": "\n                // 已在本端运行列表里打开 → 历史列表跳过（不重不漏）。\n                if (heldFiles.has(normalizePathKey(s.path)))\n                    continue;",
    "fp": "// 已在本端运行列表里打开 → 历史列表跳过（不重不漏）。",
    "join": "newline"
  },
  {
    "file": "index.js",
    "anchor": "            return await cs.abortForPlugins(id);\n        }\n        catch (err) {\n            return { ok: false, error: err.message };\n        }\n    };",
    "insert": "\n    // conversationDismisser：移出空闲对话（复用 dismissConversation，转录保留可从历史重开）。\n    pm.conversationDismisser = async (id) => {\n        try {\n            const cs = pickClient();\n            if (!cs || typeof cs.dismissForPlugins !== \"function\")\n                return { ok: false, error: \"not supported\" };\n            return await cs.dismissForPlugins(String(id));\n        }\n        catch (err) {\n            return { ok: false, error: err.message };\n        }\n    };",
    "fp": "// conversationDismisser：移出空闲对话（复用 dismissConversa",
    "join": "newline"
  },
  {
    "file": "plugins.js",
    "anchor": "                    return await self.runAborter(String(conversationId));\n                }\n                catch (err) {\n                    return { ok: false, error: err.message };\n                }\n            },",
    "insert": "\n            dismissConversation: async (conversationId) => {\n                try {\n                    if (!self.conversationDismisser)\n                        return { ok: false, error: \"宿主未接入对话移出（仅标准 pi 引擎支持）\" };\n                    return await self.conversationDismisser(String(conversationId));\n                }\n                catch (err) {\n                    return { ok: false, error: err.message };\n                }\n            },",
    "fp": "return { ok: false, error: \"宿主未接入对话移出（仅标准 pi 引擎支持）",
    "join": "newline"
  },
  {
    "file": "plugin-api-catalog.js",
    "anchor": "    { name: \"abortRun\", needs: \"-\", summary: \"中止指定对话的运行\", example: `await host.abortRun(convId)` },",
    "insert": "\n    { name: \"dismissConversation\", needs: \"-\", summary: \"移出空闲对话（转录保留，可从历史重开）\", example: `await host.dismissConversation(convId)` },",
    "fp": "{ name: \"dismissConversation\", needs: \"-\", summary",
    "join": "newline"
  },
  {
    "file": "agent-service.js",
    "anchor": "            out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: \"running\", isStreaming });",
    "insert": "            if (conv.isSubagent)\n                continue; // 子代理由网页端管理，不进插件会话列表\n            out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: \"running\", isSubagent: Boolean(conv.isSubagent), isStreaming });",
    "fp": "continue; // 子代理由网页端管理，不进插件会话列表",
    "join": "replace",
    "mode": "replace"
  }
];
const base = homedir() + "/.pi/agent/npm/node_modules/pi-web-ui/dist/server/";
let applied = 0, skipped = 0;
for (const op of OPS) {
  const p = join(base, op.file);
  let s;
  try { s = readFileSync(p, "utf8"); } catch { console.log(`SKIP ${op.file}: 文件不存在`); skipped++; continue; }
  if (s.includes(op.fp)) { console.log(`SKIP ${op.file}: ${op.fp.slice(0, 30)}… 已打过`); skipped++; continue; }
  const n = s.split(op.anchor).length - 1;
  if (n !== 1) { console.log(`SKIP ${op.file}: 锚点命中 ${n} 次（期望 1），人工核对`); skipped++; continue; }
  let out;
  if (op.join === "replace") out = s.replace(op.anchor, op.insert);
  else if (op.join === "append") out = s.replace(op.anchor, op.anchor + op.insert);
  else out = s.replace(op.anchor, op.anchor + op.insert);
  writeFileSync(p, out);
  console.log(`OK   ${op.file}: ${op.fp.slice(0, 24)}…`);
  applied++;
}
console.log(`done: ${applied} applied, ${skipped} skipped`);
