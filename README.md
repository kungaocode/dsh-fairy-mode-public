# DSH Fairy Mode

基于 [RengeRenge/DSH-Fairy-Mode](https://github.com/RengeRenge/DSH-Fairy-Mode) 的非官方 DeepSeek Harness 同人扩展，提供《绝区零》Fairy 风格的 H.D.D 皮肤、开屏动画、可切换的聊天语气、语录参考、联网检索和可选朗读。

## 安装

在 DeepSeek Harness 桌面版中使用过一次 `desktop` profile 后，从托盘完全退出 Harness，再运行：

```powershell
dsh plugin --profile desktop add github:kungaocode/dsh-fairy-mode-public
```

如果之前安装过同名插件，先运行 `dsh plugin --profile desktop remove dsh-fairy-mode`。如果 `dsh` 未加入 PATH，可使用安装目录的命令：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add github:kungaocode/dsh-fairy-mode-public
```

也可克隆后，从项目根目录执行 `dsh plugin --profile desktop add (Get-Location).Path`。安装完成后重新打开 Harness。适配基线为 DeepSeek Harness **0.2.0-rc.2**。

## H.D.D 装饰开关

原来右上角的 **H.D.D** 标签现在可点击，也可用键盘操作。亮点为蓝色表示开启，灰色表示关闭。

空白会话会隐藏宿主标题栏。此时右上角自动显示备用 H.D.D 开关；原标题栏开关可见时隐藏备用按钮。即使关闭装饰或切换页面，开关仍可访问。

欢迎页中间的小 Fairy 图标已移除，保留 H.D.D 字标；侧栏 Fairy 动图的位置、大小与动画保持不变。

- 开启：挂载现有 HDD 皮肤、Fairy 装饰和动画，加载开屏视频；欢迎页替换为两行大写的 `H.D.D`、`HOLLOW DEEP DIVE SYSTEM`。侧栏 Fairy 动图的槽位、尺寸和动画保持原版。
- 关闭：立即暂停并释放视频，移除开屏、装饰样式和动图，恢复原欢迎页标题、开启前的主题及聊天框下方的原生工具栏。Fairy 语气、语录、检索、电费与朗读控件一起隐藏，当前朗读停止；保存的语气、语录和朗读偏好保留，重新开启后恢复控件。H.D.D 开关保持可见。
- 状态保存在当前浏览器/Electron 的 `localStorage.hddEnabled`，重启后恢复；首次默认开启。旧 `hddBoot=off` 设置会作为首次默认关闭的依据。
- 手动重新开启会重播视频，即使页面已经打开超过 20 秒。自动冷加载保留上游的一次播放规则；系统开启减少动态效果时不播放开屏。
- 视频播放期间可点右上角 `H.D.D · 关闭` 直接结束装饰模式。关闭后不再请求视频和开屏背景图，已传输的数据不会因关闭而从浏览器缓存中删除。

## 语气开关的行为

| 项目 | 行为 |
| --- | --- |
| 默认值 | 首次安装关闭 |
| 开启 | 称呼自然使用「主人」「您」，自称「我」，表达冷静、简洁，带少量协议式提示与克制幽默 |
| 关闭 | 明确结束插件人设，保留任务上下文并恢复原有助手/预设的表达方式 |
| 生效范围 | 当前 Harness 实例内的全部会话，包括继承全局提示词的子代理；不是单会话开关 |
| 生效时机 | 保存成功后的下一次模型请求；已经发出的请求和已经显示的消息不回改 |
| 状态同步 | 切回窗口时刷新；可见页面每 15 秒刷新，多个窗口以宿主状态为准 |
| 与朗读的关系 | 完全独立。语气开关不启动 TTS，不下载权重，不增加语音调用 |
| 其他输出 | 代码、命令、路径、日志和 JSON 保持原样；不为人设编造概率或执行结果 |

语气通过提示词实现，具体表达取决于所用模型。对话中说「正常说话」「退出人格」「别叫我主人」，提示词要求模型立即尊重该偏好；这不会修改磁盘开关。如需持久关闭，请点击开关。

## Fairy 联网检索

搜索使用你已经在 Harness 中选择的联网搜索服务，不需要在本插件额外填写 API Key。先在 Harness 中把搜索服务与所需凭据配置好；本插件不创建另一套搜索账户，也不自动安装搜索后端。

输入框右侧点击 **Fairy 检索**，输入目标后点击「开始检索」。支持每行一个关键词检索式，最多 3 个；单个目标通常只需一行。不同关键词的结果交替合并，去掉重复链接与常见跟踪参数，最多显示 8 条来源。报告提供真实检索耗时、来源站点和搜索服务给出的时间信息，不伪造可信度评分。

界面采用 Fairy 式「检索待命 → 正在查询 → 查询完成 → 情报报告」表达。每条线索均可打开来源，摘要明确标为待核验；部分关键词失败时保留其他成功结果并提示缺失。可取消检索，也可复制完整报告粘贴到当前会话继续分析。面板结果不会自动发送给模型。

助手还可直接调用 `fairy_search` 工具，例如对它说：

```text
Fairy，帮我联网检索 DeepSeek Harness 的插件开发文档，
整理关键接口，附上来源；关键结论请阅读原文核验。
```

工具在当前组合具有 `tools` 和可用的 `web` 搜索入口时注册/提供，遵从 Harness 的工具调度与权限规则。是否实际可调用取决于当前预设和搜索凭据；没有服务时面板给出配置提示，不编造结果。联网检索与语气开关独立；开启语气后，助手会按「结论 → 证据 → 来源 → 未知项」组织情报，关闭后仍可正常搜索。

本插件提供 `GET /hdd-search` 连接状态接口、`POST /hdd-search` 搜索接口，及模型工具 `fairy_search`，具体参数见 [HANDOFF.md](./HANDOFF.md)。

## 语录参考文件

文件为 [references/fairy-voice-reference.txt](./references/fairy-voice-reference.txt)，包含有出处的短摘录、语气特点归纳和 24 组原创少样本对话。每条摘录都记录来源；英文游戏文本的中文释义与中文原句明确区分，原创例句不冒充游戏台词。

输入区点击 **语录参考** 即可开启。开启时自动启用 Fairy 语气；关闭 Fairy 语气会同时关闭语录参考。只关闭语录参考会继续使用基础 Fairy 提示词。两个状态一起持久保存，旧版本的设置文件可继续读取，新增开关默认关闭。

宿主读取 TXT 的内容并作为独立系统提示词 section 传给模型，从下一次模型请求起生效。这里是上下文参考，不是模型微调，也不是依赖模型自行打开一个本地路径。可以点击旁边的 **TXT** 查看实际注入的文件内容。

参考文件有 32 KiB 上限；如果缺失、为空或过大，语录开关不可用，基础语气和其他功能照常使用。修改 TXT 后重新加载插件或重启 Harness，宿主会读入新版内容；接口返回文件字节数与 SHA-256，便于确认版本。启用参考会增加发送给模型的上下文长度。

## 修改提示词

编辑 `prompts/fairy.md` 即可调整称呼、口头禅、幽默强度和表达示例。`prompts/normal.md` 用于关闭时明确取消旧人设，减少历史消息残留的影响。修改提示词后需要重启或重新加载插件。

状态文件为 `$DSH_HOME/fairy-persona.json`，没有 `DSH_HOME` 时使用用户目录下 `.dsh/fairy-persona.json`。可通过 `DSH_FAIRY_STATE_DIR` 指定独立目录，例如让不同 Harness 实例分别保存状态。文件格式：

```json
{
  "version": 1,
  "enabled": false,
  "quotesEnabled": false
}
```

状态启动时读取。不要在运行期间直接改文件；应通过界面开关或下述接口修改。多个独立 Harness 进程共享同一目录时不会实时互相广播，建议分别配置状态目录。

## 朗读

朗读可使用系统语音、Qwen 实时朗读或自行配置的 GPT-SoVITS。公开版保留无音轨开屏动画和背景图。参考录音、语音模型、生成的音频、密钥和音色 ID 由用户留在本机。

Qwen 配置使用 [占位示例](./voice/qwen-config.example.json)。把配置保存到 `$DSH_HOME/fairy-qwen.json`（缺省为 `~/.dsh/fairy-qwen.json`），填入自己的 Token Plan Key 和实时音色 ID，再重启 Harness。也可使用 `FAIRY_QWEN_CONFIG` 指定配置路径。多音色、离线检查和本地试听见 [Qwen 语音说明](./docs/QWEN_VOICE_TEST.md)。开启云端朗读后，朗读文本会发送给 Qwen。

### 本地 GPT-SoVITS（可选）

在 `$FAIRYKIT_HOME/voice`（缺省为 `~/FairyKit/voice`）准备自己的 GPT-SoVITS v2 权重 `Fairy-e10.ckpt` 和 `Fairy_e10_s870.pth`，以及匹配音色的 `fairy_ref.wav`，再运行 `scripts/setup-voice.ps1` 安装运行时并生成配置。设置 `FAIRY_TTS_PROMPT` 为参考录音的准确文本。若录音在其他目录，可用 `FAIRY_TTS_REFERENCE` 指向它。修改环境变量后重启 Harness。

## 开发检查

```powershell
npm ci
npm run smoke
npm run test:hdd
npm run test:voice
```

接口与兼容性见 [HANDOFF.md](./HANDOFF.md)。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-fairy-mode
```

完全退出后重启。卸载不会自动删除保存的语气设置；重新安装时会恢复上次状态。要恢复首次安装的默认值，在 Harness 完全退出后将 `fairy-persona.json` 中的 `enabled` 改为 `false`。

## 来源

上游署名、代码许可及素材说明见 [NOTICE.md](./NOTICE.md) 和 [LICENSE](./LICENSE)。
