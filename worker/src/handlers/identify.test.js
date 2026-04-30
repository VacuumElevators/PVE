import { describe, it, expect } from 'vitest';
import { mergeAttribution, handleIdentify } from './identify.js';

const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';
const TURNSTILE_FAIL = '2x0000000000000000000000000000000AA';

function createMockKV(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => store.delete(k),
    _store: store,
  };
}

function fakeRequest(cf = {}, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) Version/17.1 Mobile/15E148 Safari/604.1') {
  return { cf, headers: new Headers({ 'user-agent': ua }) };
}

describe('mergeAttribution (pure)', () => {
  it('new entry: empty KV, full body → fully populated', () => {
    const result = mergeAttribution({
      existing: null,
      first_touch: { source: 'facebook', medium: 'cpc', campaign: 'summer', ts: 1700000000000 },
      last_touch: { source: 'facebook', medium: 'cpc', campaign: 'summer', ts: 1700000000000 },
      gclid: 'CjwKEABC',
      ga_raw: 'GA1.1.1380815224.1775231481',
      request: fakeRequest({ country: 'US', city: 'Tampa' }),
      ip: '73.139.0.18',
      now: 1700000000000,
    });
    expect(result.first_touch.channel).toBe('Paid Social');
    expect(result.last_touch.channel).toBe('Paid Social');
    expect(result.ga_client_id).toBe('1380815224.1775231481');
    expect(result.geo.country).toBe('US');
    expect(result.geo.ip_address).toBe('73.139.0.18');
    expect(result.device.ua_os).toBe('iOS 17.1');
    expect(result.touches).toHaveLength(1);
    expect(result.created_at).toBe(result.updated_at);
  });

  it('first_touch is write-once: returning visitor preserves original fc', () => {
    const result = mergeAttribution({
      existing: {
        first_touch: { source: 'google', medium: 'cpc', channel: 'Paid Search', ts: 1699000000000 },
        last_touch: { source: 'google', medium: 'cpc', channel: 'Paid Search', ts: 1699000000000 },
        touches: [{ source: 'google', medium: 'cpc', campaign: '', ts: 1699000000000 }],
        created_at: 1699000000000,
      },
      first_touch: { source: 'facebook', medium: 'cpc', campaign: 'new', ts: 1700000000000 },
      last_touch: { source: 'facebook', medium: 'cpc', campaign: 'new', ts: 1700000000000 },
      gclid: '', ga_raw: '',
      request: fakeRequest(),
      ip: '1.2.3.4',
      now: 1700000000000,
    });
    expect(result.first_touch.source).toBe('google'); // preserved
    expect(result.last_touch.source).toBe('facebook'); // overwritten
    expect(result.touches).toHaveLength(2);
    expect(result.created_at).toBe(1699000000000); // preserved
  });

  it('empty body does not clobber existing last_touch or append empty touch', () => {
    const result = mergeAttribution({
      existing: {
        first_touch: { source: 'google', medium: 'cpc', channel: 'Paid Search', ts: 1699000000000 },
        last_touch: { source: 'google', medium: 'cpc', channel: 'Paid Search', ts: 1699000000000 },
        touches: [{ source: 'google', medium: 'cpc', campaign: '', ts: 1699000000000 }],
        created_at: 1699000000000,
      },
      first_touch: { source: '', medium: '', campaign: '' },
      last_touch: { source: '', medium: '', campaign: '' },
      gclid: '', ga_raw: '',
      request: fakeRequest(),
      ip: '1.2.3.4',
      now: 1700000000000,
    });
    expect(result.last_touch.source).toBe('google'); // not clobbered
    expect(result.touches).toHaveLength(1); // not appended
  });

  it('touches FIFO cap 50: 50 existing + 1 new keeps last 50, drops oldest', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      source: 'src' + i, medium: 'cpc', campaign: '', ts: i,
    }));
    const result = mergeAttribution({
      existing: { touches: fifty },
      first_touch: null,
      last_touch: { source: 'newest', medium: 'cpc', campaign: '', ts: 1700000000000 },
      gclid: '', ga_raw: '',
      request: fakeRequest(),
      ip: '1.2.3.4',
      now: 1700000000000,
    });
    expect(result.touches).toHaveLength(50);
    expect(result.touches[0].source).toBe('src1'); // src0 dropped
    expect(result.touches[result.touches.length - 1].source).toBe('newest');
  });

  it('direct visit (no UTMs ever): first_touch null, geo still captured', () => {
    const result = mergeAttribution({
      existing: null,
      first_touch: { source: '', medium: '', campaign: '' },
      last_touch: { source: '', medium: '', campaign: '' },
      gclid: '', ga_raw: '',
      request: fakeRequest({ country: 'US', city: 'Miami' }),
      ip: '1.2.3.4',
      now: 1700000000000,
    });
    expect(result.first_touch).toBeNull();
    expect(result.geo.country).toBe('US');
  });
});

describe('handleIdentify (integration)', () => {
  it('bad origin → 403', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'POST',
      headers: { origin: 'https://evil.com', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handleIdentify(req, { PVE_KV: createMockKV(), TURNSTILE_SECRET: TURNSTILE_PASS });
    expect(res.status).toBe(403);
  });

  it('valid origin, bad email_hash → 400', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'POST',
      headers: { origin: 'https://vacuumelevators.com', 'content-type': 'application/json' },
      body: JSON.stringify({ email_hash: 'nothex', turnstile_token: 't' }),
    });
    const res = await handleIdentify(req, { PVE_KV: createMockKV(), TURNSTILE_SECRET: TURNSTILE_PASS });
    expect(res.status).toBe(400);
  });

  it('valid full POST → 200, KV written with derived fields', async () => {
    const kv = createMockKV();
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'POST',
      headers: {
        origin: 'https://vacuumelevators.com',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        email_hash: 'a'.repeat(64),
        turnstile_token: 'any-token',
        first_touch: { source: 'google', medium: 'cpc', campaign: 'summer', ts: 1700000000000 },
        last_touch: { source: 'google', medium: 'cpc', campaign: 'summer', ts: 1700000000000 },
        gclid: 'GCL123',
        ga_raw: 'GA1.1.111.222',
      }),
    });
    const res = await handleIdentify(req, { PVE_KV: kv, TURNSTILE_SECRET: TURNSTILE_PASS });
    expect(res.status).toBe(200);

    const stored = JSON.parse(kv._store.get('a'.repeat(64)));
    expect(stored.first_touch.channel).toBe('Paid Search');
    expect(stored.ga_client_id).toBe('111.222');
    expect(stored.device.ua_os).toBe('macOS 10.15');
  });

  it('Turnstile fail → 403', async () => {
    const req = new Request('https://ss.vacuumelevators.com/identify', {
      method: 'POST',
      headers: { origin: 'https://vacuumelevators.com', 'content-type': 'application/json' },
      body: JSON.stringify({ email_hash: 'a'.repeat(64), turnstile_token: 't' }),
    });
    const res = await handleIdentify(req, { PVE_KV: createMockKV(), TURNSTILE_SECRET: TURNSTILE_FAIL });
    expect(res.status).toBe(403);
  });
});
