/**
 * One Ledger-signed transaction, end to end, with vizor's retry semantics:
 *
 *   sign (device, once) -> extract tx -> CHECKPOINT -> broadcast -> acknowledge
 *
 * - The device is asked once per operation. Everything after the approval
 *   (extraction, the checkpoint write, the broadcast) retries from the bytes
 *   already signed: a failed checkpoint or broadcast never re-signs.
 * - A broadcast the node REJECTED is terminal: the checkpoint is discarded and
 *   the operation cannot be retried (the same bytes would be refused again).
 * - A broadcast with NO verdict (transport failure) is `uncertain`: the node
 *   may have it. The checkpoint moves to `broadcast_uncertain` and belongs to
 *   recovery (./recovery.ts), which resolves it by looking the txid up. It is
 *   never re-signed and never followed by another round.
 * - A changed account or network stops the operation before its next step.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import { LedgerError, type LedgerSigningPhase } from './contract';
import {
  withOperationClaim,
  type LedgerNetwork,
  type LedgerOperationState,
  type LedgerOperationStore,
} from './operations-store';
import { ledgerZcashSigner, type LedgerSignDeps, type LedgerTransparentPath } from './signer';

export type LedgerFlowFailure =
  /** the active account or network changed; the flow stopped */
  | 'context_changed'
  /** signed, but the checkpoint could not be written; retry writes it again */
  | 'checkpoint_failed'
  /** the node refused the transaction; terminal */
  | 'broadcast_rejected'
  /** an earlier Ledger transaction of this wallet is not settled yet */
  | 'unresolved_operation'
  /** another zafu window is broadcasting this operation right now */
  | 'busy'
  /** the operation is already terminal (rejected) or owned by recovery */
  | 'not_retryable'
  /** shielding: the eligible inputs could not be read (NOT the same as none) */
  | 'funds_unreadable';

export class LedgerFlowError extends Error {
  constructor(
    readonly code: LedgerFlowFailure,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LedgerFlowError';
  }
}

/** The account + chain an operation was started for. */
export interface LedgerOperationContext {
  readonly walletId: string;
  readonly network: LedgerNetwork;
}

/** Worker seams (production: ./zafu-deps.ts). */
export interface LedgerTxDeps {
  /** signed PCZT -> broadcast-ready tx and its (display-order) txid; no network */
  extractTx(signedPcztHex: string): Promise<{ txHex: string; txid: string }>;
  /** submit; throws `broadcast failed (...)` on a node rejection, anything else
   *  on a transport failure */
  broadcast(walletId: string, txHex: string, coldSendId?: string): Promise<{ txid: string }>;
}

/** What the transaction tracker is told (production: tx-ops writeTxOp). */
export interface LedgerTrackUpdate {
  readonly status: 'pending' | 'done' | 'failed' | 'unknown';
  readonly step?: string;
  readonly txId?: string;
  readonly error?: string;
}

export interface LedgerOperationDeps extends LedgerSignDeps, LedgerTxDeps {
  readonly store: LedgerOperationStore;
  /** true while `ctx` is still the active account on the active network */
  isCurrent(ctx: LedgerOperationContext): boolean;
  newOperationId?: () => string;
  track?: (operationId: string, label: string, update: LedgerTrackUpdate) => void;
}

export type LedgerOperationStep = 'signing' | 'saving' | 'broadcasting';

export interface LedgerRunOptions {
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: LedgerSigningPhase) => void;
  readonly onStep?: (step: LedgerOperationStep) => void;
}

export type LedgerOperationOutcome =
  | { readonly status: 'broadcast'; readonly operationId: string; readonly txid: string }
  | {
      readonly status: 'uncertain';
      readonly operationId: string;
      readonly txid: string;
      readonly message: string;
    };

export interface LedgerOperationInput {
  readonly kind: 'send' | 'shield';
  /** unsigned, un-redacted PCZT from the worker build */
  readonly pcztHex: string;
  readonly coldSendId?: string;
  readonly label: string;
  /** derivation tails of the transparent inputs (shielding), for stamping */
  readonly transparentPaths?: readonly LedgerTransparentPath[];
}

// ---------------------------------------------------------------------------
// broadcast classification (shared with recovery)

export type BroadcastVerdict = 'accepted' | 'rejected' | 'uncertain';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The worker throws `broadcast failed (code): message` when the node answered
 * with an error; any other throw means we never got an answer. A node that
 * says it already has the tx (a retried or recovered broadcast) accepted it.
 */
export function classifyBroadcastError(
  e: unknown,
): Exclude<BroadcastVerdict, 'accepted'> | 'already_known' {
  const msg = errorText(e).toLowerCase();
  if (!msg.includes('broadcast failed (')) {
    return 'uncertain';
  }
  if (
    /txn-already-in-mempool|txn-already-known|already in (the )?mempool|already in (the )?block ?chain|already known|already exists in (the )?mempool/.test(
      msg,
    )
  ) {
    return 'already_known';
  }
  return 'rejected';
}

export type SettleResult =
  | { status: 'broadcast'; txid: string }
  | { status: 'uncertain'; txid: string; message: string }
  | { status: 'rejected'; message: string };

/**
 * Broadcast a checkpointed operation's stored bytes and record the verdict.
 * The caller holds the operation's claim. Bookkeeping failures after an
 * accepted broadcast never turn it into a failure (the record then stays
 * `signed`/`broadcast`, and recovery settles it: a re-broadcast answers
 * "already known").
 */
export async function settleBroadcast(
  store: LedgerOperationStore,
  broadcast: LedgerTxDeps['broadcast'],
  op: {
    operationId: string;
    walletId: string;
    signedTxHex: string;
    txid: string;
    coldSendId?: string;
  },
  from: readonly LedgerOperationState[],
): Promise<SettleResult> {
  let acceptedTxid: string;
  try {
    acceptedTxid = (await broadcast(op.walletId, op.signedTxHex, op.coldSendId)).txid || op.txid;
  } catch (e) {
    const verdict = classifyBroadcastError(e);
    if (verdict === 'already_known') {
      acceptedTxid = op.txid;
    } else if (verdict === 'rejected') {
      await store.discard(op.operationId, from).catch(err => {
        console.warn('[ledger] could not discard rejected operation', err);
      });
      return { status: 'rejected', message: errorText(e) };
    } else {
      const message = errorText(e);
      await store
        .transition(op.operationId, from, 'broadcast_uncertain', { message })
        .catch(err => console.warn('[ledger] could not mark operation uncertain', err));
      return { status: 'uncertain', txid: op.txid, message };
    }
  }
  if (acceptedTxid !== op.txid) {
    console.warn('[ledger] the backend txid differs from the computed one');
  }
  try {
    await store.transition(op.operationId, from, 'broadcast', { txid: op.txid });
    await store.acknowledge(op.operationId);
  } catch (err) {
    console.warn('[ledger] broadcast accepted; checkpoint cleanup deferred to recovery', err);
  }
  return { status: 'broadcast', txid: op.txid };
}

/** Refuse to start new Ledger work while an earlier operation is unsettled:
 *  its inputs may not be marked spent, so a new build could conflict. */
export async function assertNoUnresolvedLedgerOperation(
  store: LedgerOperationStore,
  ctx: LedgerOperationContext,
): Promise<void> {
  const pending = await store.list({ walletId: ctx.walletId, network: ctx.network });
  if (pending.length > 0) {
    const uncertain = pending.some(p => p.state === 'broadcast_uncertain');
    throw new LedgerFlowError(
      'unresolved_operation',
      uncertain
        ? 'an earlier Ledger transaction may already have been sent - wait until it is confirmed before signing another'
        : 'an earlier Ledger transaction is signed but not yet sent - finish it first',
    );
  }
}

const randomId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------------------

export class LedgerOperation {
  readonly operationId: string;
  private signedPcztHex?: string;
  private tx?: { txHex: string; txid: string };
  private checkpointed = false;
  private outcome?: LedgerOperationOutcome;
  private terminal?: LedgerFlowError;
  private running = false;

  constructor(
    private readonly deps: LedgerOperationDeps,
    readonly ctx: LedgerOperationContext,
    readonly input: LedgerOperationInput,
  ) {
    this.operationId = `${input.kind}:${ctx.walletId}:${(deps.newOperationId ?? randomId)()}`;
  }

  /** Signed bytes exist: a retry will not ask the device again. */
  get isSigned(): boolean {
    return this.signedPcztHex !== undefined;
  }

  get isCheckpointed(): boolean {
    return this.checkpointed;
  }

  private track(update: LedgerTrackUpdate): void {
    try {
      this.deps.track?.(this.operationId, this.input.label, update);
    } catch (e) {
      console.warn('[ledger] tracker update failed', e);
    }
  }

  private requireContext(): void {
    if (!this.deps.isCurrent(this.ctx)) {
      throw new LedgerFlowError(
        'context_changed',
        'the selected account or network changed - return to your wallet',
      );
    }
  }

  /**
   * Run (or retry) the operation. A retry resumes after the last completed
   * step; it never repeats the device approval once signatures exist.
   */
  async run(opts: LedgerRunOptions = {}): Promise<LedgerOperationOutcome> {
    if (this.outcome) {
      return this.outcome;
    }
    if (this.terminal) {
      throw new LedgerFlowError('not_retryable', this.terminal.message, this.terminal);
    }
    if (this.running) {
      throw new LedgerFlowError('busy', 'this Ledger transaction is already in progress');
    }
    this.running = true;
    try {
      return await this.runSteps(opts);
    } catch (e) {
      // Only a terminal failure is reported to the tracker as failed; a
      // retryable one (cancelled, rejected on device, checkpoint write) stays
      // pending so a later retry does not follow a "failed" toast.
      const terminal =
        (e instanceof LedgerFlowError &&
          [
            'broadcast_rejected',
            'context_changed',
            'not_retryable',
            'unresolved_operation',
          ].includes(e.code)) ||
        (e instanceof LedgerError &&
          ['app_too_old', 'unsupported_transaction'].includes(e.failure));
      this.track(
        terminal
          ? { status: 'failed', error: errorText(e) }
          : { status: 'pending', step: 'waiting to retry', error: errorText(e) },
      );
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async runSteps(opts: LedgerRunOptions): Promise<LedgerOperationOutcome> {
    const { signal, onPhase, onStep } = opts;
    this.requireContext();

    if (!this.signedPcztHex) {
      await assertNoUnresolvedLedgerOperation(this.deps.store, this.ctx);
      onStep?.('signing');
      this.track({ status: 'pending', step: 'approve on Ledger' });
      const signer = ledgerZcashSigner(this.deps, {
        signal,
        onPhase,
        ...(this.input.transparentPaths ? { transparentPaths: this.input.transparentPaths } : {}),
      });
      const signed = await signer({
        pcztHex: this.input.pcztHex,
        spendIndices: [],
        mainnet: this.ctx.network === 'main',
      });
      if (signed.kind !== 'signedPczt') {
        throw new LedgerError('protocol_error', 'ledger signer returned an unexpected form');
      }
      this.signedPcztHex = signed.pcztHex;
    }

    // Cancellation is honoured up to the checkpoint. Signed bytes are kept in
    // memory, so an explicit retry after a cancel still needs no new approval.
    if (signal?.aborted) {
      throw new LedgerError('cancelled', 'cancelled');
    }
    this.requireContext();
    this.tx ??= await this.deps.extractTx(this.signedPcztHex);
    const tx = this.tx;
    if (signal?.aborted && !this.checkpointed) {
      throw new LedgerError('cancelled', 'cancelled');
    }

    const claimed = await withOperationClaim(this.operationId, async () => {
      if (!this.checkpointed) {
        this.requireContext();
        onStep?.('saving');
        this.track({ status: 'pending', step: 'saving' });
        try {
          await this.deps.store.checkpoint({
            operationId: this.operationId,
            walletId: this.ctx.walletId,
            network: this.ctx.network,
            kind: this.input.kind,
            signedTxHex: tx.txHex,
            txid: tx.txid,
            label: this.input.label,
            ...(this.input.coldSendId ? { coldSendId: this.input.coldSendId } : {}),
          });
        } catch (e) {
          throw new LedgerFlowError(
            'checkpoint_failed',
            `signed, but could not save the transaction: ${errorText(e)} - retry to save it (no new approval needed)`,
            e,
          );
        }
        this.checkpointed = true;
      }

      this.requireContext();
      onStep?.('broadcasting');
      this.track({ status: 'pending', step: 'broadcasting', txId: tx.txid });
      return settleBroadcast(
        this.deps.store,
        (walletId, txHex, coldSendId) => this.deps.broadcast(walletId, txHex, coldSendId),
        {
          operationId: this.operationId,
          walletId: this.ctx.walletId,
          signedTxHex: tx.txHex,
          txid: tx.txid,
          ...(this.input.coldSendId ? { coldSendId: this.input.coldSendId } : {}),
        },
        ['signed'],
      );
    });

    if (!claimed.claimed) {
      throw new LedgerFlowError(
        'busy',
        'another zafu window is sending this transaction - wait for it to finish',
      );
    }
    const settled = claimed.value;
    switch (settled.status) {
      case 'broadcast':
        this.outcome = { status: 'broadcast', operationId: this.operationId, txid: settled.txid };
        this.track({ status: 'done', step: undefined, txId: settled.txid });
        onPhase?.({ phase: 'done' });
        return this.outcome;
      case 'uncertain':
        this.outcome = {
          status: 'uncertain',
          operationId: this.operationId,
          txid: settled.txid,
          message: settled.message,
        };
        this.track({
          status: 'unknown',
          step: 'may have been sent - checking',
          txId: settled.txid,
          error: settled.message,
        });
        return this.outcome;
      case 'rejected':
        this.terminal = new LedgerFlowError(
          'broadcast_rejected',
          `the network refused the transaction: ${settled.message}`,
        );
        throw this.terminal;
    }
  }
}
