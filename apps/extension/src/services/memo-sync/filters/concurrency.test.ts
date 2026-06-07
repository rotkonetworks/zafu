/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { withConcurrency } from './concurrency';
import type { FetchContext, MemoFetcher } from '../types';

const ctx = (): FetchContext => ({
  signal: new AbortController().signal,
  tip: 3_000_000,
  activation: 1_687_104,
});

describe('withConcurrency', () => {
  test('sets the concurrency hint on context', async () => {
    let observed: number | undefined;
    const inner: MemoFetcher = async function* (_w, _o, c) {
      observed = c.concurrency;
    };
    const wrapped = withConcurrency(4)(inner);
    await drain(wrapped('w', new Set([100]), ctx()));
    expect(observed).toBe(4);
  });

  test('limit < 1 is clamped to 1', async () => {
    let observed: number | undefined;
    const inner: MemoFetcher = async function* (_w, _o, c) {
      observed = c.concurrency;
    };
    await drain(withConcurrency(0)(inner)('w', new Set([100]), ctx()));
    expect(observed).toBe(1);
  });

  test('non-integer limits floor to integer', async () => {
    let observed: number | undefined;
    const inner: MemoFetcher = async function* (_w, _o, c) {
      observed = c.concurrency;
    };
    await drain(withConcurrency(4.9)(inner)('w', new Set([100]), ctx()));
    expect(observed).toBe(4);
  });

  test('passes the bucket set through unchanged', async () => {
    let observed: Set<number> | undefined;
    const inner: MemoFetcher = async function* (_w, o, _c) {
      observed = new Set(o);
    };
    const owned = new Set([100, 200, 300]);
    await drain(withConcurrency(4)(inner)('w', owned, ctx()));
    expect(observed).toEqual(owned);
  });
});

async function drain<T>(iter: AsyncIterable<T>) {
  for await (const _ of iter) { /* */ }
}
