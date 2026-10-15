# @chlamydomonos/pi-comfyui

Pi Coding Agent 扩展 + pi-web 插件:让 Agent 通过可配置的 ComfyUI 工具生成图片/视频/音频,并在 pi-web 界面实时展示进度、预览与产物。

## 功能

### Agent 工具

- `comfyui_generate` — 按名称调用生成器,阻塞至任务终结,过程进度经 `onUpdate` 流式回报(不占上下文);
- `comfyui_list_generators` — 列出当前工作区可用生成器;
- 可选工具(配置 `tools` 开启):`comfyui_status`、`comfyui_cancel`。

工作流的构建与提交细节对 Agent 完全不可见(Agent 只看到工具描述 + 参数 schema),以节省 token。

### 生成器(用户编写)

在 `<工作区>/.pi/comfyui/generators/*.js` 放置生成器文件(扁平一层,默认导出一个对象:参数 schema + `build(params, ctx)` 返回 ComfyUI API 格式 graph)。示例见 [`examples/generators/`](./examples/generators/)。

### pi-web 面板

workspacePanel「ComfyUI」:运行卡片(阶段 + 进度条 + 实时预览 + 取消)、产物画廊、本工作区任务历史。协议频道名 `pi-comfyui`(浏览器 ⇄ 服务端插件 ⇄ 扩展)。

### 提交链路

生成请求经 **gpu-manager** 反向代理提交到 ComfyUI(`baseUrl` 指向 gpu-manager,不要直连 ComfyUI 的 8188),保证 ComfyUI 与本地 LLM 互斥使用显存。产物自动收割落盘到工作区(`outputDir`,默认 `comfyui-output/`)。

## 配置

两级 JSON,工作区覆盖全局,缺失即用默认值:

| 层级   | 路径                        |
| ------ | --------------------------- |
| 全局   | `~/.pi/agent/comfyui.json`  |
| 工作区 | `<工作区>/.pi/comfyui.json` |

```jsonc
{
    "baseUrl": "http://127.0.0.1:4100", // gpu-manager 入口
    "timeoutMs": 900000, // 单任务硬上限
    "outputDir": "comfyui-output", // 产物相对目录
    "previewMaxSize": 512, // 预览帧最长边(px)
    "previewIntervalMs": 800, // 预览帧最小间隔
    "previewBytes": 196608, // 单帧 base64 上限
    "tools": ["generate", "list"], // 可加 "status"、"cancel"
    "maxQueue": 2, // 每会话排队上限
}
```

## 安装

本包同时声明 `pi.extensions`(扩展)与 `piWeb.plugins`(pi-web 插件),两边都要生效才能完整:

```sh
# pi settings.json 的 packages 里加本包路径,或:
pi install <本包路径或 npm 包名>
```

浏览器侧更新:重建本包(`npm run build`)→ 刷新页面;服务器侧更新:重建 → 重启 pi-web sessiond → 刷新浏览器。

## 开发

```sh
npm install
npm run typecheck  # tsc --noEmit
npm run build      # esbuild 打包 piWeb 插件到 dist/
npm run smoke      # 离线冒烟
```

目录:

- `src/extension/` — pi 扩展(工具注册、生成器装载、ComfyUI 客户端、产物落盘);
- `src/plugin/server/` — pi-web 服务端插件(帧扇出、任务历史);
- `src/plugin/browser/` — pi-web 浏览器面板(Lit,构建为 `dist/plugin/browser`);
- `src/shared/protocol.ts` — 三方共享的 wire 协议常量。
