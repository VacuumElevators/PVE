import { describe, it, expect } from 'vitest';
import worker from './index.js';
import { sha256Hex } from './lib/hash.js';

const HMAC = 'test-hmac-secret';
const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';

function createMockKV() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => store.delete(k),
    _store: store,
  };
}

function makeEnv() {
  return { PVE_KV: createMockKV(), HMAC_SECRET: HMAC, TURNSTILE_SECRET: TURNSTILE_PASS };
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signedReq(method, urlStr, body, secret) {
  const ts = Date.now();
  const url = new URL(urlStr);
  const bodyStr = body ? JSON.stringify(body) : '';
  const bodyHash = await sha256Hex(bodyStr);
  const payload = [method, url.pathname, url.search.slice(1), bodyHash, String(ts)].join('\n');
  const sig = await hmacHex(secret, payload);
  return new Request(urlStr, {
    method,
    body: bodyStr || undefined,
    headers: {
      'X-Signature': sig,
      'X-Timestamp': String(ts),
      ...(bodyStr ? { 'content-type': 'application/json' } : {}),
    },
  });
}

describe('router basic dispatch', () => {
  it('GET / → 200 (health check)', async () => {
    const req = new Request('https://ss.vacuumelevators.com/', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  it('OPTIONS /identify with allowed origin → 204 + CORS headers', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'OPTIONS',
      headers: { origin: 'https://vacuumelevators.com' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://vacuumelevators.com');
  });

  it('OPTIONS /identify with bad origin → 403', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);
  });

  it('OPTIONS /lookup → 405 (no preflight needed for server-to-server)', async () => {
    const req = new Request('https://ss.vacuumelevators.com/lookup', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it('PUT /identify → 405 with Allow header', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', { method: 'PUT' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('POST');
  });

  it('GET /random → 404', async () => {
    const req = new Request('https://ss.vacuumelevators.com/random', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });
});

describe('end-to-end pipeline (POST → GET → DELETE → GET=404)', () => {
  it('full lifecycle works', async () => {
    const env = makeEnv();
    const email_hash = 'b'.repeat(64);

    // POST /identify
    const post = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'POST',
      headers: {
        origin: 'https://vacuumelevators.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email_hash,
        turnstile_token: 'any',
        first_touch: { source: 'google', medium: 'cpc', campaign: 'spring', ts: 1700000000000 },
        last_touch: { source: 'google', medium: 'cpc', campaign: 'spring', ts: 1700000000000 },
        gclid: 'GCL999',
        ga_raw: 'GA1.1.555.666',
      }),
    });
    let res = await worker.fetch(post, env);
    expect(res.status).toBe(200);
    expect(env.PVE_KV._store.has(email_hash)).toBe(true);

    // GET /lookup signed
    const get = await signedReq('GET', `https://ss.vacuumelevators.com/lookup?email_hash=${email_hash}`, null, HMAC);
    res = await worker.fetch(get, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.first_touch.channel).toBe('Paid Search');
    expect(json.ga_client_id).toBe('555.666');

    // DELETE /identify signed
    const del = await signedReq('DELETE', 'https://ss.vacuumelevators.com/identify', { email_hash }, HMAC);
    res = await worker.fetch(del, env);
    expect(res.status).toBe(200);
    expect(env.PVE_KV._store.has(email_hash)).toBe(false);

    // DELETE again (idempotent)
    const del2 = await signedReq('DELETE', 'https://ss.vacuumelevators.com/identify', { email_hash }, HMAC);
    res = await worker.fetch(del2, env);
    expect(res.status).toBe(200);

    // GET /lookup after DELETE → 404
    const get2 = await signedReq('GET', `https://ss.vacuumelevators.com/lookup?email_hash=${email_hash}`, null, HMAC);
    res = await worker.fetch(get2, env);
    expect(res.status).toBe(404);
  });
});

describe('auth failures', () => {
  it('GET /lookup unsigned → 401', async () => {
    const req = new Request(`https://ss.vacuumelevators.com/lookup?email_hash=${'c'.repeat(64)}`, { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  it('GET /lookup with wrong secret → 401', async () => {
    const req = await signedReq('GET', `https://ss.vacuumelevators.com/lookup?email_hash=${'c'.repeat(64)}`, null, 'wrong-secret');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  it('GET /lookup signed for unknown email_hash → 404', async () => {
    const req = await signedReq('GET', `https://ss.vacuumelevators.com/lookup?email_hash=${'c'.repeat(64)}`, null, HMAC);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });
});
