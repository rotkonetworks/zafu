/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { withDedup } from './dedup';
import type {
  MempoolFetchContext,
  MempoolFetcher,
  MempoolSnapshot,
} from '../types';

const ctx = (signal: AbortSignal): MempoolFetchContext => ({ signal });

const entry = (hashByte: number): MempoolSnapshot['entries'][number] => ({
  hash: new Uint8Array([hashByte, 0, 0, 0]),
  actions: [],
});

function fromList(snaps: MempoolSnapshot[]): MempoolFetcher {
  return async function* () {
    for (const s of snaps) yield s;
  };
}

describe('withDedup', () => {
  test('passes through the first snapshot always', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [entry(1), entry(2)], observedAtMs: 1 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    expect(got).toHaveLength(1);
  });

  test('drops identical consecutive snapshots', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [entry(1), entry(2)], observedAtMs: 1 },
      { entries: [entry(1), entry(2)], observedAtMs: 2 },
      { entries: [entry(1), entry(2)], observedAtMs: 3 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    expect(got).toHaveLength(1);
    expect(got[0]?.observedAtMs).toBe(1);
  });

  test('emits snapshot when an entry is added', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [entry(1)], observedAtMs: 1 },
      { entries: [entry(1), entry(2)], observedAtMs: 2 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    expect(got).toHaveLength(2);
  });

  test('emits snapshot when an entry is removed (tx mined)', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [entry(1), entry(2)], observedAtMs: 1 },
      { entries: [entry(2)], observedAtMs: 2 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    expect(got).toHaveLength(2);
  });

  test('order of entries does not matter (hash set equality)', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [entry(1), entry(2)], observedAtMs: 1 },
      { entries: [entry(2), entry(1)], observedAtMs: 2 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    expect(got).toHaveLength(1);
  });

  test('first empty snapshot yields, subsequent empty ones do not', async () => {
    const ctrl = new AbortController();
    const wrapped = withDedup()(fromList([
      { entries: [], observedAtMs: 1 },
      { entries: [], observedAtMs: 2 },
      { entries: [entry(7)], observedAtMs: 3 },
      { entries: [], observedAtMs: 4 },
    ]));
    const got: MempoolSnapshot[] = [];
    for await (const s of wrapped('w', ctx(ctrl.signal))) got.push(s);
    // emit empty, drop empty, emit added, emit removed-to-empty → 3 yields
    expect(got.map(s => s.observedAtMs)).toEqual([1, 3, 4]);
  });
});
