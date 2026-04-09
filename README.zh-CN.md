# codexRemote

[English](./README.md)

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![WebSocket](https://img.shields.io/badge/WebSocket-JSON--RPC-4A154B)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![Remote Access](https://img.shields.io/badge/Remote-Any%20Device-0F172A)](#)

codexRemote 让你可以通过 Web 从任何设备访问你的本地 Codex 环境。它不会把原始 Codex app-server 直接暴露出去，而是在本机放一层 Next.js + Node bridge，再通过 Cloudflare Tunnel 只公开 Web 入口。

这个项目的重点是：

- 让你从手机、平板、另一台电脑远程访问本地 Codex 环境
- 让远程体验尽量接近 Codex desktop app
- 让 session 和 thread 与桌面端保持同步

## 什么叫“本地环境”

codexRemote 不是一个托管版 Codex 克隆。它访问的是你桌面 Codex 当前就在使用的那套真实本地环境：

- 本地工作区
- 本地文件
- 本地 Codex session 历史
- 本地 thread 状态
- 通过 bridge 暴露出来的本地运行时访问能力

## 架构

```text
任意设备浏览器
        |
        v
Cloudflare Tunnel 公网 HTTPS 地址
        |
        v
Next.js 前端 127.0.0.1:8080
        |
        v
本地 bridge 服务 127.0.0.1:8081
        |
        v
本地 Codex app-server websocket 127.0.0.1:7677
```

对外公开的应该只有前端这一层 origin。bridge 端口和原始 Codex websocket 继续只留在本地。

## 安装

```bash
npm install
```

依赖要求：

- Node.js 18+
- 本机可用的 Codex Desktop / Codex app-server 环境
- 如果要公网访问，需要安装 `cloudflared`

## 本地启动

启动前端：

```bash
npm run dev
```

另一个终端启动 bridge：

```bash
BRIDGE_TOKEN=replace-me npm run dev:bridge
```

也可以一键启动前端 + bridge + tunnel：

```bash
BRIDGE_TOKEN=replace-me npm run dev:remote
```

生产风格启动：

```bash
npm run build
BRIDGE_TOKEN=replace-me npm run start:remote
```

全局辅助命令：

```bash
codexremote start
codexremote status
codexremote stop
```

## 配置

必填：

```bash
BRIDGE_TOKEN=replace-me
```

常用可选环境变量：

```bash
FRONTEND_PORT=8080
BRIDGE_PORT=8081
NEXT_PUBLIC_BRIDGE_URL=http://127.0.0.1:8081
NEXT_PUBLIC_TUNNEL_URL=http://127.0.0.1:8080
CF_TUNNEL_MODE=named
CF_TUNNEL_NAME=codexremote
CF_TUNNEL_DOMAIN=codex.example.com
ALLOWED_DEV_ORIGINS=codex.example.com
CF_TUNNEL_CONFIG_PATH=~/.cloudflared/config-codexremote.yml
```

机器本地的私密配置建议写在 `.env.local` 或 `.env.remote.local`。

## 本地怎么把接口代理到 8080

浏览器实际访问的是 Next.js 前端，也就是 `:8080`。

Next.js 在 `app/` 下暴露了一组服务端路由，例如：

- `/health`
- `/ready`
- `/capabilities`
- `/codex-events`
- `/codex-rpc`
- `/device-*`
- `/thread-bind`
- `/thread-resolve`
- `/thread-history`
- `/thread-send`

这些路由会通过 `lib/server/bridge-proxy.js` 转发到本地 bridge `:8081`，所以浏览器不需要直接访问 bridge 端口。

## 怎么暴露到外部

推荐方案就是 Cloudflare Tunnel。

临时 tunnel：

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

命名 tunnel 初始化：

```bash
CF_TUNNEL_DOMAIN=codex.example.com npm run tunnel:setup:domain
```

手动命名 tunnel 流程：

```bash
cloudflared tunnel create codexremote
cloudflared tunnel route dns codexremote codex.example.com
cloudflared tunnel --config ~/.cloudflared/config.yml run codexremote
```

公网访问流程：

1. 本地启动前端和 bridge
2. 启动指向 `:8080` 的 Cloudflare Tunnel
3. 在远程设备上打开带 `?token=...` 的公网 URL 完成首次配对
4. 配对后继续使用同一个公网 URL 正常访问

## 设备授权模型

- 首次配对可以通过 URL token 完成
- 配对后通过 device cookie 识别设备
- 只有已配对设备才能访问事件流、RPC 和线程管理接口
- 设备注册信息保存在 `~/.codex/codexremote-devices.json`

## 技术接口说明

### 本地 bridge HTTP 接口

核心 HTTP 接口包括：

- `GET /health`
- `GET /ready`
- `GET /capabilities`
- `GET /codex-events`
- `POST /codex-rpc`
- `GET /device-status`
- `POST /device-pair`
- `POST /device-revoke`
- `POST /device-forget`
- `POST /thread-bind`
- `GET /thread-resolve`
- `GET /thread-history`
- `POST /thread-send`
- `POST /thread-delete`

### 上游 Codex JSON-RPC 方法

Web UI 和 bridge 目前用到的上游 Codex RPC 方法主要有：

- `initialize`
- `initialized` 通知
- `model/list`
- `fs/readDirectory`
- `thread/list`
- `thread/read`
- `thread/start`
- `turn/start`

UI 还会监听这些事件通知：

- `thread/started`
- `thread/status/changed`
- `thread/name/updated`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- 各类 approval request 事件

## codex desktop 和远端怎么同步

同步策略是刻意收窄的：

- Codex Desktop 是唯一事实源
- 远端读取的是同一份本地 thread 状态
- 远端发送的新消息会追加到同一个 thread
- thread 状态原样同步
- 不导入也不改写旧历史

对于外部系统，codexRemote 可以保存一层映射：

```text
externalThreadId -> codexThreadId
```

这样外部系统可以继续使用自己的会话 ID，同时把消息写到本地同一个 Codex thread 里。

映射默认保存在：

```bash
~/.codex/codexremote-thread-bindings.json
```

## 外部同步接口

### `POST /thread-bind`

把外部会话 ID 绑定到一个已存在的 Codex thread。

```json
{
  "externalThreadId": "ext-123",
  "threadId": "codex-thread-id",
  "cwd": "/optional/workspace",
  "source": "my-site"
}
```

### `GET /thread-resolve?externalThreadId=ext-123`

返回已保存的绑定关系和轻量线程摘要。

### `GET /thread-history?externalThreadId=ext-123`

返回当前 Codex thread，包括 turns 和状态。

### `POST /thread-send`

向同一个 Codex thread 追加一条新的 turn。

```json
{
  "externalThreadId": "ext-123",
  "text": "Continue this thread",
  "waitForCompletion": true
}
```

如果你已经有 `threadId`，也可以直接传 `threadId`。

## 备注

- 空线程或还没 materialize 的线程不一定要在远端展示
- 同步是增量同步：同一个 thread，只追加后续 turn
- 如果桌面侧 thread 是 error，远端应该展示同样的 error 状态
- 组合启动脚本会在启动前清理 `._*` AppleDouble 文件
