import { describe, expect, test } from 'vitest';
import { rewindPurge } from './rewind-purge';

describe('rewindPurge', () => {
  // the regtest reorg this guards: a send at 3236 spent a note from 127 and
  // made change at 3236; block 3236 was replaced by one without the send
  const notes = [
    { nullifier: 'old-spent-by-orphan', height: 127, spent_at_height: 3236, spent_by_txid: 'x' },
    { nullifier: 'change-in-orphan', height: 3236 },
    { nullifier: 'old-spent-long-ago', height: 127, spent_at_height: 233, spent_by_txid: 'y' },
    { nullifier: 'old-unspent', height: 128 },
    { nullifier: 'pending-local-mark', height: 129, spent_by_txid: 'z' },
    { nullifier: 'at-target', height: 3228, spent_at_height: 3228, spent_by_txid: 'w' },
  ];

  test('drops the notes above the target and unmarks the spends seen above it', () => {
    const { drop, unspend } = rewindPurge(notes, 3228);
    expect(drop.map(n => n.nullifier)).toEqual(['change-in-orphan']);
    expect(unspend.map(n => n.nullifier)).toEqual(['old-spent-by-orphan']);
  });

  test('keeps spends at or below the target and local marks without a height', () => {
    const { drop, unspend } = rewindPurge(notes, 3228);
    const touched = new Set([...drop, ...unspend].map(n => n.nullifier));
    for (const kept of ['old-spent-long-ago', 'old-unspent', 'pending-local-mark', 'at-target']) {
      expect(touched.has(kept)).toBe(false);
    }
  });

  test('a rewind above everything takes nothing', () => {
    expect(rewindPurge(notes, 10_000)).toEqual({ drop: [], unspend: [] });
  });
});
