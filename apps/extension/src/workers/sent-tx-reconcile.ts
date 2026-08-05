/**
 * Reconciling what WE sent with what the chain says.
 *
 * Two notions of the same transaction exist, and they arrive in either order:
 *
 *   - the local record, written the instant we broadcast. It knows the amount,
 *     the fee, the recipient and the memo — none of which the chain can give
 *     back, because an outgoing note is encrypted to the recipient.
 *   - the chain-derived entry, produced by scanning. It knows the height, and
 *     only the height is proof that anything actually happened.
 *
 * Reconciliation is deciding, for each txid, which parts of which to believe.
 * The rule throughout: the chain is the sole authority on *whether and when*
 * a transaction confirmed; the local record is the sole authority on *what it
 * was*. Neither is allowed to speak for the other.
 *
 * This module is deliberately pure — no IndexedDB, no worker globals — so the
 * rules below can be tested directly rather than inferred from behaviour.
 */

export type SentPool = 'orchard' | 'ironwood' | 'transparent';

export type SentKind = 'send' | 'shield' | 'migrate';

/** What we write down at broadcast. Persisted in the `sent` object store. */
export interface SentTxRecord {
  walletId: string;
  txid: string;
  /** zatoshi, as a decimal string (bigint is not structured-cloneable to IDB reliably) */
  amount: string;
  fee: string;
  recipient: string;
  pool: SentPool;
  kind: SentKind;
  memo?: string;
  /** wall-clock ms at broadcast; the chain supplies the height later */
  sentAt: number;
  /**
   * nExpiryHeight, read out of the transaction we actually broadcast. Zero (or
   * absent, for records written before we captured it) means "no expiry" — the
   * Zcash consensus rule for expiry height 0 — and such a record is never
   * treated as failed, however old it gets.
   */
  expiryHeight?: number;
  /**
   * The height at which we first saw this transaction on chain. Written back
   * once, by reconciliation, so a later rescan (which empties the note store)
   * does not make a confirmed payment look pending again.
   */
  confirmedHeight?: number;
}

/**
 * pending  — broadcast, not yet seen in a block. We do not know if it will
 *            confirm, and we say exactly that.
 * confirmed— seen on chain at a real height.
 * failed   — the wallet has scanned past the transaction's own expiry height
 *            without seeing it. It can no longer be mined.
 */
export type TxStatus = 'pending' | 'confirmed' | 'failed';

/** One row of history, as handed to the UI. */
export interface HistoryTx {
  id: string;
  /** real block height, or 0 when there is not one yet. Never a sentinel. */
  height: number;
  type: string;
  /**
   * zatoshi as a decimal string. For an outgoing transaction this is what
   * actually LEFT the wallet — recipient amount plus fee — never the gross
   * value of the notes chosen as inputs.
   *
   * The distinction is the whole ballgame in a shielded wallet. Spending a
   * 355,000 zat note to send 50,000 returns 290,000 to yourself as change; the
   * wallet is 65,000 poorer, not 355,000. Reporting the input total told a user
   * they had spent five times what they spent, and next to a balance that could
   * not render, it read as "everything is gone".
   */
  amount: string;
  asset: string;
  status: TxStatus;
  /**
   * True when `amount` is the gross input total and the change that came back
   * has not been found yet — so the real figure is at most this. Set only when
   * the wallet has not scanned the spend's own block; once it has, a missing
   * change note really does mean there was none.
   */
  amountUpperBound?: boolean;
  /** below: present only for transactions we sent ourselves */
  kind?: SentKind;
  /** zatoshi the recipient received, excluding fee */
  recipientAmount?: string;
  recipient?: string;
  memo?: string;
  fee?: string;
  sentAt?: number;
  expiryHeight?: number;
}

/**
 * How far past a transaction's expiry the wallet must have scanned before the
 * record is deleted rather than merely shown as failed.
 *
 * The delay is the whole point. `scannedHeight > expiryHeight` already proves
 * the transaction cannot be mined, but deleting on that instant would erase
 * the only explanation the user will ever get for why their balance came back.
 * ~100 blocks (roughly two hours) leaves the failure on screen long enough to
 * be read, and puts the deletion far outside any plausible reorg of the blocks
 * around expiry.
 */
export const EXPIRY_GRACE_BLOCKS = 100;

export interface ReconcileInput {
  /** entries derived from scanning: notes, spends and transparent history */
  chainTxs: Omit<HistoryTx, 'status'>[];
  /** everything in the `sent` store for this wallet */
  sent: SentTxRecord[];
  /** how far this wallet has actually scanned. 0 = unknown; nothing expires. */
  scannedHeight: number;
}

export interface ReconcileResult {
  /** merged history, ordered for display */
  txs: HistoryTx[];
  /** records whose confirmedHeight must be persisted (newly seen on chain) */
  confirm: { txid: string; height: number }[];
  /** txids of records that can no longer confirm and are past the grace window */
  prune: string[];
}

/**
 * A chain-derived entry only proves confirmation if it carries a real height.
 *
 * This is not pedantry. `markNotesSpentLocally` records the inputs we spent at
 * broadcast time, so the scan-derived list contains an entry for our own txid
 * *immediately* — with height 0 (never scanned) and with the amount computed
 * as the full input total rather than what the user sent. Treating that as
 * "the chain knows about it" is what made a fresh send appear as a wrong,
 * heightless row and suppressed the accurate local record behind it.
 */
const isConfirmedHeight = (h: number | undefined): h is number =>
  typeof h === 'number' && h > 0 && Number.isFinite(h);

/**
 * Parse a zatoshi decimal string. Money must never become NaN silently, and a
 * malformed record is not a reason to render a wrong number — treat it as zero
 * and let the fields that are intact still tell the user something.
 */
const toZat = (s: string | undefined): bigint => {
  if (!s) {
    return 0n;
  }
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
};

/**
 * Merge local send records into chain-derived history.
 *
 * Guarantees:
 *  - exactly one row per txid;
 *  - a row is `confirmed` only on the strength of a real block height;
 *  - a confirmed row takes its height from the chain and its recipient, memo,
 *    fee and amount from the local record;
 *  - nothing is ever proposed for deletion while it could still confirm.
 */
export function reconcileSentTxs({
  chainTxs,
  sent,
  scannedHeight,
}: ReconcileInput): ReconcileResult {
  const chainById = new Map<string, Omit<HistoryTx, 'status'>>();
  for (const tx of chainTxs) {
    const existing = chainById.get(tx.id);
    // keep whichever copy carries a real height
    if (!existing || (!isConfirmedHeight(existing.height) && isConfirmedHeight(tx.height))) {
      chainById.set(tx.id, tx);
    }
  }

  const txs: HistoryTx[] = [];
  const confirm: { txid: string; height: number }[] = [];
  const prune: string[] = [];
  const claimed = new Set<string>();

  // The store's key is [walletId, txid], so duplicates should be impossible —
  // but "should be impossible" is not a reason to emit two rows for one
  // payment if it ever happens. Newest broadcast wins.
  const byTxid = new Map<string, SentTxRecord>();
  for (const rec of sent) {
    const prev = byTxid.get(rec.txid);
    if (!prev || rec.sentAt >= prev.sentAt) {
      byTxid.set(rec.txid, rec);
    }
  }

  for (const rec of byTxid.values()) {
    claimed.add(rec.txid);
    const chain = chainById.get(rec.txid);

    // the chain's word first, then what we already wrote down about it
    const seenHeight = isConfirmedHeight(chain?.height)
      ? chain.height
      : isConfirmedHeight(rec.confirmedHeight)
        ? rec.confirmedHeight
        : undefined;

    const type = rec.kind === 'shield' ? 'shield' : 'send';
    const base = {
      id: rec.txid,
      type,
      // What left the wallet: what the recipient got, plus the fee. Change is
      // not part of it — it never left. We know both numbers exactly because
      // we wrote them down at broadcast, which is why the local record beats
      // the scan-derived figure outright rather than merely filling gaps.
      amount: (toZat(rec.amount) + toZat(rec.fee)).toString(),
      recipientAmount: rec.amount,
      asset: chain?.asset ?? 'ZEC',
      kind: rec.kind,
      recipient: rec.recipient,
      memo: rec.memo,
      fee: rec.fee,
      sentAt: rec.sentAt,
      expiryHeight: rec.expiryHeight,
    };

    if (seenHeight !== undefined) {
      txs.push({ ...base, height: seenHeight, status: 'confirmed' });
      if (rec.confirmedHeight !== seenHeight) {
        confirm.push({ txid: rec.txid, height: seenHeight });
      }
      continue;
    }

    // Not on chain. Can it still get there? Only its own expiry height can
    // answer that, and only once we have scanned past it. An expiry of 0 (or
    // an old record with none captured) means the transaction never expires,
    // so it stays pending indefinitely rather than being declared dead.
    const expiry = rec.expiryHeight ?? 0;
    const canStillConfirm = expiry <= 0 || scannedHeight <= 0 || scannedHeight <= expiry;

    if (canStillConfirm) {
      txs.push({ ...base, height: 0, status: 'pending' });
      continue;
    }

    txs.push({ ...base, height: 0, status: 'failed' });
    if (scannedHeight > expiry + EXPIRY_GRACE_BLOCKS) {
      prune.push(rec.txid);
    }
  }

  for (const tx of chainById.values()) {
    if (claimed.has(tx.id)) {
      continue;
    }
    txs.push({ ...tx, status: 'confirmed' });
  }

  return { txs: sortHistory(txs), confirm, prune };
}

/**
 * Display order: things without a settled place in chain order come first,
 * because they are the things the user is waiting on or needs told about.
 * Pending, then failed, each newest-first by broadcast time; then everything
 * confirmed, by height.
 */
export function sortHistory(txs: HistoryTx[]): HistoryTx[] {
  const rank = (s: TxStatus): number => (s === 'pending' ? 0 : s === 'failed' ? 1 : 2);
  return [...txs].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) {
      return ra - rb;
    }
    if (ra === 2) {
      return b.height - a.height;
    }
    return (b.sentAt ?? 0) - (a.sentAt ?? 0);
  });
}

/**
 * nExpiryHeight of a v5/v6 (NU5+) Zcash transaction.
 *
 * We take it from the bytes we are about to broadcast rather than recomputing
 * it from a tip height, so the record cannot disagree with the transaction the
 * network actually saw — that agreement is the whole basis for later declaring
 * the send failed.
 *
 * Header layout (all little-endian u32): header | versionGroupId |
 * consensusBranchId | lockTime | expiryHeight. Returns undefined for anything
 * that is not recognisably v5+, rather than guessing at a v4 layout where the
 * field sits behind variable-length input and output vectors.
 */
export function parseExpiryHeight(txHex: string): number | undefined {
  if (typeof txHex !== 'string' || txHex.length < 40) {
    return undefined;
  }
  const u32le = (byteOffset: number): number => {
    let v = 0;
    for (let i = 3; i >= 0; i--) {
      const byte = parseInt(txHex.slice((byteOffset + i) * 2, (byteOffset + i) * 2 + 2), 16);
      if (Number.isNaN(byte)) {
        return NaN;
      }
      v = v * 256 + byte;
    }
    return v;
  };
  const header = u32le(0);
  if (Number.isNaN(header)) {
    return undefined;
  }
  // fOverwintered must be set, and the version must be one we know the layout of
  if ((header & 0x80000000) === 0) {
    return undefined;
  }
  const version = header & 0x7fffffff;
  if (version < 5) {
    return undefined;
  }
  const expiry = u32le(16);
  return Number.isNaN(expiry) ? undefined : expiry;
}
