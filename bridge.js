const http = require('http');
const { randomBytes, randomUUID, createHash } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const bridgeDefaults = require('./config/bridge.json');

const CONFIG = resolveBridgeConfig(process.env);
const LOG_PATH = process.env.BRIDGE_DEBUG_LOG
  || path.join(process.env.HOME || '/tmp', '.codex', 'log', 'codex-bridge-debug.log');
const DEVICE_STORE_PATH = process.env.BRIDGE_DEVICE_STORE_PATH
  || path.join(process.env.HOME || '/tmp', '.codex', 'codex-bridge-devices.json');
const DEVICE_ID_COOKIE = 'codex_bridge_device_id';
const DEVICE_SECRET_COOKIE = 'codex_bridge_device_secret';
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const clients = new Map();
const SESSION_ROOT = path.join(process.env.HOME || '/tmp', '.codex', 'sessions');

function resolveBridgeConfig(env) {
  return {
    PORT: parseInt(env.BRIDGE_PORT, 10) || bridgeDefaults.defaultBridgePort,
    CODEX_WS: env.CODEX_WS_URL || bridgeDefaults.defaultCodexWs,
    TOKEN: env.BRIDGE_TOKEN || bridgeDefaults.defaultToken,
    EVENTS_PATH: env.BRIDGE_EVENTS_PATH || bridgeDefaults.defaultEventsPath,
    RPC_PATH: env.BRIDGE_RPC_PATH || bridgeDefaults.defaultRpcPath,
  };
}

function ensureLogFile() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, '');
  } catch {}
}

function ensureDeviceStore() {
  try {
    fs.mkdirSync(path.dirname(DEVICE_STORE_PATH), { recursive: true });
    if (!fs.existsSync(DEVICE_STORE_PATH)) {
      fs.writeFileSync(DEVICE_STORE_PATH, JSON.stringify({ version: 1, devices: [] }, null, 2));
    }
  } catch {}
}

function loadDeviceStore() {
  ensureDeviceStore();
  try {
    const raw = fs.readFileSync(DEVICE_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.devices)) {
      return { version: 1, devices: [] };
    }
    return { version: 1, devices: parsed.devices };
  } catch {
    return { version: 1, devices: [] };
  }
}

function saveDeviceStore(store) {
  ensureDeviceStore();
  fs.writeFileSync(DEVICE_STORE_PATH, JSON.stringify({
    version: 1,
    devices: Array.isArray(store?.devices) ? store.devices : [],
  }, null, 2));
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret || '')).digest('hex');
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const chunk of String(cookieHeader || '').split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function buildCookie(name, value, req, maxAge = DEVICE_COOKIE_MAX_AGE) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.socket.encrypted || forwardedProto === 'https') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function clearCookie(name, req) {
  return buildCookie(name, '', req, 0);
}

function sanitizeDeviceName(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return normalized || 'Unnamed device';
}

function getAdminToken(url, req) {
  return url.searchParams.get('token')
    || req.headers['x-bridge-token']
    || req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || '';
}

function authenticateRequest(req, url, options = {}) {
  const adminToken = getAdminToken(url, req);
  if (adminToken && adminToken === CONFIG.TOKEN) {
    return { ok: true, isAdmin: true, mode: 'token' };
  }

  if (options.requireAdmin) {
    return { ok: false, status: 401, error: 'Admin token required' };
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const deviceId = cookies[DEVICE_ID_COOKIE];
  const deviceSecret = cookies[DEVICE_SECRET_COOKIE];
  if (!deviceId || !deviceSecret) {
    return { ok: false, status: 401, error: 'Device authorization required' };
  }

  const store = loadDeviceStore();
  const device = store.devices.find((entry) => entry.id === deviceId);
  if (!device || device.revokedAt) {
    return { ok: false, status: 401, error: 'Device is not allowed' };
  }

  if (device.secretHash !== hashSecret(deviceSecret)) {
    return { ok: false, status: 401, error: 'Device credentials are invalid' };
  }

  device.lastSeenAt = new Date().toISOString();
  device.lastSeenIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown-ip';
  saveDeviceStore(store);
  return { ok: true, isAdmin: false, mode: 'device', device };
}

function sanitizeDevice(device) {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    lastSeenIp: device.lastSeenIp || null,
    revokedAt: device.revokedAt || null,
  };
}

function findSessionFileByThreadId(rootDir, threadId) {
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const nested = findSessionFileByThreadId(fullPath, threadId);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return fullPath;
      }
    }
  } catch {}
  return null;
}

function resolveSessionDeletePath(threadId, sessionPath) {
  if (sessionPath) {
    const normalized = path.resolve(sessionPath);
    const relative = path.relative(SESSION_ROOT, normalized);
    const withinRoot = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (withinRoot && normalized.endsWith('.jsonl') && path.basename(normalized).includes(threadId)) {
      return normalized;
    }
  }
  return findSessionFileByThreadId(SESSION_ROOT, threadId);
}

function writeDebugLog(event, payload = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {}
}

function summarizePayload(payload) {
  try {
    const data = JSON.parse(payload);
    return {
      id: data.id,
      method: data.method || null,
      hasResult: Object.prototype.hasOwnProperty.call(data, 'result'),
      resultKeys: data.result ? Object.keys(data.result) : [],
      paramsKeys: data.params ? Object.keys(data.params) : [],
    };
  } catch {
    return { raw: payload.slice(0, 200) };
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function writeJsonWithHeaders(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function detectBinary(command) {
  try {
    const path = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { available: Boolean(path), path: path || null };
  } catch {
    return { available: false, path: null };
  }
}

function getCapabilities() {
  return {
    codexRpc: {
      available: true,
      transport: 'local codex app-server',
      target: CONFIG.CODEX_WS,
    },
    screenshot: detectBinary('screencapture'),
    cloudflared: detectBinary('cloudflared'),
    git: detectBinary('git'),
    playwright: detectBinary('playwright'),
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function initializeSse(res) {
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true);
  }

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Keep the initial SSE prelude small so browsers parse subsequent events reliably.
  res.write(': connected\n\n');
}

function safeSendSse(client, event, payload) {
  if (!client || client.closed || client.res.writableEnded) return;
  sendSse(client.res, event, payload);
}

function flushInitialState(client) {
  if (!client || client.closed || client.res.writableEnded || client.initialStateFlushed) return;
  client.initialStateFlushed = true;
  safeSendSse(client, 'hello', { clientId: client.id });
  safeSendSse(client, 'status', { state: client.state });
}

function cleanupClient(clientId, reason = 'cleanup') {
  const client = clients.get(clientId);
  if (!client) return;

  client.closed = true;
  clearInterval(client.heartbeat);
  if (client.initialStateTimer) {
    clearTimeout(client.initialStateTimer);
    client.initialStateTimer = null;
  }
  clients.delete(clientId);
  writeDebugLog('client.cleanup', { clientId, reason });

  if (client.ws && (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING)) {
    client.ws.close();
  }

  if (!client.res.writableEnded) {
    try {
      sendSse(client.res, 'status', { state: 'closed', reason });
    } catch {}
    client.res.end();
  }

  console.log(`📱 [client ${clientId}] SSE client cleaned up: ${reason}`);
}

function createClient(res) {
  const clientId = randomUUID();
  const upstream = new WebSocket(CONFIG.CODEX_WS, {
    perMessageDeflate: false,
  });

  const client = {
    id: clientId,
    res,
    ws: upstream,
    queue: [],
    closed: false,
    heartbeat: null,
    state: 'connecting',
    initialStateFlushed: false,
    initialStateTimer: null,
  };

  clients.set(clientId, client);

  // Delay the first named SSE events slightly so browser listeners have time to attach.
  client.initialStateTimer = setTimeout(() => {
    client.initialStateTimer = null;
    flushInitialState(client);
  }, 50);

  client.heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15000);

  upstream.on('open', () => {
    if (client.closed) return;
    console.log(`🔗 [client ${clientId}] connected to Codex app-server`);
    client.state = 'connected';
    writeDebugLog('upstream.open', { clientId });
    if (client.initialStateFlushed) {
      safeSendSse(client, 'status', { state: 'connected' });
    }
    for (const payload of client.queue) {
      upstream.send(payload);
    }
    client.queue.length = 0;
  });

  upstream.on('message', (data) => {
    if (client.closed || res.writableEnded) return;
    writeDebugLog('upstream.message', {
      clientId,
      summary: summarizePayload(data.toString()),
    });
    sendSse(res, 'message', { payload: data.toString() });
  });

  upstream.on('error', (error) => {
    console.error(`❌ [client ${clientId}] upstream error:`, error.message);
    client.state = 'error';
    writeDebugLog('upstream.error', { clientId, message: error.message });
    if (!client.closed && !res.writableEnded) {
      if (client.initialStateFlushed) {
        safeSendSse(client, 'status', { state: 'error', message: error.message });
      }
    }
  });

  upstream.on('close', (code, reason) => {
    if (client.closed) return;
    const detail = String(reason || '');
    console.log(`❌ [client ${clientId}] upstream closed: ${code} ${detail}`);
    client.state = 'closed';
    writeDebugLog('upstream.close', { clientId, code, reason: detail });
    if (!res.writableEnded) {
      if (client.initialStateFlushed) {
        safeSendSse(client, 'status', { state: 'closed', code, reason: detail });
      }
    }
    cleanupClient(clientId, `upstream:${code}`);
  });

  return client;
}

async function main() {
  ensureLogFile();
  ensureDeviceStore();
  writeDebugLog('bridge.start', { port: CONFIG.PORT, codexWs: CONFIG.CODEX_WS });
  const server = http.createServer();

  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        codexWs: CONFIG.CODEX_WS,
        eventsPath: CONFIG.EVENTS_PATH,
        rpcPath: CONFIG.RPC_PATH,
      });
      return;
    }

    if (url.pathname === '/capabilities') {
      writeJson(res, 200, getCapabilities());
      return;
    }

    if (url.pathname === '/ready') {
      writeJson(res, 200, { status: 'ready' });
      return;
    }

    if (url.pathname === '/thread-delete' && req.method === 'POST') {
      const auth = authenticateRequest(req, url);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : '';
        const sessionPath = typeof payload.sessionPath === 'string' ? payload.sessionPath.trim() : '';

        if (!threadId) {
          writeJson(res, 400, { error: 'threadId is required' });
          return;
        }

        const targetPath = resolveSessionDeletePath(threadId, sessionPath);
        if (!targetPath) {
          writeDebugLog('thread.delete.missing', { threadId, sessionPath });
          writeJson(res, 404, { error: 'Session file not found' });
          return;
        }

        fs.unlinkSync(targetPath);
        writeDebugLog('thread.delete.ok', { threadId, sessionPath: targetPath });
        writeJson(res, 200, { ok: true, threadId, path: targetPath });
      } catch (error) {
        writeDebugLog('thread.delete.error', { message: error.message });
        writeJson(res, 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === '/device-status' && req.method === 'GET') {
      const auth = authenticateRequest(req, url);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        mode: auth.mode,
        isAdmin: auth.isAdmin,
        device: sanitizeDevice(auth.device),
      });
      return;
    }

    if (url.pathname === '/device-pair' && req.method === 'POST') {
      const auth = authenticateRequest(req, url, { requireAdmin: true });
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const name = sanitizeDeviceName(payload.deviceName);
        const store = loadDeviceStore();
        const deviceId = randomUUID();
        const deviceSecret = randomBytes(32).toString('base64url');
        const now = new Date().toISOString();

        const device = {
          id: deviceId,
          name,
          secretHash: hashSecret(deviceSecret),
          createdAt: now,
          lastSeenAt: now,
          lastSeenIp: req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown-ip',
          revokedAt: null,
        };

        store.devices.push(device);
        saveDeviceStore(store);

        writeDebugLog('device.pair.ok', { deviceId, name });
        writeJsonWithHeaders(res, 200, {
          ok: true,
          device: sanitizeDevice(device),
        }, {
          'Set-Cookie': [
            buildCookie(DEVICE_ID_COOKIE, deviceId, req),
            buildCookie(DEVICE_SECRET_COOKIE, deviceSecret, req),
          ],
        });
      } catch (error) {
        writeDebugLog('device.pair.error', { message: error.message });
        writeJson(res, 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === '/devices' && req.method === 'GET') {
      const auth = authenticateRequest(req, url, { requireAdmin: true });
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      const store = loadDeviceStore();
      writeJson(res, 200, {
        ok: true,
        devices: store.devices
          .filter((device) => !device.revokedAt)
          .map((device) => sanitizeDevice(device)),
      });
      return;
    }

    if (url.pathname === '/device-revoke' && req.method === 'POST') {
      const auth = authenticateRequest(req, url, { requireAdmin: true });
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const deviceId = String(payload.deviceId || '').trim();
        if (!deviceId) {
          writeJson(res, 400, { error: 'deviceId is required' });
          return;
        }

        const store = loadDeviceStore();
        const device = store.devices.find((entry) => entry.id === deviceId);
        if (!device || device.revokedAt) {
          writeJson(res, 404, { error: 'Device not found' });
          return;
        }

        device.revokedAt = new Date().toISOString();
        saveDeviceStore(store);
        writeDebugLog('device.revoke.ok', { deviceId });
        writeJson(res, 200, { ok: true, device: sanitizeDevice(device) });
      } catch (error) {
        writeDebugLog('device.revoke.error', { message: error.message });
        writeJson(res, 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === '/device-forget' && req.method === 'POST') {
      const auth = authenticateRequest(req, url);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      writeJsonWithHeaders(res, 200, { ok: true }, {
        'Set-Cookie': [
          clearCookie(DEVICE_ID_COOKIE, req),
          clearCookie(DEVICE_SECRET_COOKIE, req),
        ],
      });
      return;
    }

    if (url.pathname === CONFIG.EVENTS_PATH && req.method === 'GET') {
      const auth = authenticateRequest(req, url);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      initializeSse(res);

      const client = createClient(res);
      console.log(`📱 [client ${client.id}] connected ${req.socket.remoteAddress || 'unknown-ip'}`);
      writeDebugLog('events.connect', {
        clientId: client.id,
        remoteAddress: req.socket.remoteAddress || 'unknown-ip',
      });

      req.on('close', () => {
        cleanupClient(client.id, 'browser-disconnected');
      });
      return;
    }

    if (url.pathname === CONFIG.RPC_PATH && req.method === 'POST') {
      const clientId = url.searchParams.get('clientId');
      const auth = authenticateRequest(req, url);
      if (!auth.ok) {
        writeJson(res, auth.status, { error: auth.error });
        return;
      }

      const client = clientId ? clients.get(clientId) : null;
      if (!client || client.closed) {
        writeDebugLog('rpc.missing_client', { clientId });
        writeJson(res, 404, { error: 'Bridge session not found' });
        return;
      }

      try {
        const payload = await readRequestBody(req);
        if (!payload) {
          writeDebugLog('rpc.empty_payload', { clientId });
          writeJson(res, 400, { error: 'Empty payload' });
          return;
        }

        console.log(`📤 [client ${clientId}] Browser -> Codex: ${payload.slice(0, 160)}`);
        writeDebugLog('rpc.incoming', {
          clientId,
          wsState: client.ws.readyState,
          queuedBefore: client.queue.length,
          summary: summarizePayload(payload),
        });
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
          writeDebugLog('rpc.forwarded', { clientId, mode: 'direct' });
        } else {
          client.queue.push(payload);
          writeDebugLog('rpc.forwarded', { clientId, mode: 'queued', queuedAfter: client.queue.length });
        }

        res.writeHead(204);
        res.end();
      } catch (error) {
        console.error(`❌ [client ${clientId}] request body error:`, error.message);
        writeDebugLog('rpc.error', { clientId, message: error.message });
        writeJson(res, 500, { error: error.message });
      }
      return;
    }

    writeJson(res, 404, {
      error: 'Not found',
      availablePaths: ['/health', '/ready', '/capabilities', CONFIG.EVENTS_PATH, CONFIG.RPC_PATH],
    });
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`🚀 Codex Bridge API running on http://localhost:${CONFIG.PORT}`);
    console.log(`🎯 Codex target: ${CONFIG.CODEX_WS}`);
    console.log(`📡 SSE: http://localhost:${CONFIG.PORT}${CONFIG.EVENTS_PATH}`);
    console.log(`📨 RPC: http://localhost:${CONFIG.PORT}${CONFIG.RPC_PATH}?clientId=...`);
    console.log(`🔐 Device store: ${DEVICE_STORE_PATH}`);
    if (CONFIG.TOKEN === bridgeDefaults.defaultToken) {
      console.warn('⚠️ BRIDGE_TOKEN is using the default value. Set a custom token before exposing this bridge beyond localhost.');
    }
  });
}

main().catch((error) => {
  console.error('❌ Bridge failed to start:', error);
  process.exit(1);
});
