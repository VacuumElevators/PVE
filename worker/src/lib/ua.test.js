import { describe, it, expect } from 'vitest';
import { parseUserAgent } from './ua.js';

describe('parseUserAgent', () => {
  it.each([
    [
      'iPhone Safari 17',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
      { ua_os: 'iOS 17.1', ua_browser: 'Safari 17.1' },
    ],
    [
      'iPad Safari',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      { ua_os: 'iPadOS 16.6', ua_browser: 'Safari 16.6' },
    ],
    [
      'macOS Chrome',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      { ua_os: 'macOS 10.15', ua_browser: 'Chrome 119.0' },
    ],
    [
      'Windows 11 Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.2151.97',
      { ua_os: 'Windows 10/11', ua_browser: 'Edge 119.0' },
    ],
    [
      'Windows 7 Firefox',
      'Mozilla/5.0 (Windows NT 6.1; rv:109.0) Gecko/20100101 Firefox/120.0',
      { ua_os: 'Windows NT 6.1', ua_browser: 'Firefox 120.0' },
    ],
    [
      'Android Chrome',
      'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
      { ua_os: 'Android 13', ua_browser: 'Chrome 119.0' },
    ],
    [
      'Linux Firefox',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/120.0',
      { ua_os: 'Linux', ua_browser: 'Firefox 120.0' },
    ],
    [
      'Opera macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0',
      { ua_os: 'macOS 10.15', ua_browser: 'Opera 104.0' },
    ],
    ['empty string', '', { ua_os: 'Other', ua_browser: 'Other' }],
    ['null', null, { ua_os: 'Other', ua_browser: 'Other' }],
    ['weird bot', 'BotName/2.0 (compatible; SomeBot)', { ua_os: 'Other', ua_browser: 'Other' }],
  ])('%s', (_label, ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });
});
