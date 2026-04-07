const http = require('http');
const next = require('next');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { WebSocket } = require('ws');

const CONFIG = {
  PORT: parseInt(process.env.BRIDGE_PORT, 10) || 8080,
  CODEX_WS: process.env.CODEX_WS_URL || 'ws://127.0.0.1:7676',
  TOKEN: process.env.BRIDGE_TOKEN || 'changeme',
  EVENTS_PATH: process.env.BRIDGE_EVENTS_PATH || '/codex-events',
  RPC_PATH: process.env.BRIDGE_RPC_PATH || '/codex-rpc',
};

const clients = new Map();

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(payload));
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

function cleanupClient(clientId, reason = 'cleanup') {
  const client = clients.get(clientId);
  if (!client) return;

  client.closed = true;
  clearInterval(client.heartbeat);
  clients.delete(clientId);

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
  };

  clients.set(clientId, client);

  sendSse(res, 'hello', { clientId });
  sendSse(res, 'status', { state: 'connecting' });

  client.heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15000);

  upstream.on('open', () => {
    if (client.closed) return;
    console.log(`🔗 [client ${clientId}] connected to Codex app-server`);
    sendSse(res, 'status', { state: 'connected' });
    for (const payload of client.queue) {
      upstream.send(payload);
    }
    client.queue.length = 0;
  });

  upstream.on('message', (data) => {
    if (client.closed || res.writableEnded) return;
    sendSse(res, 'message', { payload: data.toString() });
  });

  upstream.on('error', (error) => {
    console.error(`❌ [client ${clientId}] upstream error:`, error.message);
    if (!client.closed && !res.writableEnded) {
      sendSse(res, 'status', { state: 'error', message: error.message });
    }
  });

  upstream.on('close', (code, reason) => {
    if (client.closed) return;
    const detail = String(reason || '');
    console.log(`❌ [client ${clientId}] upstream closed: ${code} ${detail}`);
    if (!res.writableEnded) {
      sendSse(res, 'status', { state: 'closed', code, reason: detail });
    }
    cleanupClient(clientId, `upstream:${code}`);
  });

  return client;
}

async function main() {
  const dev = process.env.NODE_ENV !== 'production';
  const server = http.createServer();
  const nextApp = next({
    dev,
    dir: __dirname,
    hostname: 'localhost',
    port: CONFIG.PORT,
  });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();

  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

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

    if (url.pathname === CONFIG.EVENTS_PATH && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (token !== CONFIG.TOKEN) {
        writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const client = createClient(res);
      console.log(`📱 [client ${client.id}] connected ${req.socket.remoteAddress || 'unknown-ip'}`);

      req.on('close', () => {
        cleanupClient(client.id, 'browser-disconnected');
      });
      return;
    }

    if (url.pathname === CONFIG.RPC_PATH && req.method === 'POST') {
      const token = url.searchParams.get('token');
      const clientId = url.searchParams.get('clientId');

      if (token !== CONFIG.TOKEN) {
        writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const client = clientId ? clients.get(clientId) : null;
      if (!client || client.closed) {
        writeJson(res, 404, { error: 'Bridge session not found' });
        return;
      }

      try {
        const payload = await readRequestBody(req);
        if (!payload) {
          writeJson(res, 400, { error: 'Empty payload' });
          return;
        }

        console.log(`📤 [client ${clientId}] Browser -> Codex: ${payload.slice(0, 160)}`);
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        } else {
          client.queue.push(payload);
        }

        res.writeHead(204);
        res.end();
      } catch (error) {
        console.error(`❌ [client ${clientId}] request body error:`, error.message);
        writeJson(res, 500, { error: error.message });
      }
      return;
    }

    nextHandler(req, res);
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`🚀 Codex Bridge running on http://localhost:${CONFIG.PORT}`);
    console.log(`🎯 Codex target: ${CONFIG.CODEX_WS}`);
    console.log(`📡 SSE: http://localhost:${CONFIG.PORT}${CONFIG.EVENTS_PATH}?token=${CONFIG.TOKEN}`);
    console.log(`📨 RPC: http://localhost:${CONFIG.PORT}${CONFIG.RPC_PATH}?token=${CONFIG.TOKEN}&clientId=...`);
    if (CONFIG.TOKEN === 'changeme') {
      console.warn('⚠️ BRIDGE_TOKEN is using the default value. Set a custom token before exposing this bridge beyond localhost.');
    }
  });
}

main().catch((error) => {
  console.error('❌ Bridge failed to start:', error);
  process.exit(1);
});
