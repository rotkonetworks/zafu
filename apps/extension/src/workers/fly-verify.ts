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
  | {
      status: 'unverified';
      /** clock: the proof holds by the node's clock, so this computer's is off */
      reason: 'testnet' | 'lightwalletd' | 'unreachable' | 'clock';
      detail?: string;
    }
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

/** a clock this far from the node's own is the odd one out, not the node */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** what a node answered: the proof, and its own clock (the http Date) when it gave one */
export interface FlyProof {
  proof: Uint8Array;
  serverTime?: number;
}

export interface FlyDeps {
  mainnet: boolean;
  /** the node's GetFlyClientProof; undefined on a standard lightwalletd */
  fetchProof?: () => Promise<FlyProof>;
  verify: (proof: Uint8Array, nowSecs: bigint, minHeight: number, mainnet: boolean) => string;
  /** the highest tip this wallet has verified on this network */
  lastTip: number;
  /** this node proved its chain before: a refusal now is a downgrade, not "no proof" */
  provedBefore?: boolean;
  now?: () => number;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** the node said it has no such rpc (grpc UNIMPLEMENTED, or a proxy's 404) */
const refused = (e: unknown) => {
  const { grpcStatus, httpStatus } = (e ?? {}) as { grpcStatus?: number; httpStatus?: number };
  return grpcStatus === 12 || httpStatus === 404;
};

/** the freshness window, as opposed to the rollback floor or a bad proof */
const FRESHNESS = /older than 90 minutes|hours ahead/;

const DOWNGRADE = 'this node proved its chain before and no longer offers a proof';

/**
 * Fetch and check the node's proof. A proof that arrived and did not check
 * out is `failed`, and so is a node that proved itself before and now refuses.
 * Not getting a proof otherwise is `unverified`, as is a proof that holds by
 * the node's own clock when this computer's is the odd one out.
 */
export const checkChain = async ({
  mainnet,
  fetchProof,
  verify,
  lastTip,
  provedBefore = false,
  now = Date.now,
}: FlyDeps): Promise<ChainCheck> => {
  if (!mainnet) {
    return { status: 'unverified', reason: 'testnet' };
  }
  if (!fetchProof) {
    return provedBefore
      ? { status: 'failed', detail: DOWNGRADE }
      : { status: 'unverified', reason: 'lightwalletd' };
  }
  let answer: FlyProof;
  try {
    answer = await fetchProof();
  } catch (e) {
    return provedBefore && refused(e)
      ? { status: 'failed', detail: `${DOWNGRADE}: ${text(e)}` }
      : { status: 'unverified', reason: 'unreachable', detail: text(e) };
  }
  const minHeight = flyMinHeight(lastTip);
  const at = (ms: number) => () =>
    JSON.parse(verify(answer.proof, BigInt(Math.floor(ms / 1000)), minHeight, true)) as ProvenChain;
  const start = now();
  try {
    const chain = at(start)();
    return { status: 'checked', chain, ms: now() - start };
  } catch (e) {
    const { serverTime } = answer;
    const clockOff =
      FRESHNESS.test(text(e)) &&
      serverTime !== undefined &&
      Math.abs(serverTime - start) > CLOCK_SKEW_MS &&
      holds(at(serverTime));
    return clockOff
      ? { status: 'unverified', reason: 'clock', detail: text(e) }
      : { status: 'failed', detail: text(e) };
  }
};

const holds = (f: () => unknown) => {
  try {
    f();
    return true;
  } catch {
    return false;
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
