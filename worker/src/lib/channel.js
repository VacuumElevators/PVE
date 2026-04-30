/**
 * Map (source, medium) to a channel bucket.
 * Source-aware to match GA Connector's behavior (Lead 131454 reference:
 * source=facebook + medium=cpc → Paid Social, not Paid Search).
 *
 * Evaluation order matters: paid-social mediums short-circuit before
 * paid-search inference. Direct (empty/none) wins over everything else.
 */

const SOCIAL_SOURCES = new Set([
  'facebook',
  'fb',
  'instagram',
  'ig',
  'linkedin',
  'twitter',
  'x',
  'x.com',
  'tiktok',
  'snapchat',
  'pinterest',
  'reddit',
]);

const PAID_MEDIUMS = new Set(['cpc', 'paid', 'paid_search', 'paidsearch', 'ppc']);
const PAID_SOCIAL_MEDIUMS = new Set(['paid_social', 'paidsocial', 'social_paid', 'social-paid']);

const DIRECT_MEDIUM_MAP = {
  email: 'Email',
  organic: 'Organic Search',
  referral: 'Referral',
  display: 'Display',
};

export function deriveChannel(source, medium) {
  const s = normalize(source);
  const m = normalize(medium);

  if (m === '' || m === '(none)') return 'Direct';

  if (PAID_SOCIAL_MEDIUMS.has(m)) return 'Paid Social';

  if (PAID_MEDIUMS.has(m)) {
    return SOCIAL_SOURCES.has(s) ? 'Paid Social' : 'Paid Search';
  }

  return DIRECT_MEDIUM_MAP[m] || 'Other';
}

function normalize(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}
