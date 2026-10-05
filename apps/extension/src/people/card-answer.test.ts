/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest';
import { deriveRelationshipKeys } from '../state/identity';
import { openAnswer, sealAnswer, SEALED_BODY } from './card-answer';
import { pairSeal, sealWords, SEAL_WORDS } from './cards';
import { sealGrid } from '../routes/popup/contacts/seal-compare';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('a sealed answer', () => {
  const a = deriveRelationshipKeys(PHRASE, 0, 0);
  const card = { key: a.pubkey, pairKa: a.kaPublicKey };
  const answer = new Uint8Array(200).map((_, i) => i);

  test('opens with the card maker pair secret only', async () => {
    const body = await sealAnswer(card, answer);
    expect(body.startsWith(SEALED_BODY)).toBe(true);
    expect(await openAnswer(card, a.kaSeed, body)).toEqual(answer);
    const other = deriveRelationshipKeys(PHRASE, 0, 1);
    expect(await openAnswer(card, other.kaSeed, body)).toBeNull();
    // bound to the card it answers
    expect(await openAnswer({ ...card, key: other.pubkey }, a.kaSeed, body)).toBeNull();
  });

  test('a changed byte, a short box or another version does not open', async () => {
    const body = await sealAnswer(card, answer);
    const flip = body.slice(0, -3) + (body.at(-3) === 'A' ? 'B' : 'A') + body.slice(-2);
    expect(await openAnswer(card, a.kaSeed, flip)).toBeNull();
    expect(await openAnswer(card, a.kaSeed, SEALED_BODY + 'AQ')).toBeNull();
    expect(
      await openAnswer(card, a.kaSeed, 'zp2:card:' + body.slice(SEALED_BODY.length)),
    ).toBeNull();
  });

  test('two seals of the same answer differ', async () => {
    expect(await sealAnswer(card, answer)).not.toBe(await sealAnswer(card, answer));
  });
});

describe('the seal two people compare', () => {
  const seal = pairSeal('aa'.repeat(32), 'bb'.repeat(32));
  test('six words, the same from either side, 66 bits', () => {
    const words = sealWords(seal);
    expect(words).toHaveLength(SEAL_WORDS);
    expect(words.every(w => /^[a-z]+$/.test(w))).toBe(true);
    expect(sealWords(pairSeal('bb'.repeat(32), 'aa'.repeat(32)))).toEqual(words);
    // every one of the first 66 bits moves a word
    for (let bit = 0; bit < 66; bit++) {
      const n = BigInt(`0x${seal.slice(0, 18)}`) ^ (1n << BigInt(71 - bit));
      const flipped = n.toString(16).padStart(18, '0') + seal.slice(18);
      expect(sealWords(flipped)).not.toEqual(words);
    }
  });
  test('the picture draws 64 bits, none mirrored', () => {
    const grid = sealGrid(seal);
    expect(grid).toHaveLength(64);
    for (let bit = 0; bit < 64; bit++) {
      const n = BigInt(`0x${seal.slice(0, 16)}`) ^ (1n << BigInt(63 - bit));
      const flipped = n.toString(16).padStart(16, '0') + seal.slice(16);
      const g = sealGrid(flipped);
      expect(g.filter((x, i) => x !== grid[i])).toHaveLength(1);
    }
  });
});
