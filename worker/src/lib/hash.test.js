import { describe, it, expect } from 'vitest';
import { sha256Hex, isHex64 } from './hash.js';

describe('sha256Hex', () => {
  it('matches the plan §2 constant for empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('returns 64-char lowercase hex for any input', async () => {
    const out = await sha256Hex('test@example.com');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isHex64', () => {
  it.each([
    ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', true],
    ['abc', false],
    ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85G', false], // G outside hex range
    ['E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855', false], // uppercase rejected
  ])('isHex64(%s) === %s', (input, expected) => {
    expect(isHex64(input)).toBe(expected);
  });
});
