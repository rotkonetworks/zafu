// FlyClient chain checks on the real shipped blob, with no network. The fixture
// is a live default-parameter proof from zcash.rotko.net (zidecar 0.10.0, no
// burial, so roots at tip - 1), tip 3,509,023; `now` is pinned to its tip time
// so the 90-minute freshness window holds whenever the test runs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  checkChain,
  FLY_REPLAY_SLACK,
  flyMinHeight,
  poolsOffProof,
  type FlyDeps,
  type ProvenChain,
} from './fly-verify';

const TIP = 3_509_023;
const TIP_TIME_MS = 1_791_342_114_000;
const PROOF = new Uint8Array(
  gunzipSync(readFileSync(resolve(__dirname, 'fixtures/flyclient-proof-3509023.pb.gz'))),
);

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  verify_flyclient: FlyDeps['verify'];
}

let wasm: Wasm;
beforeAll(async () => {
  wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
  wasm.initSync({
    module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
  });
});

describe('flyclient chain check on the real wasm', () => {
  const check = (over: Partial<FlyDeps> = {}) =>
    checkChain({
      mainnet: true,
      fetchProof: () => Promise.resolve({ proof: PROOF }),
      verify: (...a) => wasm.verify_flyclient(...a),
      lastTip: 0,
      now: () => TIP_TIME_MS + 60_000,
      ...over,
    });

  test('a live proof checks out, with roots one block under the tip', async () => {
    const r = await check();
    expect(r.status).toBe('checked');
    const chain = (r as { chain: ProvenChain }).chain;
    expect(chain.tip_height).toBe(TIP);
    expect(chain.roots_height).toBe(TIP - 1);
    expect(chain.orchard_root).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.ironwood_root).toMatch(/^[0-9a-f]{64}$/);
  });

  test('one flipped header byte fails', async () => {
    const bad = PROOF.slice();
    // inside the first epoch's commit header (its previous-block hash)
    bad[40] = bad[40]! ^ 0x01;
    expect((await check({ fetchProof: () => Promise.resolve({ proof: bad }) })).status).toBe(
      'failed',
    );
  });

  test('a tip older than 90 minutes fails', async () => {
    const r = await check({ now: () => TIP_TIME_MS + 91 * 60_000 });
    expect(r).toMatchObject({ status: 'failed' });
    expect((r as { detail: string }).detail).toMatch(/stale/);
  });

  test('a tip below one already verified fails (no rollback)', async () => {
    expect((await check({ lastTip: TIP + 1 + FLY_REPLAY_SLACK })).status).toBe('failed');
  });

  test('a node a few blocks behind the last verified tip is not a replay', async () => {
    expect((await check({ lastTip: TIP + 3 })).status).toBe('checked');
    expect(flyMinHeight(TIP + 3)).toBeLessThan(TIP);
  });

  test('testnet has no checkpoint: unverified, never failed', async () => {
    expect(await check({ mainnet: false })).toEqual({ status: 'unverified', reason: 'testnet' });
  });

  test('a lightwalletd has no proof to give: unverified, not paused', async () => {
    expect(await check({ fetchProof: undefined })).toEqual({
      status: 'unverified',
      reason: 'lightwalletd',
    });
  });

  test('a zidecar without --flyclient (or unreachable) is unverified, not paused', async () => {
    const r = await check({
      fetchProof: () => Promise.reject(new Error('gRPC GetFlyClientProof: unimplemented')),
    });
    expect(r).toMatchObject({ status: 'unverified', reason: 'unreachable' });
  });
});

describe('a stale tip: this computer or the node', () => {
  const AFTER = TIP_TIME_MS + 60_000;
  const check = (localMs: number, serverTime?: number) =>
    checkChain({
      mainnet: true,
      fetchProof: () => Promise.resolve({ proof: PROOF, serverTime }),
      verify: (...a) => wasm.verify_flyclient(...a),
      lastTip: 0,
      now: () => localMs,
    });

  test('a clock hours ahead of the node is this computer, not the node: unverified', async () => {
    expect(await check(TIP_TIME_MS + 3 * 3_600_000, AFTER)).toMatchObject({
      status: 'unverified',
      reason: 'clock',
    });
  });

  test('a clock hours behind the node (tip "in the future") is this computer too', async () => {
    expect(await check(TIP_TIME_MS - 3 * 3_600_000, AFTER)).toMatchObject({
      status: 'unverified',
      reason: 'clock',
    });
  });

  test('a stale tip against a clock that agrees with the node is the node: failed', async () => {
    const late = TIP_TIME_MS + 3 * 3_600_000;
    expect((await check(late, late + 30_000)).status).toBe('failed');
  });

  test('a stale tip with no node clock to compare stays failed', async () => {
    expect((await check(TIP_TIME_MS + 3 * 3_600_000)).status).toBe('failed');
  });

  test('a node clock that does not save the proof either is the node: failed', async () => {
    // both clocks far past the tip: the node's own clock says its tip is stale
    expect((await check(TIP_TIME_MS + 3 * 3_600_000, TIP_TIME_MS + 6 * 3_600_000)).status).toBe(
      'failed',
    );
  });
});

describe('a node that proved its chain before', () => {
  const unimplemented = () =>
    Promise.reject(
      Object.assign(new Error('gRPC GetFlyClientProof: FlyClient proofs are not enabled'), {
        grpcStatus: 12,
      }),
    );
  const check = (over: Partial<FlyDeps>) =>
    checkChain({ mainnet: true, verify: () => '', lastTip: 0, ...over });

  test('answering unimplemented now is a downgrade: failed', async () => {
    expect((await check({ provedBefore: true, fetchProof: unimplemented })).status).toBe('failed');
  });

  test('dropping the rpc (a proxy 404) is a downgrade too', async () => {
    const gone = () =>
      Promise.reject(
        Object.assign(new Error('gRPC GetFlyClientProof: HTTP 404'), { httpStatus: 404 }),
      );
    expect((await check({ provedBefore: true, fetchProof: gone })).status).toBe('failed');
  });

  test('now reporting itself a lightwalletd is a downgrade too', async () => {
    expect((await check({ provedBefore: true, fetchProof: undefined })).status).toBe('failed');
  });

  test('a network blip is not a downgrade: unverified', async () => {
    const blip = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await check({ provedBefore: true, fetchProof: blip })).toMatchObject({
      status: 'unverified',
      reason: 'unreachable',
    });
  });

  test('a node that never proved itself stays not verified', async () => {
    expect(await check({ fetchProof: unimplemented })).toMatchObject({
      status: 'unverified',
      reason: 'unreachable',
    });
  });
});

describe('proven roots against the trees', () => {
  const chain: ProvenChain = {
    tip_height: 101,
    tip_hash: '00',
    total_work: '1',
    orchard_root: 'aa',
    ironwood_root: 'bb',
    roots_height: 100,
  };
  const trees = (roots: Record<string, string | undefined>) => (pool: string, height: number) =>
    height === 100 ? roots[pool] : undefined;

  test('trees on the proven chain agree', () => {
    expect(poolsOffProof(chain, trees({ orchard: 'aa', ironwood: 'bb' }))).toEqual([]);
  });

  test('a tree off the proven chain takes the reorg path', () => {
    expect(poolsOffProof(chain, trees({ orchard: 'aa', ironwood: 'cc' }))).toEqual(['ironwood']);
    expect(poolsOffProof(chain, trees({ orchard: 'dd', ironwood: 'cc' }))).toEqual([
      'orchard',
      'ironwood',
    ]);
  });

  test('a tree with no root kept at that height has nothing to compare yet', () => {
    expect(poolsOffProof(chain, trees({}))).toEqual([]);
  });
});
