# model-schedule

pi-web-ui 插件：为 `~/.pi/agent/model-schedule.jsonc`（主 bot / 子 bot 按时段的模型调度配置）提供网页配置页。

配套的 pi 扩展在 `~/.pi/agent/extensions/model-schedule/index.ts`：注册虚拟模型 `schedule/auto` 按时间窗路由主 bot，`tool_call` 钩子按窗口注入/禁用子 bot 模型。**扩展每次路由都重读配置文件，本插件保存后即生效，无需重启。**

## 功能

- **时区选择器**（v0.2.0）：`Intl.supportedValuesOf("timeZone")` 全量 IANA 列表，可搜索（输入 `shanghai` / `tokyo` 都能命中），分「常用 / 亚洲 / 欧洲 / 美洲 …」分组，**每行直接显示当前 UTC 偏移与当地时间**，底部一个「使用本机时区」按钮。工具条旁常驻「当地 HH:MM · UTC+X」实时回显。旧版是自由文本输入，得背 `Asia/Shanghai`，打错就整表按 UTC 错位且毫无提示。
- **当前状态条**：显示时区、本地时间、当前命中的时间窗（或 default 兜底）与命中原因。
- **窗口卡（可折叠）**：默认只展开「当前生效」的那张，其余折叠成一行摘要（`窗口 2　23:00–09:00 · 每天`），点卡片头展开/收起；工具条有「全部展开/收起」。当前生效的卡片带蓝色描边 + 「生效中」标记。
- **时间与星期一行**：起止时间用原生 `<input type="time">`（支持跨午夜，如 `22:00`–`06:00`；结束留空 = 当天 24:00），星期多选（不勾 = 每天），另带「工作日 / 周末 / 全周 / 清空」快捷按钮。
- **模型下拉可搜索**：50+ 模型时原生 select 无法查找，换成按钮 + 浮层（搜索模型名 / id / 分组，按 provider 分组）。选项只在 id 尾段与显示名确实不同时才补 id，避免「GLM-5.3-Flash zcode/GLM-5.3-Flash」这种重复。
- **思考档中文**：`关闭（off）/ 极简（minimal）/ 低（low）/ 中（medium）/ 高（high）/ 极高（xhigh）/ 最大（max）`，括号内保留原始档位名便于对照配置文件。
- **子 bot 三态（自动列出全部模板，无需手填名字）**：
  - `继承`（默认，不写配置）——跟随窗口模型；
  - `覆盖`——单独指定模型 / 思考档，写入 `subagents.agents.<模板名>`；
  - `禁用`——写入 `enabled: false`，扩展侧会直接拒绝 spawn 该子 bot。
  
  模板清单由 `GET /api/subagents` 动态提供（pi-web-ui 内置 + 用户自定义模板），带中文描述；已配置（覆盖/禁用）的行常驻展示，继承中的行默认折叠，避免 13 模板 × N 窗口把页面拉得很长。
- **永不生效窗口告警**：按「顺序第一个匹配」规则，用 7×1440 槽位精确计算，若某窗口的全部时段已被前面的窗口覆盖，卡片会标红并**点名是被第几个窗口遮蔽的**（旧版只说「被前面的窗口覆盖」，用户无从下手）。
- **未保存修改保护**：任何改动点亮工具条上的「● 未保存」；关页面/刷新会触发浏览器拦截；「重读」在有改动时二次确认；保存成功后自动熄灭。
- **default 卡**：无窗口命中时的兜底配置，结构同窗口卡（无时间字段）。
- **保存**：工具条吸顶常驻，全量 POST 到服务端，服务端做严格校验（时间格式、days 范围、model 非空字符串、thinking 合法档位），失败返回 400 逐条报错、不落盘；成功后按 JSONC 风格写回原文件并**保留文件头部注释块**。缺 `Content-Type: application/json`、空 body、空配置一律 400 拒绝，防止误清空配置。
- 模型下拉按**模型 id 第二段分组**（`auto` / `zcode` / `codearts` / `workbuddy` / `nvidia` …），因为 provider 段对所有模型都一样，拿它分组等于没分组。

## 服务端路由

均挂在 `/plugins-api/model-schedule/api/` 下（同进程直读文件，不依赖扩展）：

| 路由 | 说明 |
| --- | --- |
| `GET /api/config` | 读配置文件，JSONC 解析为 JSON 返回（`{ ok, exists, config, header, path }`）；解析失败返回 500 + 错误详情；文件不存在返回 `{ ok: true, exists: false }` |
| `POST /api/config` | body `{ config: {...} }`；校验失败 400 `{ ok:false, errors:[...] }` 不落盘；成功写回并保留原文件头注释块 |
| `GET /api/models` | 读 models.json 输出 `{ ok, models: [{ id: "magpie/<id>", label }] }` |
| `GET /api/subagents` | 全部可用子 bot 模板 `{ ok, agents: [{ id, label, description }] }`（内置 + 用户自定义合并） |
| `GET /api/effective` | 用与扩展侧一致的匹配逻辑算当前生效窗口，返回时区、本地时间、`matched`（`window` / `cross-midnight-tail` / `default`）、命中原因、命中的窗口/兜底详情，以及 **`windowIndex`**（命中窗口在 `windows[]` 中的下标，`-1` = 兜底；前端靠它高亮卡片） |

匹配语义与扩展侧 `matchWindow` 一致：数组顺序第一个命中的窗口生效；跨午夜窗口（start > end）归属日按 start 那天算；`days` 缺省 = 每天。

## 权限

`manifest.json` 只声明实际用到的最小集合：`fs:read`（读配置与模型清单）、`fs:write`（写回配置）、`http`（挂路由）。不申请 net / llm / tools。文件访问走服务端同进程 `node:fs`，目标文件固定为 `~/.pi/agent/` 下的 `model-schedule.jsonc` 与 `models.json`（环境变量 `MODEL_SCHEDULE_CONFIG` / `MODEL_SCHEDULE_MODELS` 可覆盖，测试用）。

`settings` 数组留空——配置本体走「设置 → 模型调度」自定义页面（manifest `ui.settings.pages`），不走 manifest 平铺设置。

## 开发与生效

- 目录含两份 SDK 拷贝（宿主要求）：服务端用 `sdk/`，客户端用 `client/sdk/`（`client/entry.mjs` 只允许 import `./sdk/index.mjs`，宿主只暴露 `client/*`，越界 import 会让整个 bundle 不执行）。升级 SDK 拷贝：`pi-web-ui plugin upgrade-sdk model-schedule`。
- **改完代码如何生效**：刷新浏览器即可（宿主在运行时重新加载客户端 bundle 并重跑服务端 `activate`）；若刷新未见效，可在设置面板里对插件做一次停用/启用，或向 WebSocket 发送 `plugins_reload`。服务未运行时则下次启动生效。
- 自检：`plugin create` 生成时已跑 manifest 校验 + `node --check` + 静态 import 自检；改动后可再跑：
  `node --input-type=module -e "const m = await import('./sdk/import-check.mjs'); console.log(m.checkPluginImports(process.cwd()))"`

## 本地自测（不启动宿主）

```bash
node test/run.mjs
```

测试通过 `MODEL_SCHEDULE_CONFIG` / `MODEL_SCHEDULE_MODELS` 环境变量把文件指到临时副本，直接 import 服务端入口并调用 `host.route` 注册的 handler，覆盖：

1. GET config 的 JSONC 往返（读 → POST 修改 → 再读，头注释块保留）；
2. POST config 的校验拒绝路径（非法时间 / 非法 thinking / 缺 Content-Type → 400 不落盘）；
3. GET models 的 `magpie/<id>` 列表；
4. GET effective 的窗口命中（白天窗口 / 跨午夜尾段 / default 兜底）与 `windowIndex` 一致性。

> 注：`call()` 在带 body 时默认补 `Content-Type: application/json`；要测「缺头被拒」显式传 `{}` 作为第 4 个参数。

## 界面预览（不启动宿主）

`/data/workspace/ms-preview/` 里有一个最小预览页：`node server.mjs` 后开 `http://127.0.0.1:8899/`，它用真实 `model-schedule.jsonc` + `models.json` 造 fixture，直接挂载 `client/entry.mjs`，可用来截图或手点验证（`?popup=tz` / `?popup=model` 会自动展开对应下拉）。
