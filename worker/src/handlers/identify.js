import { isHex64 } from '../lib/hash.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { deriveChannel } from '../lib/channel.js';
import { parseUserAgent } from '../lib/ua.js';

const TOUCHES_CAP = 50;
const TTL_SECONDS = 365 * 24 * 60 * 60;
const STRING_FIELD_MAX = 32000;

const ALLOWED_ORIGINS = new Set([
  'https://vacuumelevators.com',
  'https://www.vacuumelevators.com',
]);

/**
 * POST /identify
 *
 * Auth: Turnstile invisible token (body) + origin-locked CORS allowlist.
 * Rate limit (60/min/IP per plan §2) deferred to v2: current volume is
 * ~60 form-fills/day; Turnstile is the primary defense. Add via
 * Cloudflare Rate Limiting Rules at zone level if Logpush shows abuse.
 *
 * Body shape:
 *   {
 *     turnstile_token, email_hash,
 *     first_touch: { source, medium, campaign, content, term, referrer, landing_page, ts },
 *     last_touch:  { same },
 *     gclid, ga_raw
 *   }
 */
export async function handleIdentify(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) {
    log('identify_403_origin', { origin });
    return new Response('Forbidden', { status: 403 });
  }
  const headers = corsHeaders(origin);

  let body;
  try {
    body = await request.json();
  } catch {
    log('identify_400_body');
    return new Response('Bad Request', { status: 400, headers });
  }

  const { turnstile_token, email_hash, first_touch, last_touch, gclid, ga_raw } = body || {};

  if (!isHex64(email_hash)) {
    log('identify_400_email_hash');
    return new Response('Invalid email_hash', { status: 400, headers });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const turnstile = await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET, ip);
  if (!turnstile.success) {
    log('identify_403_turnstile', { errorCodes: turnstile.errorCodes });
    return new Response('Forbidden', { status: 403, headers });
  }

  let existing = null;
  try {
    const raw = await env.PVE_KV.get(email_hash);
    existing = raw ? JSON.parse(raw) : null;
  } catch (err) {
    log('kv_read_fail', { error: String(err) });
    // Continue; treat as new entry. Better to write than fail.
  }

  const now = Date.now();
  const value = mergeAttribution({ existing, first_touch, last_touch, gclid, ga_raw, request, ip, now });

  try {
    await env.PVE_KV.put(email_hash, JSON.stringify(value), { expirationTtl: TTL_SECONDS });
  } catch (err) {
    log('kv_write_fail', { error: String(err) });
    return new Response('Internal Error', { status: 500, headers });
  }

  log('identify_200');
  return new Response('OK', { status: 200, headers });
}

/**
 * Pure merge. Existing KV value + incoming body fields → new KV value.
 * Pulled out so it can be tested without spinning up a full request.
 */
export function mergeAttribution({ existing, first_touch, last_touch, gclid, ga_raw, request, ip, now }) {
  // first_touch: write-once. Only set if no existing AND body has real attribution.
  let mergedFirst = existing?.first_touch || null;
  if (!mergedFirst && hasAttribution(first_touch)) {
    mergedFirst = withChannel(first_touch);
  }

  // last_touch: overwrite when body has real attribution. Empty body = keep existing.
  let mergedLast = existing?.last_touch || null;
  if (hasAttribution(last_touch)) {
    mergedLast = withChannel(last_touch);
  }

  // touches: append only when body has real attribution. FIFO cap 50.
  let touches = Array.isArray(existing?.touches) ? [...existing.touches] : [];
  if (hasAttribution(last_touch)) {
    touches.push({
      source: last_touch.source || '',
      medium: last_touch.medium || '',
      campaign: last_touch.campaign || '',
      ts: last_touch.ts || now,
    });
    if (touches.length > TOUCHES_CAP) touches = touches.slice(-TOUCHES_CAP);
  }

  // Cloudflare geo. Server-side enrichment, only Worker has access.
  const geo = {
    country: request.cf?.country || existing?.geo?.country || '',
    city: request.cf?.city || existing?.geo?.city || '',
    ip_address: ip || existing?.geo?.ip_address || '',
  };

  // UA parse. If new UA reads as Other/Other (missing or weird), prefer existing.
  const ua = request.headers.get('user-agent') || '';
  const parsed = parseUserAgent(ua);
  const device = (parsed.ua_os === 'Other' && parsed.ua_browser === 'Other' && existing?.device)
    ? existing.device
    : parsed;

  // GA Client ID: split _ga cookie. Format: GA1.1.<client_id>.<timestamp> → "<client_id>.<timestamp>"
  const ga_client_id = ga_raw
    ? ga_raw.split('.').slice(-2).join('.')
    : existing?.ga_client_id || '';

  return {
    first_touch: mergedFirst ? truncateStrings(mergedFirst) : null,
    last_touch: mergedLast ? truncateStrings(mergedLast) : null,
    touches: touches.map(truncateStrings),
    device,
    geo: truncateStrings(geo),
    ga_client_id,
    gclid: gclid || existing?.gclid || '',
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

function hasAttribution(touch) {
  if (!touch || typeof touch !== 'object') return false;
  return Boolean(touch.source || touch.medium || touch.campaign);
}

function withChannel(touch) {
  return {
    source: touch.source || '',
    medium: touch.medium || '',
    campaign: touch.campaign || '',
    content: touch.content || '',
    term: touch.term || '',
    referrer: touch.referrer || '',
    landing_page: touch.landing_page || '',
    channel: deriveChannel(touch.source, touch.medium),
    ts: touch.ts || Date.now(),
  };
}

function truncateStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (typeof v === 'string' && v.length > STRING_FIELD_MAX) ? v.slice(0, STRING_FIELD_MAX) : v;
  }
  return out;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}
