/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { afterPass } from './read';

describe('afterPass', () => {
  test('a memo found is not marked read: a window closed before storing it reads it again', () => {
    const { scanned, settled } = afterPass({
      scanned: new Set(['old']),
      read: ['memo-less', 'with-memo'],
      found: [{ txId: 'with-memo' }],
      unmined: 0,
    });
    expect(scanned).toEqual(new Set(['old', 'memo-less']));
    expect(settled).toBe(false);
  });

  test('a pass that found nothing is settled, unless a spend waits for its block', () => {
    const pass = { scanned: new Set<string>(), read: ['a'], found: [] };
    expect(afterPass({ ...pass, unmined: 0 })).toEqual({ scanned: new Set(['a']), settled: true });
    expect(afterPass({ ...pass, unmined: 1 }).settled).toBe(false);
  });
});
