# codexRemote

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![WebSocket](https://img.shields.io/badge/WebSocket-RPC-4A154B)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![Local First](https://img.shields.io/badge/Local-First-0F172A)](#)

codexRemote lets you access your local Codex environment from any device through the web. It uses a small Node bridge, a Next.js frontend, and Cloudflare Tunnel to expose a single public HTTPS entrypoint, so you can reach the same local workspace, files, and Codex sessions remotely while keeping sessions and threads fully synchronized with the desktop side.

codexRemote 让你可以通过 Web 从任何设备访问你的本地 Codex 环境。它通过轻量 Node bridge、Next.js 前端和 Cloudflare Tunnel 暴露一个统一的公网 HTTPS 入口，让你在远端访问同一套本地工作区、文件和 Codex 会话，同时保证 session 和 thread 与桌面端完全同步。

Here, "local environment" means the exact environment your desktop Codex is already using: workspace, files, thread history, session state, and bridge-mediated runtime access.

这里的“本地环境”指的是桌面 Codex 正在使用的那一套真实本地环境：工作区、文件、thread 历史、session 状态，以及通过 bridge 暴露出来的运行时访问能力。

## Overview | 项目概览

This project is mainly about three things:

- Access your local Codex environment remotely from any phone, tablet, or computer through a web UI
- Keep the remote experience close to the Codex desktop app
- Keep sessions and threads fully synchronized, so the same conversation can flow between desktop and web without splitting history

这个项目主要解决三件事：

- 让你从任意手机、平板、电脑通过 Web 远程访问你的本地 Codex 环境
- 让远程使用体验尽量接近 Codex 桌面 app
- 让 session 和 thread 完全同步，让同一段对话可以在桌面和 Web 之间无缝流转，不会分叉历史

## Solution | 方案说明

The main solution is:

1. Run the Next.js frontend on `127.0.0.1:8080`.
2. Run the bridge service on `127.0.0.1:8081`.
3. Keep the Codex app-server websocket local on `127.0.0.1:7677`.
4. Expose only the frontend through Cloudflare Tunnel.
5. Let the frontend proxy requests to the bridge on the same origin.
6. Let remote devices access the same local environment that Codex Desktop is already using.
7. Read and write the same Codex sessions and threads from both desktop and web.
8. Add optional thread-binding APIs for external integrations that want to stay on the same Codex thread.

核心方案是：

1. 在 `127.0.0.1:8080` 运行 Next.js 前端。
2. 在 `127.0.0.1:8081` 运行 bridge 服务。
3. 让 Codex app-server websocket 继续只留在本机 `127.0.0.1:7677`。
4. 只通过 Cloudflare Tunnel 暴露前端这一层。
5. 前端再用同源方式代理到 bridge。
6. 让远端设备访问到与 Codex Desktop 当前使用的同一套本地环境。
7. 让桌面端和 Web 端都读写同一套 Codex session 与 thread。
8. 对需要集成的外部系统，再额外提供 thread binding 接口来复用 Codex 线程。

Important sync constraints:

- Old history is not imported or rewritten.
- Empty, not-yet-materialized threads do not need to be shown remotely.
- Remote sync is incremental: same thread, new turns only.

几个关键约束：

- 不导入也不改写旧历史。
- 空线程或尚未 materialize 的线程，不要求在远端显示。
- 同步是增量同步：同一个线程，只追加后续 turn。
- 线程状态保持一致；如果桌面侧线程是 error，Web 侧也应该显示同样的 error 状态。

## Architecture | 架构

```text
Any Device Browser / External App
        |
        v
Public HTTPS entrypoint via Cloudflare Tunnel
        |
        v
Next.js frontend (default :8080)
        |
        v
Local bridge service (default :8081)
        |
        v
Your local Codex app-server websocket (default :7677)
```

Only the frontend origin should be exposed when you use Cloudflare Tunnel. The bridge and raw Codex websocket stay local.

使用 Cloudflare Tunnel 时，只应该暴露前端这一层 origin；bridge 和原始 Codex websocket 继续只留在本机。

## Features | 功能

- Public HTTPS access to your local Codex environment through Cloudflare Tunnel
- Web UI for local and remote Codex usage on any device
- Remote experience designed to stay close to the Codex desktop app
- Paired-device access with cookie-based auth after first pairing
- Same-origin proxy routes for health, readiness, SSE events, and Codex RPC
- Fully synchronized sessions and threads between desktop and web
- External thread binding and thread-history sync
- Same-thread remote turn submission

- 通过 Cloudflare Tunnel 把你的本地 Codex 环境暴露为公网 HTTPS 入口
- 支持任意设备访问的本地/远端共用 Web UI
- 尽量接近 Codex 桌面 app 的远程体验
- 首次配对后基于 cookie 的设备授权
- 健康检查、就绪检查、SSE 事件流、Codex RPC 的同源代理路由
- 桌面端和 Web 端完全同步的 session / thread
- 外部线程绑定与线程历史同步
- 基于同一线程的远端 turn 追加

## Quick Start | 快速开始

Install dependencies:

```bash
npm install
```

Run the frontend:

```bash
npm run dev
```

Run the local bridge in another terminal:

```bash
BRIDGE_TOKEN=replace-me npm run dev:bridge
```

Or run frontend, bridge, and tunnel together:

```bash
BRIDGE_TOKEN=replace-me npm run dev:remote
```

Production-style startup:

```bash
npm run build
BRIDGE_TOKEN=replace-me npm run start:remote
```

## Environment | 环境变量

Required:

```bash
BRIDGE_TOKEN=replace-me
```

Common optional settings:

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

Keep local secrets in `.env.local` or `.env.remote.local`.

本地私有配置建议放在 `.env.local` 或 `.env.remote.local` 中。

## External Thread Sync API | 外部线程同步接口

Bindings are stored at:

```bash
~/.codex/codexremote-thread-bindings.json
```

### `POST /thread-bind`

Bind an external conversation id to an existing Codex Desktop thread.

把外部会话 ID 绑定到一个已存在的 Codex Desktop 线程。

```json
{
  "externalThreadId": "ext-123",
  "threadId": "codex-thread-id",
  "cwd": "/optional/workspace",
  "source": "my-site"
}
```

### `GET /thread-resolve?externalThreadId=ext-123`

Return the saved binding and a lightweight thread summary.

返回已保存的绑定关系和一个轻量线程摘要。

### `GET /thread-history?externalThreadId=ext-123`

Return the current Codex thread, including turns and status.

返回当前 Codex 线程，包括 turns 和状态。

### `POST /thread-send`

Append a new turn to the same Codex thread.

向同一个 Codex 线程追加一条新的 turn。

```json
{
  "externalThreadId": "ext-123",
  "text": "Continue this thread",
  "waitForCompletion": true
}
```

You can also pass `threadId` directly instead of `externalThreadId`.

如果你已经持有 `threadId`，也可以直接传 `threadId`，不一定非要通过 `externalThreadId`。

## Remote Access | 远程访问

- First-time pairing can use `?token=...`, but only to register the current browser as an allowed device.
- After pairing, the bridge sets device cookies and normal access no longer needs the token in the URL.
- Only paired devices can access `/codex-events`, `/codex-rpc`, and thread-management endpoints.
- Device registrations are stored at `~/.codex/codexremote-devices.json`.
- Do not expose the bridge port directly unless you intentionally want a second tunnel.

- 首次配对可以通过 `?token=...` 完成，但它只用于把当前浏览器登记为允许设备。
- 配对完成后，bridge 会写入设备 cookie，后续访问不再需要 URL 里的 token。
- 只有已配对设备才能访问 `/codex-events`、`/codex-rpc` 和线程管理接口。
- 设备注册信息默认保存在 `~/.codex/codexremote-devices.json`。
- 除非你明确想做第二层暴露，否则不要直接公开 bridge 端口。

## Cloudflare Tunnel | 通过 Cloudflare 暴露接口

This is the primary deployment model.

这就是项目的主要暴露方式。

What gets exposed:

- A single public HTTPS entrypoint to your local environment
- The Next.js frontend origin
- Same-origin API routes that proxy to the local bridge
- Browser access for remote devices after pairing

What stays local:

- The bridge port
- The raw Codex app-server websocket
- Local session files under `~/.codex/`

会被暴露出去的是：

- 一个指向你本地环境的统一公网 HTTPS 入口
- Next.js 前端 origin
- 通过同源路由代理出去的 API
- 配对后的远程浏览器访问能力

继续只留在本地的是：

- bridge 端口
- 原始 Codex app-server websocket
- `~/.codex/` 下的本机会话文件

Quick temporary tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Named tunnel setup:

```bash
CF_TUNNEL_DOMAIN=codex.example.com npm run tunnel:setup:domain
```

Manual named tunnel flow:

1. Create the tunnel.
2. Copy [`cloudflared/config.example.yml`](./cloudflared/config.example.yml) to your Cloudflare config path and fill in the tunnel id, credentials file, and hostname.
3. Route DNS and run the tunnel.

```bash
cloudflared tunnel create codexremote
cloudflared tunnel route dns codexremote codex.example.com
cloudflared tunnel --config ~/.cloudflared/config.yml run codexremote
```

End-to-end flow:

1. Start the frontend and bridge locally.
2. Start a Cloudflare Tunnel that points to the frontend.
3. Open `https://your-domain-or-trycloudflare-url?token=...` on any remote device for the first pairing.
4. After pairing, use the same public URL to access your local environment remotely with a Codex-like web experience.
5. Session and thread updates continue to flow against the same local Codex state.

端到端流程是：

1. 本地启动前端和 bridge。
2. 启动指向前端的 Cloudflare Tunnel。
3. 在任意远程设备上打开 `https://你的域名或trycloudflare地址?token=...` 完成首次配对。
4. 配对后，通过同一个公网 URL 远程访问你的本地环境，并获得接近 Codex app 的 Web 体验。
5. session 和 thread 的更新继续落在同一套本地 Codex 状态上。

## Development Notes | 开发说明

- The combined launcher deletes `._*` AppleDouble files before startup.
- `thread-send` waits for turn completion by default and returns the updated thread snapshot.
- Empty threads are not a required remote concept in this design.

- 组合启动脚本会在启动前清理 `._*` AppleDouble 文件。
- `thread-send` 默认会等待 turn 完成，再返回更新后的线程快照。
- 在这套设计里，空线程不是远端必须展示的概念。
