import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { advanceWitnesses, frontierHolds, type WitnessUpdate } from './witness-advance';

/**
 * A stand-in for the wasm update: the frontier is a counter, a witness is
 * "w<size>", and a witness marked "bad" makes the whole call throw, as an
 * unreadable witness does in wasm.
 */
const fakeUpdate: WitnessUpdate = (frontier, blocksJson, existingJson, seedJson) => {
  const blocks = JSON.parse(blocksJson) as { actions: unknown[] }[];
  const existing = JSON.parse(existingJson) as { id: string; witness_hex: string }[];
  const seed = JSON.parse(seedJson) as { id: string; position: number }[];
  if (existing.some(e => e.witness_hex === 'bad')) {
    throw new Error('witness deserialize failed');
  }
  const end = Number(frontier) + blocks.reduce((n, b) => n + b.actions.length, 0);
  return JSON.stringify({
    end_frontier_hex: String(end),
    witnesses: [...existing, ...seed].map(w => ({ id: w.id, witness_hex: `w${end}` })),
  });
};

const blocks = JSON.stringify([{ actions: [1, 2] }, { actions: [3] }]);

describe('advanceWitnesses', () => {
  it('advances everything in one call when it can', () => {
    const r = advanceWitnesses(
      fakeUpdate,
      '10',
      blocks,
      [{ id: 'a', witness_hex: 'w10' }],
      [{ id: 'n', position: 11 }],
    );
    expect(r.end_frontier_hex).toBe('13');
    expect(r.witnesses.map(w => w.id).sort()).toEqual(['a', 'n']);
    expect(r.dropped).toEqual([]);
  });

  it('drops only the witness it cannot read; the frontier and the rest go on', () => {
    const r = advanceWitnesses(
      fakeUpdate,
      '10',
      blocks,
      [
        { id: 'a', witness_hex: 'w10' },
        { id: 'bad-one', witness_hex: 'bad' },
        { id: 'b', witness_hex: 'w10' },
      ],
      [{ id: 'n', position: 11 }],
    );
    expect(r.end_frontier_hex).toBe('13');
    expect(r.witnesses.map(w => w.id).sort()).toEqual(['a', 'b', 'n']);
    expect(r.dropped).toEqual(['bad-one']);
  });

  it('still fails when the batch itself is unreadable', () => {
    const broken: WitnessUpdate = () => {
      throw new Error('bad blocks');
    };
    expect(() => advanceWitnesses(broken, '10', blocks, [], [])).toThrow('bad blocks');
    expect(() =>
      advanceWitnesses(broken, '10', blocks, [{ id: 'a', witness_hex: 'w10' }], []),
    ).toThrow('bad blocks');
  });
});

describe('frontierHolds: a close and reopen keeps the witnesses', () => {
  it('keeps a frontier left a few empty blocks behind the synced height', () => {
    // synced to 3_100_250; the last ironwood action was at 3_100_200
    expect(frontierHolds(62_931, 62_931, 3_100_200, 3_100_250)).toBe(true);
  });

  it('refetches only when the tree really differs', () => {
    expect(frontierHolds(62_930, 62_931, 3_100_250, 3_100_250)).toBe(false);
    // a frontier claiming a height past the synced one is not trusted
    expect(frontierHolds(62_931, 62_931, 3_100_300, 3_100_250)).toBe(false);
  });
});

/** source guards on the sync loop, which cannot be imported in a unit test */
const WORKER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'zcash-worker.ts'),
  'utf8',
);

describe('sync loop witness upkeep', () => {
  it('moves each frontier height on over a batch with no actions of its pool', () => {
    expect(WORKER_SRC).toMatch(
      /if \(runningFrontier && actionCount === 0\) \{\s*runningFrontierHeight = endHeight;/,
    );
    expect(WORKER_SRC).toMatch(
      /if \(ironwoodFrontier && ironwoodActionCount === 0\) \{\s*ironwoodFrontierHeight = endHeight;/,
    );
  });

  it('advances only witnesses at the pre-batch size, and never blanks the frontier for one', () => {
    expect(WORKER_SRC).toMatch(/note\.witness_tree_size !== orchardTreeSize\) \{\s*continue;/);
    expect(WORKER_SRC).toMatch(/note\.witness_tree_size !== ironwoodTreeSize\) \{\s*continue;/);
    expect(WORKER_SRC.match(/advanceWitnesses\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('judges a stored frontier by its size at sync start, for both pools', () => {
    expect(WORKER_SRC.match(/frontierHolds\(/g)?.length).toBe(2);
  });

  it('a send reads the live frontier and witnesses in one tick', () => {
    expect(WORKER_SRC).toMatch(/state\.ironwoodLive = \(\) => \(\{/);
    expect(WORKER_SRC).toMatch(/const live =\s*state\?\.stop && !state\.stop\.signal\.aborted/);
  });
});
