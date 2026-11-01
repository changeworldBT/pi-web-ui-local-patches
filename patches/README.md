# pi-web-ui 本机补丁

## thinking-levels（极高/最大档位）

- 目标文件：`~/.pi/agent/npm/node_modules/pi-web-ui/dist/server/model-admin.js`
- 作用：
  1. 「刷新模型列表」时从网关 `/v1/models` 的 `reasoning_levels` / `supported_reasoning_levels`
     自动推导 `thinkingLevelMap`，极高(xhigh)/最大(max) 档出现在 WebUI 思考强度下拉中；
  2. 保存/合并模型配置时不再丢弃 `thinkingLevelMap` 字段。
- 验证版本：pi-web-ui **0.112.0**。升级后跑：

```bash
node ~/.pi/agent/patches/pi-web-ui-thinking-levels.patch.js
sudo systemctl restart pi-web-ui
```

- 幂等：可重复执行；锚点不匹配（版本大改）时会明确报 SKIP，不会写坏文件。
- 配套数据：`~/.pi/agent/models.json` 中 magpie 各模型的 `thinkingLevelMap`
  已按网关自报能力写入（32 个模型）。升级 pi-web-ui 不会动这个文件，无需重做。
  若将来 magpie 新增模型，在 WebUI 点「刷新模型列表」即可（补丁会让新模型自动带档位）。

## approval-rm-rf（rm -rf 误报风暴）

- 目标文件：`~/.pi-web/approval-rules.json`（pi-web-ui 官方自定义审批规则，**mtime 热生效，不重启**）
- 现象：任何 `rm -f /绝对路径`、`rm -rf /某目录` 都弹「递归/强制删除大范围路径 (rm -rf)」；
  连 `grep -rn "rm -f /" ...`、heredoc 文档里的 `rm -rf /data/x` 文本也弹。
- 根因：默认规则 `builtin.bash.rm-rf` 正则的目标组只锚到目标路径的**首字符**，
  缺尾随词边界 —— `rm -f /tmp/a` 被摘成 `rm -f /` 判成删根。
- 修复：目标必须是完整危险 token（`/`、`/*`、`/usr`·`/etc`·`/home` 等顶层系统目录（含 `/*`）、
  `~`、`../`、`*`、`./`、`.`、`C:\`）且后跟空白/行尾/`;`/`&`/`)`；
  另加 `custom.bash.quoted-shell-rm-root` 补回 `bash -c "rm -rf /"` 场景。
- 用法（升级 pi-web-ui 后重跑，同步新版默认规则 + 重新收紧）：

```bash
node ~/.pi/agent/patches/approval-rm-rf-fix.mjs --force   # 重建
node ~/.pi/agent/patches/approval-rm-rf-fix.mjs           # 只查状态
```

- 幂等；无 `--force` 时不覆盖现有文件。验证版本 pi-web-ui **0.112.0**。
- 回归样本（14 条，全部 PASS）：误报侧 `rm -f /tmp/x`、`rm -rf /data/home/qloop`、
  `grep -rn "rm -f /"` 不弹；拦截侧 `rm -rf /`、`rm -rf /*`、`rm -rf /usr`、`rm -rf ~/`、
  `rm -rf *`、`rm -rf ..`、`bash -c "rm -rf /"` 仍弹。

## candidate-picker 默认勾选现有模型（第 2 项补丁，同脚本）

- 现象：模型管理里点「自动获取并采纳模型」，候选模型采纳器每次打开都全部勾选，
  每次都要重新手动去掉不需要的。
- 修复：采纳器打开时默认只勾选当前已保存的模型（`preselectedIds` 传入表单里已有
  模型 id）；无既有模型时保持原行为（排除 embed/audio/tts/whisper 后全选）。
- 前端 bundle 文件名带内容 hash 且 `assets/` 走 1 年 immutable 强缓存，所以脚本会
  把补丁后的 bundle 复制为新文件名 `index-Dh8BX-lP2.js` 并改写 `index.html` 引用；
  同时把客户端热重载比较常量改为同时容忍新旧 buildId，避免升级窗口期循环刷新。
- 生效条件：**无需重启服务**（静态文件即时读取；仅 buildIdCache 可能残留旧值，
  脚本已通过双值容忍规避）。浏览器强制刷新一次（Ctrl+Shift+R）即可加载新 bundle。

## imessage-dismiss（iMessage 会话管理与移出）

- 目标文件：`~/.pi/agent/npm/node_modules/pi-web-ui/dist/server/` 下 4 个文件
  （agent-service.js / index.js / plugins.js / plugin-api-catalog.js）
- 作用：
  1. 历史去重：运行列表持有的会话不再出现在「历史对话」；移出/关闭后 800ms 重推；
  2. 插件移出链路：`host.dismissConversation` → `conversationDismisser` → `dismissForPlugins`
     → `dismissConversation`（转录保留；假成功防护=移除后核实确实不在）；
  3. 子代理不出现在插件的运行列表（`listRunningForPlugins` 跳过 `isSubagent`）。
- 验证版本：pi-web-ui **0.114.2**。升级后跑：

```bash
node ~/.pi/agent/patches/pi-web-ui-imessage-dismiss.patch.js
sudo systemctl restart pi-web-ui
```

- 幂等：指纹行已存在 → SKIP；锚点命中数 ≠1 → SKIP 并提示人工核对，不写坏文件。
- 配套插件端：github.com/changeworldBT/pi-web-photon（/remove、/sessions 主会话列表）。
