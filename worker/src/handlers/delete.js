import { isHex64 } from '../lib/hash.js';
import { verifyHmac } from '../lib/hmac.js';

/**
 * DELETE /identify
 *
 * GDPR DSAR mechanism. TTL on KV is retention hygiene only; this endpoint
 * is the explicit deletion right. Idempotent: succeeds even if key is
 * already absent.
 *
 * Body: { "email_hash": "<hex>" }
 * Auth: HMAC SHA-256 (signed payload includes sha256(body), so body
 * tampering is detected).
 */
export async function handleDelete(request, env) {
  const auth = await verifyHmac(request, env.HMAC_SECRET);
  if (!auth.valid) {
    log('delete_401', { reason: auth.reason });
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    log('delete_400', { reason: 'bad_body' });
    return new Response('Bad Request', { status: 400 });
  }

  const email_hash = body?.email_hash || '';
  if (!isHex64(email_hash)) {
    log('delete_400', { reason: 'bad_email_hash' });
    return new Response('Invalid email_hash', { status: 400 });
  }

  try {
    await env.PVE_KV.delete(email_hash);
  } catch (err) {
    log('delete_5xx', { error: String(err) });
    return new Response('Internal Error', { status: 500 });
  }

  log('delete_200');
  return new Response('OK', { status: 200 });
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}
