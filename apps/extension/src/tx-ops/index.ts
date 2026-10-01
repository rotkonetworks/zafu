/**
 * Transaction tracker: one record per transaction zafu makes from its own UI,
 * whatever the network, so the user can always see what is in flight and how
 * it ended.
 *
 * Records live in chrome.storage.session (memory only, gone when the browser
 * closes; never written to disk). They are readable from the service worker
 * and every popup / side-panel document, so a transaction started in a page
 * that then goes away (the side panel reloading for an approval) still ends
 * with a visible outcome.
 *
 * Status is recorded by the code doing the work. For the service-worker
 * Penumbra path that code survives the page; page-driven flows (zcash,
 * injective, cosmos) die with their page, and the sweep then marks their
 * record `unknown` rather than guessing. Deriving progress from chain state
 * (so a route can resume anywhere) is the next step, for multi-hop routes -
 * see rotkonetworks/zafu#50.
 */

export type TxNetwork = 'penumbra' | 'zcash' | 'injective' | 'cosmos';

export type TxOpStatus =
  /** being planned, signed or broadcast */
  | 'pending'
  /** accepted by the network */
  | 'done'
  | 'failed'
  /** no answer for a long time: the page driving it probably went away */
  | 'unknown';

export interface TxOp {
  opId: string;
  network: TxNetwork;
  /** short, human: "send 5 USDC.inj", "vote yes on #13" */
  label: string;
  status: TxOpStatus;
  /** what is happening right now, for pending ops: "approve", "broadcasting" */
  step?: string;
  txId?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  /**
   * Cosmos-SDK REST endpoint to confirm `txId` on. Set when the tx was only
   * accepted into the mempool: any open zafu window then checks the chain for
   * inclusion, so the outcome no longer depends on the page that sent it.
   */
  restUrl?: string;
  /** the completion toast has been shown */
  notified?: boolean;
  /** penumbra send: carried so the sent-message memo can be recorded */
  memo?: string;
  recipient?: string;
}

export const TX_OP_PREFIX = 'txOp:';
export const txOpKey = (opId: string): string => `${TX_OP_PREFIX}${opId}`;

/** ops waiting for chain confirmation (txId + restUrl, still pending) */
export const awaitingConfirmation = (ops: readonly TxOp[]): TxOp[] =>
  ops.filter(op => op.status === 'pending' && op.txId && op.restUrl);

/** a pending op with no update for this long is marked unknown */
export const STALE_PENDING_MS = 10 * 60_000;
/** a finished, already-announced op is dropped after this long */
export const KEEP_FINISHED_MS = 10 * 60_000;

export const isTerminal = (s: TxOpStatus): boolean => s !== 'pending';

export const isTxOp = (v: unknown): v is TxOp =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TxOp).opId === 'string' &&
  typeof (v as TxOp).label === 'string' &&
  typeof (v as TxOp).status === 'string';

/** ops to show, newest first */
export const sortOps = (ops: readonly TxOp[]): TxOp[] =>
  [...ops].sort((a, b) => b.startedAt - a.startedAt);

/**
 * What housekeeping to do at `now`: pending ops silent for too long become
 * `unknown`; finished ops that were announced and are old enough go away.
 */
export const sweep = (ops: readonly TxOp[], now: number): { stale: TxOp[]; remove: string[] } => {
  const stale: TxOp[] = [];
  const remove: string[] = [];
  for (const op of ops) {
    if (op.status === 'pending' && now - op.updatedAt > STALE_PENDING_MS) {
      stale.push({ ...op, status: 'unknown', updatedAt: now });
    } else if (isTerminal(op.status) && op.notified && now - op.updatedAt > KEEP_FINISHED_MS) {
      remove.push(op.opId);
    }
  }
  return { stale, remove };
};

// ---------------------------------------------------------------------------
// storage (chrome.storage.session)

export const readTxOps = async (): Promise<TxOp[]> => {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(TX_OP_PREFIX) && isTxOp(v))
    .map(([, v]) => v as TxOp);
};

/**
 * Every read-modify-write of one op runs under its web lock, which spans the
 * service worker, the popup and the side panel: session storage has no
 * compare-and-set, and two windows reading `notified: false` at once is how one
 * send was announced twice.
 */
const withOp = <T>(opId: string, fn: () => Promise<T>): Promise<T> =>
  navigator.locks.request(txOpKey(opId), fn) as Promise<T>;

const readOp = async (key: string) =>
  (await chrome.storage.session.get(key))[key] as TxOp | undefined;

/** merge `patch` into the op (creating it), stamping updatedAt */
export const writeTxOp = (
  opId: string,
  patch: Partial<TxOp> & Pick<TxOp, 'status'>,
): Promise<void> =>
  withOp(opId, async () => {
    const key = txOpKey(opId);
    const now = Date.now();
    const next: TxOp = {
      network: 'penumbra',
      label: 'transaction',
      startedAt: now,
      ...(await readOp(key)),
      ...patch,
      opId,
      updatedAt: now,
    };
    await chrome.storage.session.set({ [key]: next });
  });

/**
 * Take the right to announce a finished op. Exactly one caller across all open
 * windows gets the op back; everyone else gets undefined.
 */
export const claimTxOp = (opId: string): Promise<TxOp | undefined> =>
  withOp(opId, async () => {
    const key = txOpKey(opId);
    const op = await readOp(key);
    if (!op || !isTerminal(op.status) || op.notified) {
      return undefined;
    }
    await chrome.storage.session.set({ [key]: { ...op, notified: true } });
    return op;
  });

const shownKey = (opId: string) => `txOpShown:${opId}`;

/**
 * The screen that sent the op shows its outcome itself, for as long as it
 * holds this. A lock, not a flag: it ends with the screen, even when the side
 * panel reloads under it, so the toast then speaks instead.
 */
export const holdTxOp = (opId: string): Promise<() => void> =>
  new Promise(held => {
    void navigator.locks.request(shownKey(opId), () => new Promise<void>(release => held(release)));
  });

/** a screen is showing this op's outcome right now */
export const isTxOpShown = (opId: string): Promise<boolean> =>
  navigator.locks.request(shownKey(opId), { ifAvailable: true }, lock => lock === null);

export const removeTxOps = (opIds: readonly string[]): Promise<void> =>
  chrome.storage.session.remove(opIds.map(txOpKey));

/**
 * Track a transaction driven from the current page. `run` gets a `step`
 * callback for progress text and returns the tx id once the network accepted
 * it; a throw records the failure (and is rethrown to the caller). A result
 * without a txId means nothing was broadcast, and the record is removed; one
 * with a `restUrl` stays pending until the chain confirms it.
 */
export const trackTx = async <T extends { txId?: string; restUrl?: string }>(
  meta: { network: TxNetwork; label: string },
  run: (step: (text: string) => void) => Promise<T>,
): Promise<T> => {
  const opId = crypto.randomUUID();
  await writeTxOp(opId, { ...meta, status: 'pending', step: 'starting' });
  try {
    const result = await run(text => void writeTxOp(opId, { status: 'pending', step: text }));
    if (result.txId === undefined) {
      // nothing was broadcast (e.g. handed to a cold signer as a QR): not ours
      // to report as sent
      await removeTxOps([opId]);
    } else if (result.restUrl) {
      // in the mempool, not yet in a block: confirmed from the chain
      await writeTxOp(opId, {
        status: 'pending',
        step: 'confirming',
        txId: result.txId,
        restUrl: result.restUrl,
      });
    } else {
      await writeTxOp(opId, { status: 'done', step: undefined, txId: result.txId });
    }
    return result;
  } catch (err) {
    await writeTxOp(opId, {
      status: 'failed',
      step: undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
