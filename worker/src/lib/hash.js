/**
 * SHA-256 of a UTF-8 string, returned as 64-char lowercase hex.
 * Same output as browser SubtleCrypto and Zoho zoho.encryption.sha256(s, "hex").
 * The handshake between browser, Worker, and Deluge depends on byte-identical output.
 */
export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True if the string is exactly 64 lowercase hex characters. */
export function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}
