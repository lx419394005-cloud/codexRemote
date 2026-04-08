function getAllowedDevOrigins() {
  return Array.from(
    new Set(
      [
        '127.0.0.1',
        'localhost',
        '0.0.0.0',
        process.env.CF_TUNNEL_DOMAIN,
        ...(process.env.ALLOWED_DEV_ORIGINS || '')
          .split(',')
          .map((value) => value.trim()),
      ].filter(Boolean),
    ),
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: getAllowedDevOrigins(),
  env: {
    NEXT_PUBLIC_CF_TUNNEL_NAME: process.env.CF_TUNNEL_NAME || '',
    NEXT_PUBLIC_CF_TUNNEL_DOMAIN: process.env.CF_TUNNEL_DOMAIN || '',
    NEXT_PUBLIC_CF_TUNNEL_CONFIG_PATH: process.env.CF_TUNNEL_CONFIG_PATH || '',
    NEXT_PUBLIC_CF_TUNNEL_ID: process.env.CF_TUNNEL_ID || '',
  },
};

export default nextConfig;
