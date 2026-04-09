import bridgeDefaults from '../config/bridge.json';

export const BRIDGE_STORAGE_KEYS = bridgeDefaults.storageKeys;
export const DEFAULT_BRIDGE_TOKEN =
  process.env.NEXT_PUBLIC_BRIDGE_TOKEN || bridgeDefaults.defaultToken;

export function createDefaultCapabilities() {
  return {
    codexRpc: { available: false, transport: '', target: '' },
    screenshot: { available: false, path: null },
    cloudflared: { available: false, path: null },
    git: { available: false, path: null },
    playwright: { available: false, path: null },
  };
}

export function getBridgeBaseUrl() {
  if (typeof window !== 'undefined') {
    return (
      window.__CODEX_BRIDGE_BASE_URL__ ||
      process.env.NEXT_PUBLIC_BRIDGE_URL ||
      window.location.origin
    );
  }

  return (
    process.env.NEXT_PUBLIC_BRIDGE_URL ||
    `http://${bridgeDefaults.defaultBridgeHost}:${bridgeDefaults.defaultBridgePort}`
  );
}

export function buildBridgeUrl(path) {
  return new URL(path, getBridgeBaseUrl()).toString();
}

export function getInitialBridgeToken() {
  if (typeof window === 'undefined') {
    return DEFAULT_BRIDGE_TOKEN;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get('token') || DEFAULT_BRIDGE_TOKEN;
}
