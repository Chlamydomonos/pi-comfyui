---
name: comfyui-generator-authoring
description: '编写、修改与调试 ComfyUI 工作流生成器(pi-comfyui 扩展加载的 <workspace>/.pi/comfyui/generators/*.js)。USE FOR: 新建 txt2img/img2img/转写类生成器文件;comfyui_list_generators 报"无效文件"的修复;params 参数 schema 设计;ComfyUI API 格式 graph 接线与输出节点;node_errors / Invalid image path / class_type 不存在等调试。触发词:生成器、generator、comfyui_generate、comfyui_list_generators、txt2img、img2img、工作流、SaveImage、filename_prefix、node_errors、lora、LoraLoader。'
---

# ComfyUI 工作流生成器编写

## 产出

一个**自包含**的 ESM 文件(`<name>.js`),default 导出 `{name?, title, description, params, build(params, ctx)}`,返回 ComfyUI API 格式 graph。生成器是 Agent 与 ComfyUI 之间的唯一工作流层:Agent 只见 `title + description + 每个参数的 description`。

## 实测事实(与文档冲突时,以下表为准)

| 事实            | 内容                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件位置        | `<workspace>/.pi/comfyui/generators/`,扁平一层,仅 `*.js`;文件名(去 .js)即默认 name                                                                                                                                    |
| 生效方式        | 保存即生效,无需重载会话(每次工具调用重扫目录,mtime 缓存)                                                                                                                                                              |
| build 签名      | **`build(params, ctx)` 两参**;`ctx = {workspace, resolvePath, token(6位), now}`                                                                                                                                       |
| 禁止            | 源码含 `import`/`require`(语句级扫描,注释里提及不误伤)→ list 会报"无效:含 import"                                                                                                                                     |
| name 约束       | `[a-z][a-z0-9-]{0,63}`                                                                                                                                                                                                |
| checkpoint 口序 | CheckpointLoaderSimple 输出:**0=MODEL, 1=CLIP, 2=VAE**;CLIPTextEncode 的 clip 必须接 `['<ckpt id>', 1]`                                                                                                               |
| 本机 checkpoint | 无 `sd_xl_base`;可用的有 `waiIllustriousSDXL_v160.safetensors`、`miaomiaoRealskin_epsV13.safetensors`、`sam3.1_multiplex_fp16.safetensors`(查最新:`curl -s http://127.0.0.1:4100/object_info/CheckpointLoaderSimple`) |
| 预览            | 生成器**不写预览节点**;部署 `--preview-method auto` 自动推预览帧,没开时面板无预览区(非错误)                                                                                                                           |
| 输入文件        | 路径节点(LoadImageFromPath 等)**必须经 `ctx.resolvePath()`** 转绝对路径;相对路径会被解析到 ComfyUI 的 input 目录                                                                                                      |
| 节点 id         | **任意可读字符串**(如 `ckpt`/`ksampler`),引用 `['ckpt', 0]`;唯一即可——比数字耐增删改(真机验证)                                                                                                                        |
| LoraLoader      | 输出 **0=MODEL, 1=CLIP**;`model`/`clip` 必填 → 必须**成链**:每级接上一级,下游 pos/neg/sampler 取链尾;strength 限 ±100(建议 -1~1.5);LoRA 清单(名含子目录):`curl -s http://127.0.0.1:4100/object_info/LoraLoader`       |
| params 校验     | JSON Schema 子集:object 嵌套仅支持一级;**array 仅验"是数组"——item 不校验、item 级 default 不合并**,build 里逐项清洗兜底(见模板 loras)                                                                                 |

## 流程

### 1. 明确需求 → 选模板起步

按"文生图 / 图生图(或带输入文件) / 其他"从 [assets](./assets/) 拷贝最近模板到目标工作区再改:

```sh
mkdir -p <workspace>/.pi/comfyui/generators
cp <本技能路径>/assets/txt2img-sdxl.js <workspace>/.pi/comfyui/generators/<新名>.js
```

- [assets/txt2img-sdxl.js](./assets/txt2img-sdxl.js) —— 文生图基线:checkpoint →(可选 LoRA 链)→ 双 CLIP 编码 → EmptyLatentImage → KSampler → VAEDecode → SaveImage
- [assets/img2img-sdxl.js](./assets/img2img-sdxl.js) —— 带输入文件(`ctx.resolvePath`)+ 用户可控 `strength`/可选 LoRA 链的完整示例

### 2. 改 params(决定 Agent 调用质量)

- Agent 看到的 = title + description + **每个属性的 description**;说明要像 API 文档一句一行(格式、单位、示例路径)。
- 有默认值必写 `default`(装载器深合并,Agent 可省略);必填进 `required` 并在 description 写清取值来源。
- 枚举用 `enum`;数字范围写 `minimum/maximum`——非法参数在提交前被 schema 校验拦下,不消耗 GPU。
- 参数 ≤ 8 个;"风格预设"做成 enum,别让 Agent 编 graph。
- 列表参数(LoRA/多文件)用 `type:'array'`+`items`;items 只是给 Agent 看的文档——**校验器不验 item、item 级 default 不合并**,build 里逐项兜底(参考模板 loras)。

### 3. 改 build(graph 硬性检查)

1. 返回 `{ prompt: { "<节点id>": { class_type, inputs } } }`;节点引用写 `["<上游id>", <输出序号>]`。节点 id 用可读字符串(`ckpt`/`ksampler`…),增删节点时引用链不动。
2. **至少一个输出节点**(SaveImage / SaveVideo / SaveAudio\* 等 OUTPUT_NODE 类),否则执行完无产物可收割。
3. `filename_prefix` 固定 `` `pi/${ctx.token}` `` —— 输出目录唯一、命名收割规则可控。
4. 输入文件一律 `ctx.resolvePath(params.xxx)`;不要手拼绝对路径。
5. 逐条核对引用口序(checkpoint/LoRA 口序见事实表;KSampler 输出 0=latent;VAEEncode/VAEDecode 输出 0)。
6. 未知节点的真实入参:`curl -s http://127.0.0.1:4100/object_info/<ClassType>`。

### 4. 装载验证

在 pi 会话(pi-web 或 pi CLI)里:

```
comfyui_list_generators()
```

- 目标生成器显示且无 invalid 项 → 通过。
- "无效"文件会**列文件名 + 原因**(含 import / name 非法 / 缺 build / params 非 object schema 等),按原因改,保存后重跑即可。

### 5. 冒烟生成

```
comfyui_generate({ generator:"<name>", params:{ ...最小参数 }, output:{ name:"<smoke-名>" } })
```

用小步数(如 steps:4)省 GPU。成功判据:content 出现 `comfyui-output/<name>.png`、终态帧 `completed`。带输入文件的生成器先放一张真实图到工作区再调。

### 6. 失败时按症状定位

| 症状(content / 帧里出现)                  | 根因                              | 动作                                                                                       |
| ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `return_type_mismatch … input_type(CLIP)` | 引用口序错(如 clip 接了 MODEL 口) | 按口序表重接                                                                               |
| `Invalid image path: …`                   | 输入文件不存在 / 跨机             | 核对 `ctx.resolvePath` 结果与文件真实位置                                                  |
| `class_type 不存在`                       | 目标部署缺该节点包                | 换内置节点或先装包                                                                         |
| `无输出文件`(completed 无产物)            | 缺输出节点                        | 补 SaveImage 类节点 + filename_prefix                                                      |
| 装载报"无效:含 import"                    | 生成器里写了 import/require       | 内联或改用参数传入                                                                         |
| 装载报 name 非法                          | 不符 `[a-z][a-z0-9-]{0,63}`       | 改 name 或文件名                                                                           |
| `value not in list`(lora_name/ckpt_name)  | 资源名不存在或漏了子目录          | 名含子目录;`curl -s http://127.0.0.1:4100/object_info/LoraLoader` 查准确全名               |
| build 抛错 → 工具 failed                  | 运行时异常                        | 错误消息原样含 message;临时 `throw new Error(JSON.stringify(prompt))` 查提交内容(调试完删) |

## 深入阅读

- 完整规范与长示例:`../../../docs/20-生成器编写指南.md`(模块契约 §2、输入节点 §5、输出收割 §6、调试 §8)
- ComfyUI API / WS / history 细节:`../../../docs/40-comfyui-api备忘.md`
