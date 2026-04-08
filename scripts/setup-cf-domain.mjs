import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadLocalEnv } from './load-local-env.mjs';

loadLocalEnv();

const HOME = os.homedir();
const CLOUD_FLARED_DIR = path.join(HOME, '.cloudflared');
const TUNNEL_NAME = process.env.CF_TUNNEL_NAME || 'codex-bridge';
const TUNNEL_DOMAIN = process.env.CF_TUNNEL_DOMAIN || process.argv[2] || '';
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '8080', 10);
const CONFIG_PATH =
  process.env.CF_TUNNEL_CONFIG_PATH || path.join(CLOUD_FLARED_DIR, `config-${TUNNEL_NAME}.yml`);
const ORIGIN_CERT_PATH =
  process.env.TUNNEL_ORIGIN_CERT || path.join(CLOUD_FLARED_DIR, 'cert.pem');

function fail(message) {
  console.error(`[cf-setup] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      TUNNEL_ORIGIN_CERT: ORIGIN_CERT_PATH,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${command} ${args.join(' ')} failed`);
  }

  return result.stdout || '';
}

function ensureLoggedIn() {
  fs.mkdirSync(CLOUD_FLARED_DIR, { recursive: true });

  if (fs.existsSync(ORIGIN_CERT_PATH)) {
    console.log(`[cf-setup] Using origin cert: ${ORIGIN_CERT_PATH}`);
    return;
  }

  console.log('[cf-setup] No origin cert found. Starting Cloudflare login...');
  const result = spawnSync('cloudflared', ['tunnel', 'login'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error('cloudflared tunnel login failed');
  }

  if (!fs.existsSync(ORIGIN_CERT_PATH)) {
    throw new Error(`login completed but cert not found at ${ORIGIN_CERT_PATH}`);
  }
}

function getExistingTunnel() {
  const raw = run('cloudflared', ['tunnel', 'list', '--output', 'json', '--name', TUNNEL_NAME]);
  const tunnels = JSON.parse(raw) || [];
  return tunnels[0] || null;
}

function createTunnel() {
  const raw = run('cloudflared', ['tunnel', 'create', '--output', 'json', TUNNEL_NAME]);
  return JSON.parse(raw);
}

function ensureTunnel() {
  const existing = getExistingTunnel();
  if (existing) {
    console.log(`[cf-setup] Reusing tunnel ${existing.name} (${existing.id})`);
    return existing;
  }

  const created = createTunnel();
  console.log(`[cf-setup] Created tunnel ${created.name} (${created.id})`);
  return created;
}

function ensureDnsRoute() {
  run('cloudflared', ['tunnel', 'route', 'dns', TUNNEL_NAME, TUNNEL_DOMAIN], {
    stdio: 'pipe',
  });
  console.log(`[cf-setup] Routed DNS ${TUNNEL_DOMAIN} -> tunnel ${TUNNEL_NAME}`);
}

function writeConfig(tunnelId) {
  const credentialsFile = path.join(CLOUD_FLARED_DIR, `${tunnelId}.json`);
  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
    `  - hostname: ${TUNNEL_DOMAIN}`,
    `    service: http://127.0.0.1:${FRONTEND_PORT}`,
    '  - service: http_status:404',
    '',
  ].join('\n');

  fs.writeFileSync(CONFIG_PATH, yaml, 'utf8');
  console.log(`[cf-setup] Wrote config: ${CONFIG_PATH}`);
}

function main() {
  if (!TUNNEL_DOMAIN) {
    fail('Missing hostname. Use CF_TUNNEL_DOMAIN=codex.example.com or pass it as the first argument.');
  }

  try {
    run('cloudflared', ['--version']);
  } catch {
    fail('cloudflared is not installed or not available in PATH.');
  }

  ensureLoggedIn();
  const tunnel = ensureTunnel();
  writeConfig(tunnel.id);
  ensureDnsRoute();

  console.log('[cf-setup] Done.');
  console.log(`[cf-setup] Hostname: https://${TUNNEL_DOMAIN}`);
  console.log(`[cf-setup] Start named tunnel with: CF_TUNNEL_MODE=named CF_TUNNEL_NAME=${TUNNEL_NAME} CF_TUNNEL_CONFIG_PATH=${CONFIG_PATH} BRIDGE_TOKEN=replace-me npm run dev:remote`);
}

main();
