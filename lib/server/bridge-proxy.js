import bridgeDefaults from '../../config/bridge.json';

const BRIDGE_BASE_URL =
  process.env.NEXT_PUBLIC_BRIDGE_URL ||
  `http://${bridgeDefaults.defaultBridgeHost}:${bridgeDefaults.defaultBridgePort}`;

function buildUpstreamUrl(pathname, searchParams) {
  const url = new URL(pathname, BRIDGE_BASE_URL);
  url.search = new URLSearchParams(searchParams).toString();
  return url;
}

function filterResponseHeaders(headers) {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete('content-length');
  nextHeaders.delete('connection');
  nextHeaders.delete('keep-alive');
  nextHeaders.delete('transfer-encoding');
  return nextHeaders;
}

export function createOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function proxyBridgeRequest(request, pathname, init = {}) {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(pathname, incomingUrl.searchParams);
  const upstreamHeaders = new Headers(init.headers || undefined);
  const cookie = request.headers.get('cookie');
  if (cookie && !upstreamHeaders.has('cookie')) {
    upstreamHeaders.set('cookie', cookie);
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: init.method || request.method,
    headers: upstreamHeaders,
    body: init.body,
    cache: 'no-store',
    redirect: 'manual',
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: filterResponseHeaders(upstreamResponse.headers),
  });
}
