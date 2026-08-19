/**
 * IBC "in transit -> arrived" tracker (core).
 *
 * Both IBC legs (Noble USDC -> Penumbra shield-in, Penumbra -> Noble
 * unshield-out) declare success at SOURCE-CHAIN broadcast and stop - the user
 * never learns "did it land?". The rotko-hosted relayer exposes no status API,
 * so we track arrival by DESTINATION-CHAIN POLLING: after broadcast we record a
 * pending transfer, capture the destination balance as a baseline, then poll
 * the destination until the balance rises by the transferred amount (arrived)
 * or the IBC timeout passes (timeout).
 *
 * This module is the PURE, universal core: record type, a storage adapter
 * interface, the monotonic state-machine `transition`, and the `pollOnce` /
 * `track` / `sweepAndResume` drivers. It imports no chrome APIs at module load
 * and no RPC clients, so it runs unchanged in the service worker, the popup,
 * and vitest (inject a fake storage adapter + probe + clock).
 *
 * Durability note: this deliberately DIVERGES from the penumbra-send durable-op
 * pattern (message/penumbra-send.ts, service-worker.ts sweep) in two ways, both
 * required by the nature of an IBC transfer:
 *   1. Storage tier is chrome.storage.LOCAL, not .session. An unshield's ICS20
 *      timeout is 2 days; session storage dies on browser restart (which users
 *      do within 2 days), so a 2-day `expiresAt` would be meaningless there.
 *   2. On service-worker startup we RESUME polling instead of marking the op
 *      failed. A half-done penumbra send cannot resume; a destination poll is
 *      idempotent and fully reconstructible from the persisted record, so the
 *      correct action is to keep polling, not to fail.
 */

/** which leg of the shield/unshield round-trip this record tracks */
export type IbcDirection = 'shield' | 'unshield';

/**
 * broadcast: source tx landed, relay in flight (the default post-broadcast state)
 * arrived:   destination balance rose by the transferred amount (terminal)
 * timeout:   the IBC timeout passed without arrival (terminal); the packet
 *            refunds at source
 */
export type IbcTransferStatus = 'broadcast' | 'arrived' | 'timeout';

/** one pending transfer, persisted across service-worker eviction */
export interface IbcTransfer {
  /** unique id (source tx hash is a natural choice) */
  id: string;
  direction: IbcDirection;
  /** transferred amount in base units (integer string - storage is JSON) */
  amount: string;
  /** display label for the asset (e.g. "USDC"), for the status line only */
  denom: string;
  /** source-chain tx hash */
  srcTxHash: string;
  /** destination balance at broadcast, base units (integer string); the poll
   *  compares against baseline + amount. undefined until first captured. */
  baseline?: string;
  /** ms epoch when the transfer was recorded */
  startedAt: number;
  /** ms epoch of the IBC timeout - past this without arrival => timeout */
  expiresAt: number;
  status: IbcTransferStatus;
  /** ms epoch the transfer was observed to arrive */
  arrivedAt?: number;

  // --- destination-probe hints (read by the probe, opaque to the core) ---
  /** shield: penumbra account index the note lands in */
  destAccount?: number;
  /** shield: asset symbol to match on the penumbra side (voucher denom differs) */
  matchSymbol?: string;
  /** unshield: cosmos chain id the burner/recipient lives on */
  destChainId?: string;
  /** unshield: destination address to poll (burner or override recipient) */
  destAddress?: string;
  /** unshield: cosmos denom to match; when absent the probe sums all balances */
  destDenom?: string;
}

/** a probe returns the current destination balance in base units, or undefined
 *  when the destination could not be reached this pass (treated as "no news"). */
export type DestinationProbe = (t: IbcTransfer) => Promise<bigint | undefined>;

/** minimal persistence surface - chrome.storage.local in production, a Map in tests */
export interface TransferStorage {
  /** all tracked transfers, keyed by id */
  getAll: () => Promise<Record<string, IbcTransfer>>;
  put: (t: IbcTransfer) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** injectable driver dependencies */
export interface TrackerDeps {
  storage: TransferStorage;
  /** clock, injectable for tests */
  now: () => number;
}

/** storage key prefix in chrome.storage.local */
export const IBC_TRANSFER_PREFIX = 'ibcTransfer:';

/** terminal records older than this are pruned on the startup sweep */
export const PRUNE_TERMINAL_MS = 3 * 24 * 60 * 60 * 1000;

export const isTerminalTransferStatus = (s: IbcTransferStatus): boolean =>
  s === 'arrived' || s === 'timeout';

/**
 * Pure state machine. Given a transfer, the latest probe result, and the clock,
 * return the next transfer (a NEW object when something changed, the SAME
 * reference when nothing did - callers rely on identity to skip writes).
 *
 * Only `arrived` is truly terminal. `timeout` is "presumed timed out, not seen
 * to arrive" and stays RECOVERABLE: we detect arrival by polling a destination
 * whose view can lag (the Penumbra block processor scans on its own schedule, a
 * cosmos RPC can be briefly unreachable), so a packet that actually landed can
 * surface after the deadline. If timeout were terminal, that late arrival would
 * be reported forever as "did not arrive" over money the user is holding. So
 * arrival is checked on every poll regardless of status, and wins over a
 * same-tick expiry.
 */
export const transition = (
  t: IbcTransfer,
  probed: bigint | undefined,
  now: number,
): IbcTransfer => {
  if (t.status === 'arrived') {
    return t; // arrival is the only terminal state
  }

  const expired = now > t.expiresAt;

  // baseline not captured yet: capture it from the first successful probe. The
  // destination cannot have received funds in the moments after source
  // broadcast, so this baseline is the pre-arrival level.
  if (t.baseline === undefined) {
    if (probed !== undefined) {
      const withBaseline = { ...t, baseline: probed.toString() };
      // a late first probe may already be past the deadline
      return expired && t.status !== 'timeout'
        ? { ...withBaseline, status: 'timeout' }
        : withBaseline;
    }
    // no baseline and the destination is unreachable: only a deadline can move it
    return expired && t.status !== 'timeout' ? { ...t, status: 'timeout' } : t;
  }

  const target = BigInt(t.baseline) + BigInt(t.amount);
  if (probed !== undefined && probed >= target) {
    return { ...t, status: 'arrived', arrivedAt: now };
  }

  if (expired && t.status !== 'timeout') {
    return { ...t, status: 'timeout' };
  }

  return t;
};

/**
 * Probe one transfer's destination and persist any status change. Idempotent
 * and safe to call from both the UI (fast, while mounted) and the service
 * worker alarm (slow, in the background) - both write through the same storage,
 * and the monotonic `transition` makes the race harmless.
 */
export const pollOnce = async (
  id: string,
  probe: DestinationProbe,
  deps: TrackerDeps,
): Promise<IbcTransfer | undefined> => {
  const all = await deps.storage.getAll();
  const t = all[id];
  // keep probing until arrival - a `timeout` record is still recoverable
  if (!t || t.status === 'arrived') {
    return t;
  }

  let probed: bigint | undefined;
  try {
    probed = await probe(t);
  } catch {
    probed = undefined; // unreachable this pass - retried next poll
  }

  const next = transition(t, probed, deps.now());
  if (next !== t) {
    await deps.storage.put(next);
  }
  return next;
};

/** input to `track` - the record without the fields the tracker fills in */
export type NewTransfer = Omit<IbcTransfer, 'status' | 'startedAt' | 'baseline'>;

/**
 * Record a freshly-broadcast transfer and eagerly capture its destination
 * baseline (one probe). Eager capture matters: a fast relay (~10-30s) can land
 * before a slow alarm-driven poll fires, and a lazily-captured baseline would
 * then read the post-arrival balance and never detect the rise.
 */
export const track = async (
  input: NewTransfer,
  probe: DestinationProbe,
  deps: TrackerDeps,
): Promise<IbcTransfer> => {
  const base: IbcTransfer = { ...input, status: 'broadcast', startedAt: deps.now() };
  let baseline: bigint | undefined;
  try {
    baseline = await probe(base);
  } catch {
    baseline = undefined; // baseline captured lazily on first poll (degraded)
  }
  const t: IbcTransfer = baseline === undefined ? base : { ...base, baseline: baseline.toString() };
  await deps.storage.put(t);
  return t;
};

/**
 * Startup sweep: resume polling every still-pending transfer and prune stale
 * terminal ones. This is the SW-eviction resume path - the counterpart to the
 * penumbra-send startup sweep, but resuming rather than failing.
 */
export const sweepAndResume = async (probe: DestinationProbe, deps: TrackerDeps): Promise<void> => {
  const all = await deps.storage.getAll();
  const now = deps.now();
  for (const t of Object.values(all)) {
    // prune records that have been resolved-or-presumed for long enough
    if (isTerminalTransferStatus(t.status) && now - t.startedAt > PRUNE_TERMINAL_MS) {
      await deps.storage.remove(t.id);
      continue;
    }
    // arrived is final; broadcast AND (recoverable) timeout keep polling
    if (t.status !== 'arrived') {
      await pollOnce(t.id, probe, deps);
    }
  }
};

/** chrome.storage.local-backed adapter. Constructed lazily so importing this
 *  module never touches `chrome` (keeps the core usable under vitest). */
export const chromeLocalStorage = (): TransferStorage => ({
  getAll: async () => {
    const all = await chrome.storage.local.get(null);
    const out: Record<string, IbcTransfer> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(IBC_TRANSFER_PREFIX) && v) {
        out[(v as IbcTransfer).id] = v as IbcTransfer;
      }
    }
    return out;
  },
  put: async (t: IbcTransfer) => {
    await chrome.storage.local.set({ [IBC_TRANSFER_PREFIX + t.id]: t });
  },
  remove: async (id: string) => {
    await chrome.storage.local.remove(IBC_TRANSFER_PREFIX + id);
  },
});

/** default production deps (chrome storage + wall clock) */
export const defaultTrackerDeps = (): TrackerDeps => ({
  storage: chromeLocalStorage(),
  now: () => Date.now(),
});
