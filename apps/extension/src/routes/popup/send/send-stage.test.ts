import { describe, expect, it } from 'vitest';
import { sendStage, stageExplain, stageMeta } from './send-stage';

const hot = [
  { step: 'loading wallet state' },
  { step: 'selecting notes', detail: '7 notes available' },
  { step: 'notes selected', detail: '3 ironwood notes, fee=15000' },
  { step: 'building merkle witnesses', detail: 'anchor=1 (tip=2)' },
  { step: 'witnesses built', detail: '1.2s' },
  { step: 'proving (halo2)', detail: '12s elapsed' },
  { step: 'ironwood tx signed', detail: '9000 bytes' },
  { step: 'broadcasting transaction' },
  { step: 'complete', detail: 'txid=ab' },
];

describe('sendStage', () => {
  it('follows the hot build through all four stages', () => {
    const at = (n: number) => sendStage(hot.slice(0, n));
    expect([1, 3, 4, 6, 7, 8, 9].map(at)).toEqual([0, 0, 1, 2, 2, 3, 4]);
  });

  it('reads the pczt labels as proving', () => {
    expect(sendStage([{ step: 'building & proving PCZT (halo2)' }])).toBe(2);
    expect(sendStage([{ step: 'PCZT QR ready' }])).toBe(2);
    expect(sendStage([{ step: 'unsigned transaction proved' }])).toBe(2);
  });

  it('never moves backwards on an unknown label, and honours the floor', () => {
    expect(sendStage([{ step: 'proving (halo2)' }, { step: 'something new' }])).toBe(2);
    expect(sendStage([], 3)).toBe(3);
    expect(sendStage([{ step: 'selecting notes' }], 3)).toBe(3);
  });
});

describe('stageMeta', () => {
  it('counts the selected notes and the live prove time', () => {
    expect(stageMeta(hot.slice(0, 3), 0, 0)).toBe('3 notes');
    expect(stageMeta(hot.slice(0, 6), 2, 2)).toBe('12s elapsed');
    expect(stageMeta(hot.slice(0, 6), 0, 2)).toBe('done');
  });

  it('names the witness rebuild', () => {
    const slow = [{ step: 'witness corrupt - rebuilding', detail: 'this takes ~3 min' }];
    expect(stageMeta(slow, 1, 1)).toBe('rebuilding · about 3 min');
    expect(stageExplain(slow, 1, true)).toMatch(/about 3 min/);
  });

  it('says nothing it does not know', () => {
    expect(stageMeta([{ step: 'notes selected' }], 0, 0)).toBe('');
  });
});
