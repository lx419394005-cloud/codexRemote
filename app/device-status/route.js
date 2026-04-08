import { createOptionsResponse, proxyBridgeRequest } from '../../lib/server/bridge-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  return proxyBridgeRequest(request, '/device-status');
}

export async function OPTIONS() {
  return createOptionsResponse();
}
