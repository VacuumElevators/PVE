import { sha256Hex } from './hash.js';

const DRIFT_MS = 5 * 60 * 1000; // 5 minutes
const HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Verify an incoming signed request from Zoho Deluge.
 *
 * Required headers:
 *   X-Signature  HMAC-SHA256 hex of the canonical payload, key = secret
 *   X-Timestamp  UTC epoch ms used in the payload's last line
 *
 * Canonical payload (newline-delimited, no trailing newline):
 *   METHOD
 *   PATH
 *   QUERY            (e.g. "email_hash=abc..."; empty string when no query)
 *   SHA256_HEX(BODY) (constant e3b0...b855 for empty body)
 *   UTC_EPOCH_MS
 *
 * Returns {valid: true} or {valid: false, reason: "..."}; reason feeds telemetry counters.
 */
export async function verifyHmac(request, secret) {
  const signature = request.headers.get('X-Signature');
  const timestamp = request.headers.get('X-Timestamp');

  if (!signature || !timestamp) return { valid: false, reason: 'missing_headers' };
  if (!HEX_REGEX.test(signature)) return { valid: false, reason: 'malformed_signature' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'malformed_timestamp' };

  const drift = Math.abs(Date.now() - ts);
  if (drift > DRIFT_MS) return { valid: false, reason: 'drift_too_high' };

  const url = new URL(request.url);
  const bodyText = await request.clone().text();
  const bodyHash = await sha256Hex(bodyText);

  const payload = [
    request.method,
    url.pathname,
    url.search.slice(1), // strip leading "?"; empty string when no query
    bodyHash,
    String(ts),
  ].join('\n');

  const expected = await hmacSha256Hex(secret, payload);
  if (!constantTimeEqual(signature, expected)) return { valid: false, reason: 'signature_mismatch' };

  return { valid: true };
}

/** HMAC-SHA256 of a string with a string key. Returns 64-char lowercase hex. */
async function hmacSha256Hex(secret, payload) {
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison.
 * Web Crypto has no timingSafeEqual; fall back to a length-checked XOR accumulator.
 * Both inputs assumed to be lowercase hex of equal length in the success case.
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
