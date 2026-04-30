const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/**
 * Validate a Turnstile invisible token via Cloudflare's siteverify endpoint.
 *
 * Tokens are single-use; Cloudflare invalidates after first verification, so replay
 * across requests is not possible.
 *
 * Fail-closed: network error, timeout, or non-200 from siteverify all return success: false.
 * Volume is ~60 form-fills/day; the cost of a false reject from a Cloudflare blip is acceptable.
 */
export async function verifyTurnstile(token, secret, ip) {
  if (!token || typeof token !== 'string') {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    if (!res.ok) return { success: false, errorCodes: [`siteverify-${res.status}`] };

    const json = await res.json();
    return {
      success: Boolean(json.success),
      errorCodes: json['error-codes'] || [],
    };
  } catch (err) {
    return { success: false, errorCodes: [err.name === 'AbortError' ? 'siteverify-timeout' : 'siteverify-network'] };
  } finally {
    clearTimeout(timer);
  }
}
