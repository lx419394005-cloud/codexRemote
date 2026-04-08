import tunnelDefaults from '../config/cf-tunnel.example.json';

function getDefaultTunnelUrl() {
  return process.env.NEXT_PUBLIC_TUNNEL_URL || `http://127.0.0.1:${tunnelDefaults.defaultFrontendPort}`;
}

function getTunnelOverride(key, fallback) {
  return process.env[key] || fallback;
}

export function createDefaultSettings() {
  return {
    autoApproveAll: false,
    browserNotifications: false,
    sessionDeveloperInstructions: '',
    cfTunnelName: getTunnelOverride('NEXT_PUBLIC_CF_TUNNEL_NAME', tunnelDefaults.defaultName),
    cfTunnelDomain: getTunnelOverride('NEXT_PUBLIC_CF_TUNNEL_DOMAIN', tunnelDefaults.defaultDomain),
    cfTunnelUrl: getDefaultTunnelUrl(),
    cfTunnelConfigPath: getTunnelOverride('NEXT_PUBLIC_CF_TUNNEL_CONFIG_PATH', tunnelDefaults.defaultConfigPath),
    cfTunnelId: getTunnelOverride('NEXT_PUBLIC_CF_TUNNEL_ID', tunnelDefaults.defaultTunnelId),
  };
}

export function buildTunnelCommands(settings) {
  const quickCommand = `cloudflared tunnel --url ${settings.cfTunnelUrl}`;
  const namedCommand = settings.cfTunnelDomain
    ? `cloudflared tunnel create ${settings.cfTunnelName}\ncloudflared tunnel route dns ${settings.cfTunnelName} ${settings.cfTunnelDomain}\ncloudflared tunnel --config ${settings.cfTunnelConfigPath} run ${settings.cfTunnelName}`
    : `cloudflared tunnel create ${settings.cfTunnelName}\ncloudflared tunnel --config ${settings.cfTunnelConfigPath} run ${settings.cfTunnelName}`;

  return {
    quickCommand,
    namedCommand,
  };
}
