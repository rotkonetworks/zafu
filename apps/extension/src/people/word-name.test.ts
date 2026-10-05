import { describe, expect, test } from 'vitest';
import { deriveRoomKeys } from '../state/identity';
import { cleanName, distinct, memberName, wordName } from './word-name';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('word names', () => {
  test('two words, the same for the same key', () => {
    const k = deriveRoomKeys(SEED, 0, 'aa'.repeat(16)).pubkey;
    expect(wordName(k)).toMatch(/^[a-z]+ [a-z]+$/);
    expect(wordName(k)).toBe(wordName(k));
  });

  test('one person, unrelated names in different groups', () => {
    const names = new Set(
      Array.from({ length: 12 }, (_, i) =>
        wordName(deriveRoomKeys(SEED, 0, i.toString(16).padStart(32, '0')).pubkey),
      ),
    );
    expect(names.size).toBeGreaterThan(9);
  });

  test('a chosen name is one clean line of at most 24', () => {
    expect(cleanName(' bea\u0007‮ ')).toBe('bea');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
    expect(cleanName(undefined)).toBe('');
  });

  test('saved beats chosen beats the word name; hex is never a name', () => {
    const k = 'ab'.repeat(32);
    expect(memberName(k)).toBe(wordName(k));
    expect(memberName(k, 'c5d7776f')).toBe(wordName(k));
    expect(memberName(k, 'bea')).toBe('bea');
    expect(memberName(k, 'bea', 'beatrice')).toBe('beatrice');
  });

  test('two members who read the same are told apart', () => {
    const shown = distinct([
      { key: 'aaaa11', name: 'bea' },
      { key: 'bbbb22', name: 'bea' },
      { key: 'cccc33', name: 'ken' },
    ]);
    expect([...shown.values()]).toEqual(['bea · aaaa', 'bea · bbbb', 'ken']);
  });
});
