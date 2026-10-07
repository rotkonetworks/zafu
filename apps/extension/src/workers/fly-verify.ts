/**
 * FlyClient chain check for one zcash node.
 *
 * A zidecar running with --flyclient proves its chain against zcash's proof of
 * work (from NU6.3 activation, above a compiled work and difficulty floor) and
 * commits to the note tree roots under its tip. zafu checks that proof in wasm
 * and compares its own trees with the proven roots, so one node can no longer
 * hand it a made-up chain. A node that cannot prove (lightwalletd, a zidecar
 * without --flyclient, testnet, an unreachable rpc) is not a failure: zafu
 * keeps working and says the chain is not verified.
 */

import type { TreePool } from './note-trees';

/** what `verify_flyclient` returns (roots in the hex `tree_root_hex` gives) */
export interface ProvenChain {
  tip_height: number;
  tip_hash: string;
  total_work: string;
  orchard_root: string;
  ironwood_root: string;
  /** the height whose note tree roots the proof carries (tip - burial depth) */
  roots_height: number;
}

export type ChainCheck =
  | { status: 'checked'; chain: ProvenChain; ms: number }
  | { status: 'unverified'; reason: 'testnet' | 'lightwalletd' | 'unreachable'; detail?: string }
  | { status: 'failed'; detail: string };

/**
 * Note tree roots under this many blocks: a one-block reorg cannot move them.
 * zidecar 0.10.0 ignores it and proves the roots under the tip (depth 1).
 */
export const FLY_BURIAL = 17;

/** a default-parameter proof is ~1.5 MB; anything far past that is not one */
export const FLY_PROOF_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The stored tip is a floor (no rollback), less this many blocks (~30 min), so
 * moving to an honest node a few blocks behind is not read as a replay. The
 * proof's own 90-minute freshness bounds a real replay anyway.
 */
export const FLY_REPLAY_SLACK = 24;

export const flyMinHeight = (lastTip: number): number => Math.max(0, lastTip - FLY_REPLAY_SLACK);

export interface FlyDeps {
  mainnet: boolean;
  /** the node's GetFlyClientProof; undefined on a standard lightwalletd */
  fetchProof?: () => Promise<Uint8Array>;
  verify: (proof: Uint8Array, nowSecs: bigint, minHeight: number, mainnet: boolean) => string;
  /** the highest tip this wallet has verified on this network */
  lastTip: number;
  now?: () => number;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Fetch and check the node's proof. Only a proof that arrived and did not
 * check out is `failed`; not getting one is `unverified`.
 */
export const checkChain = async ({
  mainnet,
  fetchProof,
  verify,
  lastTip,
  now = Date.now,
}: FlyDeps): Promise<ChainCheck> => {
  if (!mainnet) {
    return { status: 'unverified', reason: 'testnet' };
  }
  if (!fetchProof) {
    return { status: 'unverified', reason: 'lightwalletd' };
  }
  let proof: Uint8Array;
  try {
    proof = await fetchProof();
  } catch (e) {
    return { status: 'unverified', reason: 'unreachable', detail: text(e) };
  }
  const start = now();
  try {
    const chain = JSON.parse(
      verify(proof, BigInt(Math.floor(start / 1000)), flyMinHeight(lastTip), true),
    ) as ProvenChain;
    return { status: 'checked', chain, ms: now() - start };
  } catch (e) {
    return { status: 'failed', detail: text(e) };
  }
};

const PROVEN_ROOT: Record<TreePool, (c: ProvenChain) => string> = {
  orchard: c => c.orchard_root,
  ironwood: c => c.ironwood_root,
};

/**
 * The pools whose own tree root at the proven height is not the proven one:
 * the blocks zafu read are not the proven chain's (a reorg, or a node serving
 * blocks its own proof does not back). A pool without a root retained at that
 * height has nothing to compare yet.
 */
export const poolsOffProof = (
  chain: ProvenChain,
  rootAt: (pool: TreePool, height: number) => string | undefined,
): TreePool[] =>
  (Object.keys(PROVEN_ROOT) as TreePool[]).filter(pool => {
    const own = rootAt(pool, chain.roots_height);
    return own !== undefined && own !== PROVEN_ROOT[pool](chain);
  });
