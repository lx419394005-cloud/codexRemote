import { createOptionsResponse, proxyBridgeRequest } from '../../lib/server/bridge-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  const body = await request.text();
  return proxyBridgeRequest(request, '/codex-rpc', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': request.headers.get('content-type') || 'application/json',
    },
  });
}

export async function OPTIONS() {
  return createOptionsResponse();
}
