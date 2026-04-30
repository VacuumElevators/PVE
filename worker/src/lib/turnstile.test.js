import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from './turnstile.js';

// Cloudflare's documented test secrets:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const PASS = '1x0000000000000000000000000000000AA';
const FAIL = '2x0000000000000000000000000000000AA';

describe('verifyTurnstile', () => {
  it('empty token returns missing-input-response (no network call)', async () => {
    expect(await verifyTurnstile('', PASS, '1.2.3.4')).toEqual({
      success: false,
      errorCodes: ['missing-input-response'],
    });
  });

  it('always-pass test secret returns success', async () => {
    const res = await verifyTurnstile('any-token', PASS, '1.2.3.4');
    expect(res.success).toBe(true);
  });

  it('always-fail test secret returns invalid-input-response', async () => {
    const res = await verifyTurnstile('any-token', FAIL, '1.2.3.4');
    expect(res.success).toBe(false);
    expect(res.errorCodes).toContain('invalid-input-response');
  });

  it('fake secret returns siteverify-400', async () => {
    const res = await verifyTurnstile('any-token', 'fake-secret-xxx', '1.2.3.4');
    expect(res.success).toBe(false);
    expect(res.errorCodes).toContain('siteverify-400');
  });

  it('omitted IP still works with always-pass', async () => {
    const res = await verifyTurnstile('any-token', PASS);
    expect(res.success).toBe(true);
  });
});
