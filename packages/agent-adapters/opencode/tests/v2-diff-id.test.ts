import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveDiffId } from '../src/v2/diff-id.js';

const base = {
  sessionId: 'ses_1',
  fromMessageId: 'msg_from',
  toMessageId: 'msg_to',
  file: 'src/a.ts',
  patch: '@@ -1 +1 @@\n-a\n+b\n',
};

describe('deriveDiffId', () => {
  it('matches the canonical sha256 formula exactly', () => {
    const canonical = JSON.stringify([
      'diff:v1',
      base.sessionId,
      base.fromMessageId,
      base.toMessageId,
      base.file,
      base.patch,
    ]);
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(deriveDiffId(base)).toBe(expected);
  });

  it('is deterministic and sensitive to every field', () => {
    expect(deriveDiffId(base)).toBe(deriveDiffId({ ...base }));
    const variants = [
      { ...base, sessionId: 'ses_2' },
      { ...base, fromMessageId: 'msg_other' },
      { ...base, toMessageId: 'msg_other' },
      { ...base, file: 'src/b.ts' },
      { ...base, patch: '@@ -1 +1 @@\n-a\n+c\n' },
    ];
    const ids = new Set(variants.map((input) => deriveDiffId(input)));
    expect(ids.size).toBe(5);
    expect(ids.has(deriveDiffId(base))).toBe(false);
  });

  it('keeps field boundaries unambiguous (no concatenation collisions)', () => {
    const a = deriveDiffId({ ...base, fromMessageId: 'ab', toMessageId: 'c' });
    const b = deriveDiffId({ ...base, fromMessageId: 'a', toMessageId: 'bc' });
    expect(a).not.toBe(b);
  });

  it('allows empty patch (binary/no-hunk diffs) but not undefined', () => {
    const withEmpty = deriveDiffId({ ...base, patch: '' });
    expect(withEmpty).toHaveLength(64);
    expect(withEmpty).not.toBe(deriveDiffId(base));
    expect(() => deriveDiffId({ ...base, patch: undefined as unknown as string })).toThrow();
    expect(() => deriveDiffId({ ...base, patch: null as unknown as string })).toThrow();
  });

  it('rejects unresolved or empty from/to and other fields', () => {
    expect(() => deriveDiffId({ ...base, fromMessageId: '' })).toThrow();
    expect(() => deriveDiffId({ ...base, toMessageId: '' })).toThrow();
    expect(() => deriveDiffId({ ...base, sessionId: '' })).toThrow();
    expect(() => deriveDiffId({ ...base, file: '' })).toThrow();
    expect(() => deriveDiffId({ ...base, patch: undefined as unknown as string })).toThrow();
    expect(() => deriveDiffId({ ...base, fromMessageId: undefined as unknown as string })).toThrow();
    expect(() => deriveDiffId({ ...base, toMessageId: null as unknown as string })).toThrow();
  });
});
