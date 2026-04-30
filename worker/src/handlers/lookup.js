import { isHex64 } from '../lib/hash.js';
import { verifyHmac } from '../lib/hmac.js';

/**
 * GET /lookup?email_hash=<hex>
 *
 * Server-to-server endpoint. Auth: HMAC SHA-256 in X-Signature, timestamp
 * in X-Timestamp. Caller is Zoho Deluge (enrichLeadFromKV).
 *
 * 200 + JSON value | 401 invalid auth | 400 bad email_hash | 404 not found
 */
export async function handleLookup(request, env) {
  const auth = await verifyHmac(request, env.HMAC_SECRET);
  if (!auth.valid) {
    log('lookup_401', { reason: auth.reason });
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const email_hash = url.searchParams.get('email_hash') || '';
  if (!isHex64(email_hash)) {
    log('lookup_400', { reason: 'bad_email_hash' });
    return new Response('Invalid email_hash', { status: 400 });
  }

  let raw;
  try {
    raw = await env.PVE_KV.get(email_hash);
  } catch (err) {
    log('lookup_5xx', { error: String(err) });
    return new Response('Internal Error', { status: 500 });
  }

  if (raw === null) {
    log('lookup_404');
    return new Response('Not Found', { status: 404 });
  }

  log('lookup_200');
  return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}
