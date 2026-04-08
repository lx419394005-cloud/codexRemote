# Codex Bridge

Remote access is designed to run through the Next frontend on `127.0.0.1:8080`.
The frontend now proxies bridge endpoints to the local bridge service on `127.0.0.1:8081`, so Cloudflare Tunnel only needs to expose one local origin.

## Local services

In one terminal:

```bash
npm run dev
```

In another terminal:

```bash
BRIDGE_TOKEN=replace-me npm run dev:bridge
```

One command to start frontend, bridge, and your named tunnel together:

```bash
BRIDGE_TOKEN=replace-me npm run dev:remote
```

This launcher automatically deletes `._*` AppleDouble files in the workspace before startup.

Production-style startup:

```bash
npm run build
BRIDGE_TOKEN=replace-me npm run start:remote
```

## Cloudflare Tunnel

Quick temporary tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

The combined launcher uses the named tunnel config by default. To override it explicitly:

```bash
CF_TUNNEL_MODE=named \
CF_TUNNEL_NAME=codex-bridge \
CF_TUNNEL_DOMAIN=codex.example.com \
CF_TUNNEL_CONFIG_PATH=~/.cloudflared/config-codex-bridge.yml \
BRIDGE_TOKEN=replace-me \
npm run dev:remote
```

To initialize a named tunnel for your own domain:

```bash
CF_TUNNEL_DOMAIN=codex.example.com npm run tunnel:setup:domain
```

The setup script will:

- open `cloudflared tunnel login` if this machine is not authenticated yet
- create or reuse the named tunnel
- bind your hostname to that tunnel
- write a ready-to-run config file under `~/.cloudflared/`

Named tunnel:

1. Create the tunnel.
2. Copy [`cloudflared/config.example.yml`](/Volumes/new/dev/web/codeonline/codex-bridge/cloudflared/config.example.yml) to your Cloudflare config path and fill in the tunnel id, credentials file, and hostname.
3. Route DNS and run the tunnel.

```bash
cloudflared tunnel create codex-bridge
cloudflared tunnel route dns codex-bridge codex.example.com
cloudflared tunnel --config ~/.cloudflared/config.yml run codex-bridge
```

## Required env

```bash
BRIDGE_TOKEN=replace-me
```

Optional:

```bash
FRONTEND_PORT=8080
BRIDGE_PORT=8081
NEXT_PUBLIC_BRIDGE_URL=http://127.0.0.1:8081
NEXT_PUBLIC_TUNNEL_URL=http://127.0.0.1:8080
CF_TUNNEL_MODE=named
CF_TUNNEL_NAME=codex-bridge
CF_TUNNEL_DOMAIN=codex.longx.top
ALLOWED_DEV_ORIGINS=codex.example.com
CF_TUNNEL_CONFIG_PATH=~/.cloudflared/config-codex-bridge.yml
```

## Remote access notes

- First-time pairing still uses `?token=...`, but only to register the current browser as an allowed device.
- After pairing, the bridge sets device cookies and normal access no longer needs the token in the URL.
- Only paired devices can open `/codex-events`, `/codex-rpc`, and thread management endpoints.
- Device registrations are stored under `~/.codex/codex-bridge-devices.json` by default.
- The browser talks to `/codex-events` and `/codex-rpc` on the same origin.
- Do not expose the bridge port directly unless you intentionally want a second tunnel.
