import { createOptionsResponse, proxyBridgeRequest } from '../../lib/server/bridge-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  return proxyBridgeRequest(request, '/device-forget', {
    method: 'POST',
  });
}

export async function OPTIONS() {
  return createOptionsResponse();
}
