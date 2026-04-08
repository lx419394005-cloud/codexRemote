import tunnelDefaults from '../config/cf-tunnel.json';

function getDefaultTunnelUrl() {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.host}`;
  }

  return process.env.NEXT_PUBLIC_TUNNEL_URL || `http://127.0.0.1:${tunnelDefaults.defaultFrontendPort}`;
}

export function createDefaultSettings() {
  return {
    autoApproveAll: false,
    browserNotifications: false,
    sessionDeveloperInstructions: '',
    cfTunnelName: tunnelDefaults.defaultName,
    cfTunnelDomain: tunnelDefaults.defaultDomain,
    cfTunnelUrl: getDefaultTunnelUrl(),
    cfTunnelConfigPath: tunnelDefaults.defaultConfigPath,
    cfTunnelId: tunnelDefaults.defaultTunnelId,
  };
}

export function buildTunnelCommands(settings) {
  const quickCommand = `cloudflared tunnel --url ${settings.cfTunnelUrl}`;
  const namedCommand = settings.cfTunnelDomain
    ? `cloudflared tunnel route dns ${settings.cfTunnelName} ${settings.cfTunnelDomain}\ncloudflared tunnel --config ${settings.cfTunnelConfigPath} run ${settings.cfTunnelName}`
    : `cloudflared tunnel create ${settings.cfTunnelName}\ncloudflared tunnel --config ${settings.cfTunnelConfigPath} run ${settings.cfTunnelName}`;

  return {
    quickCommand,
    namedCommand,
  };
}
