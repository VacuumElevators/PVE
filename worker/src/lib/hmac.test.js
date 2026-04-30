import { describe, it, expect } from 'vitest';
import { verifyHmac } from './hmac.js';
import { sha256Hex } from './hash.js';

const SECRET = 'test-secret-12345';

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeSigned(method, urlStr, body, secret, ts) {
  ts = ts ?? Date.now();
  const url = new URL(urlStr);
  const bodyHash = await sha256Hex(body || '');
  const payload = [method, url.pathname, url.search.slice(1), bodyHash, String(ts)].join('\n');
  const sig = await hmacHex(secret, payload);
  return new Request(urlStr, {
    method,
    body: body || undefined,
    headers: { 'X-Signature': sig, 'X-Timestamp': String(ts) },
  });
}

describe('verifyHmac', () => {
  it('valid signed GET returns valid', async () => {
    const req = await makeSigned('GET', 'https://example.com/lookup?email_hash=abc', null, SECRET);
    expect(await verifyHmac(req, SECRET)).toEqual({ valid: true });
  });

  it('wrong secret on Worker side returns signature_mismatch', async () => {
    const req = await makeSigned('GET', 'https://example.com/lookup?email_hash=abc', null, SECRET);
    expect(await verifyHmac(req, 'wrong-secret')).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('missing headers returns missing_headers', async () => {
    const req = new Request('https://example.com/lookup?email_hash=abc', { method: 'GET' });
    expect(await verifyHmac(req, SECRET)).toEqual({ valid: false, reason: 'missing_headers' });
  });

  it('timestamp 1h ago returns drift_too_high', async () => {
    const req = await makeSigned('GET', 'https://example.com/lookup?email_hash=abc', null, SECRET, Date.now() - 3600000);
    expect(await verifyHmac(req, SECRET)).toEqual({ valid: false, reason: 'drift_too_high' });
  });

  it('body tampered (signature for body A, request swapped to body B) → signature_mismatch', async () => {
    const orig = await makeSigned('DELETE', 'https://example.com/identify', JSON.stringify({ email_hash: 'aaa' }), SECRET);
    const tampered = new Request('https://example.com/identify', {
      method: 'DELETE',
      body: JSON.stringify({ email_hash: 'bbb' }),
      headers: {
        'X-Signature': orig.headers.get('X-Signature'),
        'X-Timestamp': orig.headers.get('X-Timestamp'),
      },
    });
    expect(await verifyHmac(tampered, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('malformed timestamp returns malformed_timestamp', async () => {
    const req = new Request('https://example.com/lookup?email_hash=abc', {
      method: 'GET',
      headers: { 'X-Signature': 'a'.repeat(64), 'X-Timestamp': 'not-a-number' },
    });
    expect(await verifyHmac(req, SECRET)).toEqual({ valid: false, reason: 'malformed_timestamp' });
  });
});
