/**
 * Parse a User-Agent string into { ua_os, ua_browser }.
 *
 * Coarse-grained on purpose: marketing-grade attribution, not forensics.
 * Returns "Other" for anything off the well-trodden path. The 90% case for
 * vacuumelevators.com is Chrome/Safari/Firefox on iOS/Android/Windows/macOS.
 *
 * No external deps. Trade-off: misses Yandex, Maxthon, etc. Acceptable.
 */
export function parseUserAgent(ua) {
  if (typeof ua !== 'string' || ua === '') {
    return { ua_os: 'Other', ua_browser: 'Other' };
  }
  return { ua_os: detectOS(ua), ua_browser: detectBrowser(ua) };
}

function detectOS(ua) {
  let m;
  if ((m = ua.match(/iPhone OS (\d+)[._](\d+)/))) return `iOS ${m[1]}.${m[2]}`;
  if ((m = ua.match(/iPad;.*?CPU OS (\d+)[._](\d+)/))) return `iPadOS ${m[1]}.${m[2]}`;
  if ((m = ua.match(/Mac OS X (\d+)[._](\d+)/))) return `macOS ${m[1]}.${m[2]}`;
  if ((m = ua.match(/Android (\d+)(?:\.(\d+))?/))) return `Android ${m[1]}${m[2] ? '.' + m[2] : ''}`;
  if (ua.includes('Windows NT 10.0')) return 'Windows 10/11';
  if ((m = ua.match(/Windows NT (\d+\.\d+)/))) return `Windows NT ${m[1]}`;
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('CrOS')) return 'ChromeOS';
  return 'Other';
}

function detectBrowser(ua) {
  // Order matters: Edge/Opera/Brave UAs all contain "Chrome".
  let m;
  if ((m = ua.match(/Edg\/(\d+)\.(\d+)/))) return `Edge ${m[1]}.${m[2]}`;
  if ((m = ua.match(/OPR\/(\d+)\.(\d+)/))) return `Opera ${m[1]}.${m[2]}`;
  if ((m = ua.match(/Firefox\/(\d+)\.(\d+)/))) return `Firefox ${m[1]}.${m[2]}`;
  if ((m = ua.match(/Chrome\/(\d+)\.(\d+)/))) return `Chrome ${m[1]}.${m[2]}`;
  // Safari: "Version/17.1 ... Safari/605.1.15". Use Version.
  if ((m = ua.match(/Version\/(\d+)\.(\d+).*Safari/))) return `Safari ${m[1]}.${m[2]}`;
  return 'Other';
}
