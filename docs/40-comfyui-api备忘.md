# 40 — ComfyUI API 备忘(已核实)

> 基于本地源码 checkout `other-projects/comfyui`(symlink → `/root/ai/comfyui/ComfyUI`,2026-10 版本)逐条核实,标注 `文件:行`。行号会随版本漂移,以语义为准。

## 1. 端点一览

| 端点                                             | 方法            | 用途                                               | 源码                      |
| ------------------------------------------------ | --------------- | -------------------------------------------------- | ------------------------- |
| `/ws?clientId=`                                  | WS              | 事件流(本集成的主跟踪通道)                         | server.py:272             |
| `/prompt`                                        | POST            | 提交 API 格式 graph                                | server.py:1080            |
| `/history/{prompt_id}`                           | GET             | 查询单任务结果(收割来源)                           | server.py:1067            |
| `/history`                                       | GET(+POST 清空) | 历史(支持 max_items/offset)                        | server.py:1053 / 1211     |
| `/view?filename=&subfolder=&type=`               | GET             | 下载产物文件                                       | server.py:519             |
| `/view_metadata/{folder_name}`                   | GET             | 读元数据                                           | server.py:671             |
| `/queue`                                         | GET / POST      | 队列查询 / 清空、删项                              | server.py:1072 / 1154     |
| `/interrupt`                                     | POST            | 中断(可定向 prompt_id)                             | server.py:1168            |
| `/free`                                          | POST            | 卸载模型/释放显存(**扩展不使用**,gpu-manager 负责) | server.py:1200            |
| `/system_stats`                                  | GET             | 系统/设备/VRAM                                     | server.py:694             |
| `/features`                                      | GET             | 服务端特性                                         | server.py:747             |
| `/object_info[/{node_class}]`                    | GET             | 节点 schema(调试与校验)                            | server.py:808/821         |
| `/upload/image`、`/upload/mask`                  | POST(multipart) | 上传(**第一期不使用**,D8 用路径节点)               | server.py:467/473         |
| `/api/jobs…`(list/get/cancel)                    | GET/POST        | 新版任务 API(未采用,见 00 §6)                      | server.py:829/927/979/997 |
| `/models/{folder}`、`/embeddings`、`/extensions` | GET             | 资源枚举(生成器可假设模型在,不必列举)              | server.py:340-359         |

`POST /prompt` 请求体:

```jsonc
{ "prompt": { "<id>": { "class_type": "...", "inputs": {...} } },
  "client_id": "<ws 连接时用的 id>",
  // "prompt_id": "可省略,服务端铸造 UUID(server.py:1098);省略即用服务端铸造",
  // "extra_data": { … }  会附加到 history 记录;本项目放 pi_generator 标记
}
```

- 成功(200):`{ "prompt_id", "number", "node_errors": {...} }` —— `node_errors` 可为**非空警告**,执行照常。
- 失败(400):`{ "error": {type, message, details, extra_info}, "node_errors": {...} }`。典型 `type`:`invalid_prompt`(图校验失败)、`no_prompt`、`invalid_prompt_id`。
- 校验发生在队列之前(`execution.validate_prompt`,server.py:1109):**图/节点/参数错误立即 400,不消耗 GPU**。

## 2. WS 协议

### 2.1 连接

- 连接 `/ws?clientId=<id>`;`clientId` 复用已知会踢掉旧 socket(server.py:283)。断线重连用同一 id 即接管。
- 服务器先推 `status`(含 `sid`);若该 id 正在执行还会补推 `executing`(server.py:289-294)。
- 客户端应**首条消息**发送 `{"type":"feature_flags","data":{…}}`;服务端回 `feature_frames` 并据此调整行为(server.py:301-324)。本项目发送:

```json
{ "type": "feature_flags", "data": { "supports_preview_metadata": true } }
```

不发送则走"旧客户端"路径(文本 progress 里可能携带未编码 preview 张量;二进制仍可用,但缺元数据版)。**本项目必须发送**(用带元数据预览帧)。

### 2.2 文本事件(JSON 帧 `{"type": <见下>, "data": …}`,多数定向 `server.client_id`)

| type                    | data                                                                                           | 说明                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `status`                | `{status:{exec_info:{queue_remaining}}, sid?}`                                                 | 连接时与队列变化时(全局)                                           |
| `execution_start`       | `{prompt_id}`                                                                                  | 开始执行(execution.py:742;**定向**)                                |
| `executing`             | `{node, display_node?, prompt_id}`;`node:null`                                                 | 切换节点;`null` = 该 prompt 所有节点跑完(execution.py:496)         |
| `execution_cached`      | `{nodes:[…], prompt_id}`                                                                       | 命中缓存未重跑的节点(execution.py:770)                             |
| `progress`              | `{value, max, prompt_id, node}`                                                                | 采样步进(main.py 末尾发送;**定向**;本帧不携带预览图——预览走二进制) |
| `progress_state`        | `{prompt_id, nodes:{<id>:{state, node_id, display_node_id, parent_node_id, real_node_id, …}}}` | 组合节点状态(comfy_execution/progress.py:184)                      |
| `executed`              | `{node, display_node?, output, prompt_id}`                                                     | 输出节点完成,`output` 即 ui 数据(execution.py:577)                 |
| `execution_error`       | `{node_id, node_type, exception_message, traceback, prompt_id, …}`                             | 失败(execution.py:538)                                             |
| `execution_interrupted` | `{prompt_id, node_id?}`                                                                        | 被中断(execution.py:699)                                           |
| `feature_flags`         | 服务端特性集                                                                                   | 响应首轮握手                                                       |

> 定向说明:`execution_start/progress/executed/execution_error` 等发给 `server.client_id`(即提交时的 `client_id`);`status` 是广播。**因此必须先连 WS(clientId=X)再 POST /prompt(client_id=X)**,否则收不到全部定向事件。

### 2.3 二进制帧(b_preview)

帧格式(`send_bytes = struct.pack(">I", event) + data`,server.py:1306;protocol.py:1-4):

| event                           | payload 布局                              | 说明                                                                       |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| `1 PREVIEW_IMAGE`               | `[4B 大端 type_num][图像字节]`            | `type_num`:1=JPEG,2=PNG;quality 95 / compress_level 1(server.py:1309-1335) |
| `4 PREVIEW_IMAGE_WITH_METADATA` | `[4B 大端 meta_len][meta JSON][图像字节]` | `meta["image_type"] = "image/jpeg"\|"image/png"`(server.py:1341-1390)      |
| `2 UNENCODED_PREVIEW_IMAGE`     | 内部事件,发出前转成 `1`                   | 见 server.py:1299                                                          |
| `3 TEXT`                        | 文本字节                                  | 供自定义节点传文本,本项目忽略                                              |

预览的产生:`--preview-method auto` 等启动参数(`--preview-method <none|auto|latent2rgb|taesd>`);采样侧每步生成,自动按 feature_flags 决定 1 或 4 变体。**生成图节点不需要预览节点**;若部署未启用该参数,执行正常但无预览帧(扩展与面板对"无预览"是静默降级)。

## 3. graph(API 格式)与校验

- 形状:`{"<节点id>": {"class_type": "<节点类名>", "inputs": {…}}}`;跨节点引用:`["<id>", <输出序号>]`。
- 硬性要求:至少一个 OUTPUT_NODE=True 的节点(SaveImage / SaveVideo / SaveAudio\* / PreviewImage…),否则没有可收割产物。
- 节点 schema 查询:`GET /object_info`(全部)或 `/object_info/<class_type>`。
- 常见校验失败(都会在 POST /prompt 400 的 `node_errors` 里):class 不存在/inputs 缺失/类型不匹配/输入文件不存在(VAILDATE_INPUTS 字符串返回)。

## 4. `/history` 与产物收割

`GET /history/{prompt_id}` →

```jsonc
{ "<prompt_id>": {
    "prompt":  [number, prompt_id, promptGraph, extra_data, outputs_to_execute],
    "outputs": { "<node_id>": { "images": [ {"filename","subfolder","type"}, … ],
                               // 其他键:audio/videos/gifs/latents/3d/text/dims… 因节点而异
                } },
    "status":  { "status_str": "success"|"error", "completed": true|false,
                 "messages": [ ["<事件type>", <data>], … ] }
} }
```

**通用收割规则(10 §5 采用,D2/D6)**:遍历 `outputs` 的所有键,值若为"对象数组且元素含 `filename`+`type` 字符串"视为文件引用;其余键(dims/text/…)忽略。这样无需维护输出键枚举,兼容任意 Save 节点。已核实参考(本 checkout):

| 节点                                                                                                      | ui 键                                                 | 文件类型                 |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------ |
| `SaveImage`(nodes.py:1668)                                                                                | `images`                                              | output: .png             |
| `SaveImageAdvanced` / `SaveSVGNode`( comfy_extras/nodes_images.py)                                        | `images`                                              | output                   |
| `SaveAnimatedWEBP` / `SaveAnimatedPNG`(nodes_images.py:346/385)                                           | `images`                                              | output                   |
| `SaveWEBM` / `SaveVideo`(comfy_extras/nodes_video.py:13/135)                                              | `videos`/`gifs`(以 history 实际键为准,通用收割已覆盖) | output: .webm/.mp4       |
| `SaveAudio` / `SaveAudioMP3` / `SaveAudioOpus` / `SaveAudioAdvanced`(comfy_extras/nodes_audio.py:159-251) | `audio`                                               | output: .flac/.mp3/.opus |
| `SaveLatent`(nodes.py:509)                                                                                | `latents`                                             | output: .latent          |
| `SaveGLB`(comfy_extras/nodes_save_3d.py)                                                                  | `3d`                                                  | output: .glb             |

`type` 取值:`"output"`(输出目录)、`"temp"`(临时,含自动预览产物)、`"input"`。收割时**只取 `output`**(`temp` 是过程预览,`input` 是用户输入);`filename_prefix` 支持 `%date:` / `%节点名.width%` 等模板(nodes.py:1690 tooltip)。

`/view`:参数 `filename`、`subfolder`、`type`,返回文件字节流(经 gpu-manager 透传)。

## 5. 路径加载节点(输入,D8)

| 节点(包)                                      | 入参                                | 返回        | 源码                                                |
| --------------------------------------------- | ----------------------------------- | ----------- | --------------------------------------------------- |
| `LoadImageFromPath`(ComfyUI_Ib_CustomNodes)   | `image: STRING`(路径)               | IMAGE, MASK | custom_nodes/ComfyUI_Ib_CustomNodes/image.py        |
| `LoadImageFromPathEnhanced`(同上)             | `image`                             | 见定义      | 同上                                                |
| `LoadVideoFromPath`(chlamydomonos-va-loaders) | `video: STRING`                     | VIDEO       | custom_nodes/chlamydomonos-va-loaders/va_loaders.py |
| `LoadAudioFromPath`(同上)                     | `audio: STRING`(可从视频提取首音轨) | AUDIO       | 同上                                                |

路径解析(`_resolve_path`,三个节点一致):`name [input|output|temp]` 注解形式走安全 helper;普通路径**绝对路径原样**、相对路径相对 **ComfyUI input 目录**。故生成器必须传 `ctx.resolvePath()` 的绝对路径(20 §5)。校验失败→"Invalid image path: …"(VAILDATE_INPUTS),会出现在 `node_errors`。

**本机部署注意**:以上包是 `other-projects/comfyui/ComfyUI/custom_nodes/` 下的**本 checkout 已装**扩展;迁移 ComfyUI 环境需要随迁(缺包时 POST /prompt 会报 class 不存在)。

## 6. 与 gpu-manager 的交互(0 改动,已核实)

- 配置:`other-projects/gpu-manager/configs/gpu-manager.yaml` → app `comfyui`:`port 4100`,`upstream http://127.0.0.1:8188`。
- 代理行为:`comfyui` 类型 `participates() = false` → **全部 HTTP 请求旁路直通**;忙闲由 `/queue`(running+pending)轮询判定,不拦截、不加头。
- WS:`/ws` 升级由专门 upgradeHandler 处理(不经 Express 路由),预览二进制帧可透传。
- 显存互斥:LLM(ninfer)申请 lane 时,gpu-manager 会等待 ComfyUI 队列排空并按 `releaseThresholdMiB: 14000` 确认释放(调用 `/free`,带 `releaseWaitSec: 60` 预算)→ **本项目绝不调 `/free`、不抢 lane**,只把流量打到 4100。
- CORS:gpu-manager `corsOrigins: ["*"]`;本集成是服务端到服务端调用,CORS 无关。
- 队列超时:gpu-manager `queueTimeoutSec: 600` 是 **lane 调度**参数(对旁路的 comfyui 无影响);本集成的任务超时用自身 `timeoutMs`(默认 15min)。

## 7. 版本漂移备忘

- 行号基于 2026-10 checkout;端点语义变化以 `server.py` 为准。
- `/api/jobs` 新任务 API(server.py:829+)提供 job 抽象与 `/api/jobs/{id}/cancel`,未来可平滑迁移(00 §6 非目标)。
- 预览帧 feature `supports_preview_metadata` 行为:`main.py` 里按此特性决定推 `4` 帧还是旧 `progress.preview` 张量路径——本项目固定声明该特性。
