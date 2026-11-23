# DeepSeek Harness 插件接入说明

## 宿主 API 与数据流

`index.js` 声明 `inject = ['webServer', 'systemPrompt']`，进入 `apply(ctx)` 时调用 `installFairyPersona(ctx)` 与 `installFairySearch(ctx)`。

提示词使用 `ctx.systemPrompt.section()`：

- section 名为 `dsh-fairy-mode:tone`，全局注册，随插件卸载移除。
- 顺序为 `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 10`。
- `text` 是读取宿主内存状态的函数；每次提示词组装时选择 `prompts/fairy.md` 或 `prompts/normal.md`。
- `interpolate: false`，避免把可编辑提示词中的双花括号误当成运行时变量。
- 保存后发出 `system-prompt/change`；后续模型请求使用新状态，不取消已经在执行的请求。

这些接口对照了接入时官方仓库 master 中的 [system-prompt 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/src/index.ts)、[agent-loop 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts) 与 [webserver 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts)。这是源码对照，不代表已经做过运行验证。

```text
输入区开关 → PUT /hdd-persona → 校验 → 串行原子写盘
                                     → 更新宿主内存 → 通知提示词变化
下一次请求 → systemPrompt.section 的 text() → 当前语气提示词
```

`GET /hdd-persona` 返回：

```json
{ "enabled": false, "quotesEnabled": false, "scope": "harness", "effective": "next-request", "reference": { "available": true, "filename": "fairy-voice-reference.txt", "bytes": 0, "sha256": "具体值由宿主按文件计算" } }
```

`PUT /hdd-persona` 请求：

```http
Content-Type: application/json
X-Fairy-Request: 1

{ "enabled": true }
```

成功返回与 GET 相同的结构。参数仅允许布尔 `enabled` / `quotesEnabled`，至少提供一个，请求体上限 1 KiB；不支持的 HTTP 方法返回 405，格式错误返回 400/415，跨站请求返回 403，写盘失败返回 500。失败时保持原内存状态。路由沿用宿主的请求入口，不增加公开监听端口或认证绕过。

状态写入 `$DSH_FAIRY_STATE_DIR/fairy-persona.json`，未配置时依次使用 `$DSH_HOME`、`~/.dsh`。写入临时文件再重命名，同一宿主内的写请求串行处理。多个独立进程不要共用一个设置文件来实现实时同步。

前端只在宿主确认成功后更新开关；有 10 秒请求超时、错误提示、重复点击锁和卸载清理。保存响应丢失时会重新读取，避免误判服务端是否已保存。窗口聚焦、页面恢复可见、可见状态下每 15 秒同步一次。

## 语录参考

`references/fairy-voice-reference.txt` 包含 6 条注明来源的短摘录（其中 2 条为英文剧情原句并附中文释义）、语气分析和 24 组原创对话示例。所有原创内容显式标记，不作为游戏原文或剧情证据。

输入区新增 `hdd-quotes` 控件，顺序 1.5，标签为「语录参考」，旁边有 TXT 查看链接。与语气开关共用 `/hdd-persona` 与同一份原子持久化状态。

- 兼容旧 `{ version: 1, enabled: boolean }` 设置，新增 `quotesEnabled` 缺省为 `false`。
- `PUT /hdd-persona` 接受 `enabled`、`quotesEnabled` 中任一或两者，值必须为布尔。
- `{ "quotesEnabled": true }` 会自动开启语气；`{ "enabled": false }` 会同时关闭语录。
- `{ "enabled": false, "quotesEnabled": true }` 返回 400，避免互相矛盾的设置。
- GET/PUT 返回包含两个开关和 `reference: { available, filename, bytes, sha256 }` 的最新状态。
- `GET/HEAD /hdd-persona-reference.txt` 返回实际载入的 UTF-8 TXT，前端可直接查看。
- 参考文件在插件加载时读取，支持 UTF-8 BOM，非空且不得超过 32 KiB；不可用时只禁用语录参考。
- 新 section 为 `dsh-fairy-mode:quote-reference`，顺序为 persona suffix + 11，`interpolate: false`。只有语气和语录同时开启时才包含参考全文，关闭后返回空字符串。
- 参考内容以明确的文件名与 SHA-256 包装进入模型上下文，用户不必手动上传；不会训练模型权重。修改文件需重新加载插件。
- 客户端保存成功后发出页面内 `hdd-persona-change` 事件，两个控件立即从宿主同步状态，其他窗口继续使用现有轮询。


## 当前版本适配要点

已在 **DSH 0.2.0-rc.2**上完成桌面端适配。

1. **客户端模块 id 必须等于包名**。`dsh-client-modules` 用包名做 boot graph 的 row key，旧 id `@local/dsh-hdd-overlay` 会得到 “bundle … loaded without registering `dsh-fairy-mode`”。现为 `id: 'dsh-fairy-mode'`。
2. **`single` 槽位要覆盖官方占位必须换 priority**。`conversation.hero.brand.mark`、`sidebar.brand.mark`、`sidebar.brand.name` 是单占位槽，`SlotCore.register()` 在相同 priority 上二次注册会抛 `single slot "…" already has a registration`；`ui-brand-official` 就占着它们。改为 `priority: -1`（最低者渲染）即合法接管，卸载后官方徽记自动回来。
3. **`ctx.tools.register(definition)` 在 0.2.0-rc.2 只接受一个参数**。上游的第二个 `{ when }` 可用性门控在本版本不存在（多余参数被忽略、并不会生效），已删除；改为在 `execute` 内按 `ctx.get('web')?.search` 是否存在返回 503 说明。
4. **设置文件读取要容忍 UTF-8 BOM**。`Set-Content -Encoding utf8`（PowerShell 5.1）与部分编辑器会写 BOM，`JSON.parse` 直接失败并把语气静默重置为关闭；`loadSettings()` 现在先 `replace(/^\uFEFF/,'').trim()` 再解析。

## 联网检索接口

搜索能力对照官方 [web 服务类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web/src/types.ts)、[web 服务实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web/src/index.ts) 和 [web_search 工具实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/tool-web/src/search.ts)。调用形式为 `ctx.get('web').search({ query, maxResults }, signal)`，不自行访问搜索供应商，也不读取或返回凭据。

`GET /hdd-search` 只检查搜索接口是否存在，不发起外部请求，也不声称 provider 或凭据已验证。`connected: true` 表示服务接口存在，实际可用性仍以检索为准。

```http
POST /hdd-search
Content-Type: application/json
X-Fairy-Request: 1

{ "queries": ["DeepSeek Harness 插件文档", "site:github.com deepseek-harness systemPrompt"], "maxResults": 8 }
```

- `queries` 必填，1–3 个检索式，每个不超过 200 字符；精确重复的关键词只搜索一次。
- `maxResults` 可选，1–12，默认 8，是合并后的来源上限；每个检索式也将该上限传给搜索服务。
- 同一宿主最多同时处理 3 个检索批次，每批最多 3 个搜索调用；超过返回 429。
- 每批 35 秒取消预算，转发给 provider；调用方断开、主动取消与插件卸载都会传递取消信号。超时回收依赖 Harness provider 遵守取消协议。
- 多关键词并发、结果交替合并、去重；有关键词失败时保留已完成结果并返回警告。全部失败则返回错误，不使用模拟结果。
- 来源仅接受无内嵌凭据的 HTTP/HTTPS URL，过滤片段和常见跟踪参数。前端使用 React 文本节点，不将摘要当 HTML 插入，也不自动抓取来源图片或网页。
- 返回 `headline`、`queries`、`sources`、`briefs`、`warnings`、`truncated`、`domains`、`elapsedMs`、`searchedAt`、`verification`、`trustNotice` 和 `report`。
- `sources` 中每条包含 `id`、`title`、`url`、`domain`、`excerpt`、`publishedAt`、`verification`；缺失时间或摘要不补造。`verification` 固定为 `search-excerpt-only`，不会把搜索命中标成已核验。
- `briefs` 是 provider 原本返回的可选摘要，只用于展示与阅读，不把它当成独立事实证明。`report` 是带来源的纯文本情报报告，不额外调用模型合成。

模型工具 `fairy_search` 通过 `ctx.inject(['tools'], ...)` 可选注册，使用 Harness 接受的原始 JSON Schema 定义，不引入额外运行依赖。参数与 POST 相同，输出为 `{ report: string }`，提供给模型阅读。执行转发 `exec.signal`。注意 0.2.0-rc.2 的 `tools.register()` **只有一个参数**，上游的 `web.searchReady(...)` 门控（第二参数 + 该方法本身）在本版本都不存在，已移除；搜索服务缺失时由 `execute` 返回 503 说明，而不是把工具藏起来。

前端入口为输入区 `hdd-search` 槽位，顺序 2；面板渲染到 `shell.overlay`，默认不绘制遮罩，显式打开才显示。支持 Escape/关闭/遮罩关闭、Tab 焦点约束、取消按钮、45 秒前端超时和复制报告。面板搜索仅显式提交时发生，不在输入过程中自动发送请求；关闭面板会取消进行中的请求。语气、检索、朗读互相独立。
