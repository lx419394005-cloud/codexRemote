import http from 'http';
import { randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { loadLocalEnv } from './load-local-env.mjs';

loadLocalEnv();

const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '8080', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8081', 10);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || randomBytes(24).toString('base64url');
const REMOTE_MODE = process.env.REMOTE_MODE || 'development';
const CF_TUNNEL_MODE = process.env.CF_TUNNEL_MODE || 'named';
const CF_TUNNEL_NAME = process.env.CF_TUNNEL_NAME || 'codex-bridge';
const CF_TUNNEL_DOMAIN = process.env.CF_TUNNEL_DOMAIN || 'codex.example.com';
const CF_TUNNEL_CONFIG_PATH =
  process.env.CF_TUNNEL_CONFIG_PATH || `${process.env.HOME}/.cloudflared/config-codex-bridge.yml`;
const ALLOWED_DEV_ORIGINS = process.env.ALLOWED_DEV_ORIGINS || CF_TUNNEL_DOMAIN;
const TUNNEL_URL = process.env.NEXT_PUBLIC_TUNNEL_URL || `http://127.0.0.1:${FRONTEND_PORT}`;

const children = [];
let shuttingDown = false;
let announcedTunnelUrl = false;

function cleanAppleDoubleFiles() {
  const result = spawnSync('find', [process.cwd(), '-name', '._*', '-type', 'f', '-print', '-delete'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'failed to clean AppleDouble files');
  }

  const deleted = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(`[remote] AppleDouble cleanup complete: ${deleted.length} files removed.`);
}

function runCommand(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${name}]`;
  const writeLine = (stream, line) => {
    if (!line) return;
    stream.write(`${prefix} ${line}\n`);
  };

  const pipeOutput = (stream, target, onLine) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        writeLine(target, line);
        onLine?.(line);
      }
    });
    stream.on('end', () => {
      if (buffer) {
        writeLine(target, buffer);
        onLine?.(buffer);
      }
    });
  };

  pipeOutput(child.stdout, process.stdout, (line) => {
    if (name !== 'tunnel' || announcedTunnelUrl) return;
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) {
      announcedTunnelUrl = true;
      console.log(`[remote] Public URL: ${match[0]}?token=${encodeURIComponent(BRIDGE_TOKEN)}`);
    }
  });
  pipeOutput(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`${prefix} exited with ${detail}`);
    shutdown(code || 1);
  });

  children.push(child);
  return child;
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, label, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    if (await probe(url)) {
      console.log(`[remote] ${label} ready at ${url}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${label} did not become ready: ${url}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 1500).unref();
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getTunnelCommand() {
  if (CF_TUNNEL_MODE === 'named') {
    return {
      command: 'cloudflared',
      args: ['tunnel', '--config', CF_TUNNEL_CONFIG_PATH, 'run', CF_TUNNEL_NAME],
      description: `named tunnel ${CF_TUNNEL_NAME}`,
    };
  }

  return {
    command: 'cloudflared',
    args: ['tunnel', '--url', TUNNEL_URL],
    description: `quick tunnel for ${TUNNEL_URL}`,
  };
}

async function main() {
  const npmCommand = getNpmCommand();
  const frontendScript = REMOTE_MODE === 'production' ? 'start' : 'dev';
  const bridgeScript = REMOTE_MODE === 'production' ? 'start:bridge' : 'dev:bridge';

  cleanAppleDoubleFiles();
  console.log(`[remote] Mode: ${REMOTE_MODE}`);
  console.log(`[remote] Frontend port: ${FRONTEND_PORT}`);
  console.log(`[remote] Bridge port: ${BRIDGE_PORT}`);
  console.log(`[remote] Tunnel mode: ${CF_TUNNEL_MODE}`);
  if (CF_TUNNEL_MODE === 'named') {
    console.log(`[remote] Tunnel domain: ${CF_TUNNEL_DOMAIN}`);
    console.log(`[remote] Tunnel config: ${CF_TUNNEL_CONFIG_PATH}`);
  }

  console.log(
    `[remote] Bridge token: ${process.env.BRIDGE_TOKEN ? 'provided via env' : 'generated for this run'}`,
  );
  console.log(`[remote] Token value: ${BRIDGE_TOKEN}`);

  runCommand('frontend', npmCommand, ['run', frontendScript], {
    FRONTEND_PORT: String(FRONTEND_PORT),
    NEXT_PUBLIC_BRIDGE_TOKEN: BRIDGE_TOKEN,
    NEXT_PUBLIC_TUNNEL_URL: TUNNEL_URL,
    CF_TUNNEL_DOMAIN,
    ALLOWED_DEV_ORIGINS,
  });
  runCommand('bridge', npmCommand, ['run', bridgeScript], {
    BRIDGE_PORT: String(BRIDGE_PORT),
    BRIDGE_TOKEN,
  });

  await waitFor(`http://127.0.0.1:${FRONTEND_PORT}`, 'frontend');
  await waitFor(`http://127.0.0.1:${BRIDGE_PORT}/ready`, 'bridge');

  const tunnel = getTunnelCommand();
  console.log(`[remote] Starting ${tunnel.description}`);
  runCommand('tunnel', tunnel.command, tunnel.args);

  const localUrl = `http://127.0.0.1:${FRONTEND_PORT}?token=${encodeURIComponent(BRIDGE_TOKEN)}`;
  console.log(`[remote] Local URL: ${localUrl}`);
  if (CF_TUNNEL_MODE === 'named') {
    console.log(`[remote] Public URL: https://${CF_TUNNEL_DOMAIN}?token=${encodeURIComponent(BRIDGE_TOKEN)}`);
  }
  console.log('[remote] Press Ctrl+C to stop frontend, bridge, and tunnel together.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

main().catch((error) => {
  console.error(`[remote] Startup failed: ${error.message}`);
  shutdown(1);
});
