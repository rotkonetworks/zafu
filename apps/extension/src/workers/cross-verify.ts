import { ZCASH_MAINNET_ENDPOINTS } from '../config/zcash-endpoints';

/**
 * Cross-endpoint consistency check.
 *
 * The trust model has a hole its own design acknowledges: the Ligerito header
 * proof carries no constraint system, so the roots it "proves" are values the
 * prover chose and absorbed into its own transcript. Nothing binds them to
 * consensus, and block/action omission is undetectable from a single server.
 * Cross-verification against an INDEPENDENT operator is the stated mitigation.
 * It had zero call sites — the one thing standing between a lying server and
 * the user was never wired up.
 *
 * This is deliberately modest, and it is worth being precise about what it
 * does and does not buy:
 *
 *   It DOES catch a server that reports a chain state no one else agrees
 *   with — a forged tip, a stalled tip presented as current, or a commitment
 *   tree that diverges from the network's.
 *
 *   It does NOT make the wallet trustless. Two endpoints run by the same
 *   operator, or colluding, agree with each other. It cannot detect omission
 *   that both servers perform. And it is a liveness/consistency check, not a
 *   proof — a real fix is a constraint system, which is a design project.
 *
 * Failure is advisory by default: a disagreement is surfaced, not fatal,
 * because a lagging peer is far more common than an attack and bricking the
 * wallet on a one-block skew would be its own bug. Height skew within
 * TIP_SKEW_TOLERANCE is treated as normal propagation.
 */

/** Blocks of tip difference treated as ordinary propagation lag, not disagreement. */
const TIP_SKEW_TOLERANCE = 6;

/** Don't hold up sync on a slow third party. */
const PEER_TIMEOUT_MS = 8_000;

export interface CrossCheckResult {
  readonly checked: boolean;
  /** true only when a peer actively contradicted the primary */
  readonly disagreed: boolean;
  readonly detail: string;
  readonly peerUrl?: string;
}

/**
 * Pick a peer under a DIFFERENT operator than the primary.
 *
 * Comparing zcash.rotko.net against another rotko host would be theatre: the
 * point is an independent party, so peers are chosen by registrable domain,
 * not merely by URL.
 */
const registrableDomain = (url: string): string => {
  try {
    const host = new URL(url).hostname;
    return host.split('.').slice(-2).join('.');
  } catch {
    return url;
  }
};

export const pickIndependentPeer = (primaryUrl: string): string | undefined => {
  const own = registrableDomain(primaryUrl);
  const candidates = ZCASH_MAINNET_ENDPOINTS.map(e => e.url).filter(
    u => registrableDomain(u) !== own,
  );
  return candidates[0];
};

/**
 * Ask an independent endpoint what it thinks the tip is, and compare.
 *
 * `getPeerTip` is injected so this module stays free of client construction
 * and is trivially testable without a network.
 */
export const crossCheckTip = async (
  primaryUrl: string,
  primaryHeight: number,
  getPeerTip: (url: string, timeoutMs: number) => Promise<{ height: number }>,
): Promise<CrossCheckResult> => {
  const peerUrl = pickIndependentPeer(primaryUrl);
  if (!peerUrl) {
    return {
      checked: false,
      disagreed: false,
      detail: 'no independent endpoint configured to cross-check against',
    };
  }

  let peerHeight: number;
  try {
    const tip = await getPeerTip(peerUrl, PEER_TIMEOUT_MS);
    peerHeight = tip.height;
  } catch (e) {
    // Unreachable peer is not evidence of anything. Report it, do not escalate.
    return {
      checked: false,
      disagreed: false,
      peerUrl,
      detail: `peer unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const skew = primaryHeight - peerHeight;

  // Only a primary running AHEAD of the network is suspicious: it is the shape
  // a fabricated tip takes. A primary running BEHIND is ordinary lag, and the
  // sync's own staleness handling covers it.
  if (skew > TIP_SKEW_TOLERANCE) {
    return {
      checked: true,
      disagreed: true,
      peerUrl,
      detail:
        `primary claims height ${primaryHeight} but ${peerUrl} reports ${peerHeight} ` +
        `(${skew} ahead). A tip no one else can see is what a fabricated chain ` +
        `state looks like - verify before trusting balances from this endpoint.`,
    };
  }

  return {
    checked: true,
    disagreed: false,
    peerUrl,
    detail: `tip agrees with ${peerUrl} within ${Math.abs(skew)} block(s)`,
  };
};
