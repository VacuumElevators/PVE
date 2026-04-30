import { describe, it, expect } from 'vitest';
import { deriveChannel } from './channel.js';

describe('deriveChannel', () => {
  it.each([
    // Lead 131454 anchor (empirical):
    ['facebook', 'cpc', 'Paid Social'],
    ['google', 'cpc', 'Paid Search'],
    ['bing', 'ppc', 'Paid Search'],
    ['yahoo', 'paid_search', 'Paid Search'],
    ['linkedin', 'paid', 'Paid Social'],
    ['instagram', 'cpc', 'Paid Social'],
    ['tiktok', 'cpc', 'Paid Social'],
    ['x', 'cpc', 'Paid Social'],
    // paid_social medium overrides source:
    ['anything', 'paid_social', 'Paid Social'],
    ['anything', 'paidsocial', 'Paid Social'],
    // Direct buckets:
    ['newsletter', 'email', 'Email'],
    ['google', 'organic', 'Organic Search'],
    ['somesite.com', 'referral', 'Referral'],
    ['', 'display', 'Display'],
    // Direct (empty / none):
    ['', '', 'Direct'],
    ['google', '(none)', 'Direct'],
    // Other (unknown):
    ['affiliate', 'affiliate', 'Other'],
    // Normalization:
    ['FACEBOOK', 'CPC', 'Paid Social'],
    ['  facebook  ', '  cpc  ', 'Paid Social'],
    // Defensive (non-string):
    [null, null, 'Direct'],
    [undefined, undefined, 'Direct'],
    [42, 'cpc', 'Paid Search'],
  ])('deriveChannel(%j, %j) === %j', (source, medium, expected) => {
    expect(deriveChannel(source, medium)).toBe(expected);
  });
});
