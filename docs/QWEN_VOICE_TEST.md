# Qwen 实时音色试听

`scripts/qwen-voice-test.py` 提供独立的音色创建与云端试听。插件 通过 `qwen-voice.js` 将已创建的音色接入 Harness 朗读开关，两者都不读取麦克风。

## Harness 朗读接入

安装依赖 `npm install`。复制 `voice/qwen-config.example.json` 到 `$DSH_HOME/fairy-qwen.json`（缺省为用户目录 `.dsh/fairy-qwen.json`），仅在本地填入 Token Plan Key 和已创建的实时音色 ID；完全退出并重启 Harness。也可用环境变量 `FAIRY_QWEN_CONFIG` 指定配置路径。

现有朗读开关控制云端请求的允许与取消；「就绪」表示本地配置已通过校验，实际网络和权限在发声时验证。无云端配置文件时沿用本地语音后端；配置文件无效时提示未配置，不会静默切换或创建新音色。已有系统语音降级逻辑保留。

服务器接收 DeepSeek 回复文本，通过 Qwen 实时 API 获取音频，以 WAV 返回给原播放器。首次 `session.update` 设置音色，后续通过文本消息请求逐字朗读。服务端检查完成状态、非静音音频及转录与原文一致性；不会将实时模型当成另一个会话助手。

离线检查：`npm run test:voice`。显式付费集成试听：`npm run test:voice:live`，它加载真实 `index.js`、注册 HTTP 路由并在内存中验证音频，默认不写音频文件。确需人工试听时才运行 `npm run test:voice:live -- --save-audio`，导出到忽略目录。集成试听不操作运行中的 Harness。

两套配置各司其职：普通百炼 Key 和业务空间创建音色；Token Plan Key 调用 `qwen-audio-3.0-realtime-plus`。创建时 `target_model` 必须与实时模型完全一致。实时会话在第一次 `session.update` 中传入创建得到的 `voice_id`。

## 本地准备

在项目根目录的 `api_qwen.txt` 中保留一个 Token Plan Key（`sk-sp-` 开头）、一个普通 Key，以及普通配置的北京业务空间 URL（`https://ws-<业务空间>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）。脚本读取实际域名，分别使用音色管理和实时 WebSocket 路径，不将 Key 写入脚本或报告。

安装 Python 的 `requests`、`websocket-client`，或将它们放到 `local-artifacts/python-libs`。准备两份已经确认的 WAV：

- `local-artifacts/fairy-voice/fairy-reference-A.wav`
- `local-artifacts/fairy-voice/fairy-reference-B.wav`

## 运行

```powershell
python scripts/qwen-voice-test.py probe
python scripts/qwen-voice-test.py baseline
python scripts/qwen-voice-test.py compare
```

`probe` 只检查普通配置的音色列表接口。`baseline` 用 Token Plan 和系统音色测试实时输出。`compare` 分别创建 A、B 音色，用 Token Plan 生成相同的中文句子，检查音频并记录服务端文本、首包耗时及完成状态。默认不保留生成音频；添加 `--save-audio` 才导出 24 kHz、16 位单声道 WAV，例如 `python scripts/qwen-voice-test.py compare --save-audio`。

音色 ID 与素材摘要立即保存在本地，重跑会复用已有 ID；更换模型、素材或业务空间时会停止，避免意外重复创建。如果 Token Plan 调用失败，会再通过普通配置进行一次短试听，帮助区分音色问题和跨配置可用性问题。该备用调用属于普通配置，可能单独计费。

音色状态、结果及显式导出的音频位于忽略目录 `local-artifacts/fairy-voice`；凭据文件也已加入 `.gitignore`。不要将这些文件加入 Git。正常运行中的朗读不落盘，客户端在播放结束或停止后释放音频资源。


接口依据：[声音复刻 HTTP API](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)、[实时模型客户端事件](https://help.aliyun.com/en/model-studio/fun-audiochat-client-events)。

## 桌面切换音色

桌面输入框的朗读按钮旁有音色下拉框。选择记录保存在云端朗读配置旁的 `.selection` 文件中。切换会停止当前朗读，下次朗读使用选中的音色。配置只有一档音色时显示原朗读按钮。

配置文件可选 `voices` 数组，每项填写 `id`、`label` 和 `voice`，例如 `{"id":"alt","label":"备用音色","voice":"YOUR_VOICE_ID"}`。已有音色 ID 可直接填入本地配置。

下面的命令可处理脚本内置名称对应的本地语音包（目录内自备同名 M4A），并将通过试听的音色写入桌面配置。裁剪脚本需要 `imageio-ffmpeg`。每个音色目录内有 24 kHz、16 位单声道参考 WAV、摘录位置和时长。注册后的试听文件与结果保存在同一个目录。第二条命令会调用百炼和 Token Plan，并保存通过试听的音色。

```powershell
$packsDir = Join-Path (Get-Location) 'local-artifacts/voice-packs'
python -X utf8 scripts/prepare-voice-packs.py $packsDir
python -X utf8 scripts/qwen-voice-test.py register-packs --packs-dir $packsDir
```

首次更新插件或添加音色后，从应用菜单退出并重新打开 Harness。之后可直接在桌面切换。参考录音、试听和音色注册记录保存在本机目录。
