# codexRemote

[中文说明](./README.zh-CN.md)

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![WebSocket](https://img.shields.io/badge/WebSocket-JSON--RPC-4A154B)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![Remote Access](https://img.shields.io/badge/Remote-Any%20Device-0F172A)](#)

codexRemote gives you a web entrypoint into your local Codex environment from any device. It keeps the raw Codex app-server private on your machine, proxies access through a local Next.js + Node bridge, and exposes only the web surface through Cloudflare Tunnel.

The goal is simple:

- Access your local Codex environment from phone, tablet, or another computer
- Keep the remote UX close to the Codex desktop app
- Keep sessions and threads synchronized with the desktop side

## What "local environment" means

codexRemote is not a hosted Codex clone. It connects back to the same local environment your desktop Codex is already using:

- local workspace
- local files
- local Codex session history
- local thread state
- local runtime access mediated by the bridge

## Architecture

```text
Any Device Browser
        |
        v
Public HTTPS URL (Cloudflare Tunnel)
        |
        v
Next.js frontend on 127.0.0.1:8080
        |
        v
Local bridge service on 127.0.0.1:8081
        |
        v
Codex app-server websocket on 127.0.0.1:7677
```

Only the frontend origin is meant to be exposed publicly. The bridge port and raw Codex websocket remain local.

## Install

```bash
npm install
```

Requirements:

- Node.js 18+
- a running local Codex Desktop / Codex app-server environment
- `cloudflared` if you want public remote access

## Local development

Start the frontend:

```bash
npm run dev
```

Start the bridge:

```bash
BRIDGE_TOKEN=replace-me npm run dev:bridge
```

Or start frontend + bridge + tunnel together:

```bash
BRIDGE_TOKEN=replace-me npm run dev:remote
```

Production-style startup:

```bash
npm run build
BRIDGE_TOKEN=replace-me npm run start:remote
```

Global helper:

```bash
codexremote start
codexremote status
codexremote stop
```

## Configuration

Required:

```bash
BRIDGE_TOKEN=replace-me
```

Common optional environment variables:

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

Use `.env.local` or `.env.remote.local` for machine-local secrets.

## How local proxying works

The browser talks to the Next.js app on `:8080`.

The Next.js app exposes server routes such as:

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

These routes forward requests to the local bridge on `:8081` through `lib/server/bridge-proxy.js`, so the browser never needs to hit the bridge port directly.

## How to expose it externally

The intended public deployment model is Cloudflare Tunnel.

Quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Named tunnel setup:

```bash
CF_TUNNEL_DOMAIN=codex.example.com npm run tunnel:setup:domain
```

Manual named tunnel flow:

```bash
cloudflared tunnel create codexremote
cloudflared tunnel route dns codexremote codex.example.com
cloudflared tunnel --config ~/.cloudflared/config.yml run codexremote
```

Once the tunnel is up:

1. open the public URL with `?token=...` for first-time pairing
2. pair the device
3. continue using the same public URL without the token for normal access

## Device authorization model

- first-time pairing can use an admin token in the URL
- after pairing, device cookies are used
- only paired devices can access event, RPC, and thread-management routes
- device registrations are stored at `~/.codex/codexremote-devices.json`

## Technical surfaces

### Local bridge HTTP endpoints

Core bridge endpoints:

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

### Codex JSON-RPC methods used by the app

The web client and bridge rely on these upstream Codex RPC methods:

- `initialize`
- `initialized` notification
- `model/list`
- `fs/readDirectory`
- `thread/list`
- `thread/read`
- `thread/start`
- `turn/start`

The UI also listens for event notifications such as:

- `thread/started`
- `thread/status/changed`
- `thread/name/updated`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- approval request events

## How desktop and remote stay synchronized

Synchronization is intentionally narrow and stable:

- Codex Desktop remains the source of truth
- remote clients read the same thread state from local Codex
- remote clients append new turns to the same thread
- thread status is mirrored directly
- old history is not rewritten or imported

For external systems, codexRemote can store:

```text
externalThreadId -> codexThreadId
```

This allows an external system to keep using one logical conversation id while still writing into the same local Codex thread.

Thread bindings are stored at:

```bash
~/.codex/codexremote-thread-bindings.json
```

## External sync API

### `POST /thread-bind`

Bind an external conversation id to an existing Codex thread.

```json
{
  "externalThreadId": "ext-123",
  "threadId": "codex-thread-id",
  "cwd": "/optional/workspace",
  "source": "my-site"
}
```

### `GET /thread-resolve?externalThreadId=ext-123`

Return the saved binding plus a lightweight thread summary.

### `GET /thread-history?externalThreadId=ext-123`

Return the current Codex thread, including turns and status.

### `POST /thread-send`

Append a new turn to the same Codex thread.

```json
{
  "externalThreadId": "ext-123",
  "text": "Continue this thread",
  "waitForCompletion": true
}
```

You can also pass `threadId` directly.

## Notes

- empty or not-yet-materialized threads do not need to be shown remotely
- sync is incremental: same thread, new turns only
- if the desktop thread is in an error state, the remote side should show that same error state
- the combined launcher cleans `._*` AppleDouble files before startup
