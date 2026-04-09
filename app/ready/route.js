import { createOptionsResponse, proxyBridgeRequest } from '../../lib/server/bridge-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  return proxyBridgeRequest(request, '/ready');
}

export async function OPTIONS() {
  return createOptionsResponse();
}
