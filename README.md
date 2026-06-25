# CCGO Imager MCP

CCGO Imager MCP 可以让 Codex / Claude 在本机通过你的 CCGO 生图 MCP Key 生成或编辑图片。你安装后不需要记工具名，直接描述想要的图片即可。

## 普通用户怎么用

macOS 用户：

```text
1. 解压 CCGO Imager MCP 压缩包
2. 双击 CCGO-Imager-Installer.command
3. 按提示粘贴 CCGO 生图 MCP Key
4. 看到“安装完成”后，重启 Codex / Claude
```

重启后，直接对 Codex / Claude 说你想要什么：

```text
帮我生成一张蓝色对勾图标，透明背景。
```

```text
帮我做一张极简风格的登录页插图。
```

```text
根据这张参考图，帮我生成一张同风格头像。
```

如果你需要固定画幅或清晰度，可以直接用自然语言说：

```text
帮我生成一张 16:9、2K、极简风格的登录页插图。
```

```text
帮我生成一张 9:16、4K、适合手机海报的科技风插图。
```

常用说法对应的尺寸通常是：

| 说法 | 常用尺寸 |
| --- | --- |
| 1:1 1K | `1024x1024` |
| 1:1 2K | `2048x2048` |
| 16:9 2K | `2048x1152` |
| 16:9 4K | `3840x2160` |
| 9:16 2K | `1152x2048` |
| 9:16 4K | `2160x3840` |

生成结果默认保存到：

```text
~/Pictures/ccgo-imager-output
```

如果请求的是 4K 或其他耗时图片，安装器配置的 MCP 会自动等待任务完成并保存结果；你不需要手动查询任务。

## 安装器会做什么

- 在终端里隐藏输入 Key；
- 只显示脱敏后的 Key 给你确认；
- 自动写入 Codex / Claude 的 MCP 配置；
- Key 会明文保存在你本机的 Codex / Claude 配置文件里，用于之后自动调用；
- 写配置前自动备份原文件；
- 收紧配置文件权限；
- 做一次本地工具握手检查；
- 可选做 `/v1/models` 轻量校验，默认失败只警告，不阻断安装。

## 命令行安装

```bash
npm install
npm run install:local
```

非交互安装：

```bash
CCGO_IMAGE_API_KEY="sk-..." npm run install:local -- --yes
```

移除配置：

```bash
npm run install:local -- --reset --yes
```

更换 Key：

```text
重新双击 CCGO-Imager-Installer.command，按提示输入新的 CCGO 生图 MCP Key。
```

如果你怀疑 Key 已经泄露，请先在 CCGO 后台停用旧 Key，再重新安装写入新 Key。

只写 Claude 或只写 Codex：

```bash
npm run install:local -- --no-codex
npm run install:local -- --no-claude
```

## 环境变量

```bash
export CCGO_IMAGE_API_KEY="sk-..."
export CCGO_BASE_URL="https://www.ccgoai.com/v1"
export CCGO_IMAGER_OUTPUT_DIR="$HOME/Pictures/ccgo-imager-output"
```

可选输入根目录限制：

```bash
export CCGO_IMAGER_INPUT_ROOT="$HOME/Pictures"
```

设置后，MCP 只允许读取该目录下用户显式传入的图片路径；不设置时不做输入根目录限制。

建议使用 `CCGO_IMAGE_API_KEY` 作为生图 MCP Key。也兼容 `CCGO_API_KEY`。API Key 只从环境变量读取，不支持通过工具参数传入。

## 手动配置示例

不推荐普通用户手动编辑配置。需要排障时，可以参考：

```json
{
  "mcpServers": {
    "ccgo-imager": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/ccgo-imager-mcp/src/index.js"],
      "env": {
        "CCGO_IMAGE_API_KEY": "sk-...",
        "CCGO_BASE_URL": "https://www.ccgoai.com/v1",
        "CCGO_IMAGER_OUTPUT_DIR": "/absolute/path/to/ccgo-imager-output"
      }
    }
  }
}
```

不要把真实 Key 发到聊天窗口、公开仓库或截图里。

## 给 Codex / Skill 的技术说明

这个 MCP 提供以下工具，通常由 Codex 或 Skill 自动选择，普通用户不需要记这些名字：

- `server_info`: 查看 MCP 配置、限制和工具列表，不会泄露 API Key。
- `ccgo_image_generate`: 生成图片资产，默认 `model=gpt-image-2`。
- `ccgo_image_edit`: 基于一张或多张本地参考图编辑图片。
- `ccgo_image_batch_edit`: 对多张本地图片逐张执行同一个编辑任务，默认并发 4，最大 6。
- `ccgo_image_multi_reference`: 使用 2-10 张参考图生成或编辑一张最终图片。

当 CCGO Imager MCP 可用，且用户希望使用 CCGO 生图 Key 生成图标、复杂视觉、透明 PNG、PPT 视觉资产时，应优先调用 MCP 工具。

如果用户明确要求 16:9、9:16、1:1、2K、4K 等画幅或清晰度，应选择匹配的 `size` 参数。生成完成后，建议检查返回图片的实际尺寸和保存路径，并用简短自然语言告诉用户，例如“已生成，实际尺寸为 3840x2160，文件保存在 ...”。

## 安全边界

- `n` 限制为 1-6。
- 批量编辑默认并发 4，最大并发 6。
- 大图异步任务默认最多等待 15 分钟。
- 单张输入图默认限制 30MB。
- 输入图片会校验 PNG/JPEG/WebP/GIF 文件头，不只看扩展名。
- 输出路径只能写入 `CCGO_IMAGER_OUTPUT_DIR` 内部，避免路径穿越。
- URL 图片下载只用于保存 CCGO 返回的图片结果 URL；只允许 `http/https` 公网地址，拒绝 localhost、内网、链路本地、保留地址等 SSRF 风险目标，并会对重定向目标重新校验。
- MCP 只负责客户端工具层；计费、风控和请求调度仍由 CCGO 服务端处理。

## 版权

Copyright (c) 2026 CCGO. All rights reserved.
