/**
 * Consecutive Ledger shielding approvals (vizor ledger_shield_signing_overlay +
 * connection-and-shielding.md "Consecutive shielding approvals").
 *
 * The Zcash app signs at most 32 transparent inputs per transaction, so a
 * larger transparent balance is shielded in rounds, all inside ONE session
 * (the device stays connected; each round is its own transaction, fee and
 * device approval):
 *
 * - The number of rounds shown is recomputed from the CURRENTLY eligible
 *   inputs before every round; it is not a promise about future deposits.
 * - No eligible inputs: the session is complete.
 * - Remaining value below the fee threshold: pause with an explanation.
 * - The eligible inputs could not be read: never read as zero funds. Before
 *   the first round that is an error; after a sent round it pauses.
 * - No decrease in eligible inputs after a broadcast: pause rather than sign
 *   possibly-conflicting inputs again (the backend may not see the spend yet).
 * - Uncertain broadcast: pause; recovery owns it; no further round.
 * - A failed round (rejected on device, cancelled, checkpoint failure) is
 *   retried by calling run() again: the same round resumes, reusing its signed
 *   bytes when they exist.
 * - Account/network change stops before the next step.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import { LEDGER_ZCASH_LIMITS } from './contract';
import {
  LedgerFlowError,
  LedgerOperation,
  assertNoUnresolvedLedgerOperation,
  type LedgerOperationContext,
  type LedgerOperationDeps,
  type LedgerRunOptions,
} from './operation';
import type { LedgerTransparentPath } from './signer';

export interface ShieldEligibleWork {
  readonly inputCount: number;
  /** the next round's inputs would not cover its own fee */
  readonly belowThreshold: boolean;
}

export interface LedgerShieldingDeps extends LedgerOperationDeps {
  /** currently eligible transparent inputs; throws when they cannot be read */
  readEligible(): Promise<ShieldEligibleWork>;
  /** build one unsigned shielding PCZT spending at most `maxInputs` inputs */
  buildShieldPczt(maxInputs: number): Promise<{
    pcztHex: string;
    coldSendId?: string;
    /** one derivation tail per transparent input, for stamping */
    transparentPaths: readonly LedgerTransparentPath[];
  }>;
}

export interface ShieldingProgress {
  /** 1-based round being worked on (during 'checking', the round that would come next) */
  readonly round: number;
  /** rounds completed so far + rounds the current inputs still need; 0 = not known yet */
  readonly totalRounds: number;
  readonly step: 'checking' | 'preparing' | 'signing' | 'saving' | 'broadcasting';
}

export type ShieldingPauseReason = 'below_threshold' | 'no_decrease' | 'unreadable' | 'uncertain';

export type ShieldingOutcome =
  | { readonly status: 'complete'; readonly txids: readonly string[] }
  | {
      readonly status: 'paused';
      readonly reason: ShieldingPauseReason;
      readonly message: string;
      readonly txids: readonly string[];
    };

export interface ShieldingRunOptions extends Omit<LedgerRunOptions, 'onStep'> {
  readonly onProgress?: (p: ShieldingProgress) => void;
}

export const roundsFor = (inputCount: number, perRound: number): number => {
  if (perRound <= 0) {
    throw new Error('invalid Ledger input limit');
  }
  return Math.ceil(inputCount / perRound);
};

export class LedgerShieldingSession {
  private round = 1;
  /** 0 until the eligible inputs have been read once */
  private totalRounds = 0;
  private pendingInputs?: number;
  private current?: LedgerOperation;
  private readonly txids: string[] = [];
  private finished?: ShieldingOutcome;
  readonly perRound: number;

  constructor(
    private readonly deps: LedgerShieldingDeps,
    readonly ctx: LedgerOperationContext,
    opts: { perRound?: number } = {},
  ) {
    this.perRound = Math.min(
      opts.perRound ?? LEDGER_ZCASH_LIMITS.maxTransparentInputs,
      LEDGER_ZCASH_LIMITS.maxTransparentInputs,
    );
  }

  get sentTxids(): readonly string[] {
    return this.txids;
  }

  private requireContext(): void {
    if (!this.deps.isCurrent(this.ctx)) {
      throw new LedgerFlowError(
        'context_changed',
        'the selected account or network changed - return to your wallet',
      );
    }
  }

  private pause(reason: ShieldingPauseReason, message: string): ShieldingOutcome {
    this.finished = { status: 'paused', reason, message, txids: [...this.txids] };
    return this.finished;
  }

  /** Start, or retry the current round after a failure. */
  async run(opts: ShieldingRunOptions = {}): Promise<ShieldingOutcome> {
    if (this.finished) {
      return this.finished;
    }
    const { onProgress, ...runOpts } = opts;
    const emit = (step: ShieldingProgress['step']) =>
      onProgress?.({ round: this.round, totalRounds: this.totalRounds, step });

    for (;;) {
      this.requireContext();

      if (!this.current) {
        emit('checking');
        let work: ShieldEligibleWork;
        try {
          work = await this.deps.readEligible();
        } catch (e) {
          if (this.txids.length === 0) {
            throw new LedgerFlowError(
              'funds_unreadable',
              'could not read your transparent funds - try again after sync',
              e,
            );
          }
          return this.pause(
            'unreadable',
            `round ${this.round - 1} was sent, but the remaining funds could not be checked - try again after sync`,
          );
        }
        this.requireContext();
        if (work.inputCount <= 0) {
          this.finished = { status: 'complete', txids: [...this.txids] };
          return this.finished;
        }
        if (work.belowThreshold) {
          return this.pause(
            'below_threshold',
            this.txids.length === 0
              ? 'the transparent funds are below the shielding fee'
              : `round ${this.round - 1} was sent; the remaining funds are below the shielding fee`,
          );
        }
        if (this.pendingInputs !== undefined && work.inputCount >= this.pendingInputs) {
          return this.pause(
            'no_decrease',
            `round ${this.round - 1} was sent, but no decrease in spendable inputs is visible yet - wait for sync before shielding again`,
          );
        }
        this.totalRounds = this.round - 1 + roundsFor(work.inputCount, this.perRound);
        emit('preparing');
        if (this.txids.length === 0) {
          await assertNoUnresolvedLedgerOperation(this.deps.store, this.ctx);
        }
        const built = await this.deps.buildShieldPczt(this.perRound);
        this.requireContext();
        this.pendingInputs = work.inputCount;
        this.current = new LedgerOperation(this.deps, this.ctx, {
          kind: 'shield',
          pcztHex: built.pcztHex,
          ...(built.coldSendId ? { coldSendId: built.coldSendId } : {}),
          transparentPaths: built.transparentPaths,
          label:
            this.totalRounds > 1
              ? `shield ZEC (${this.round} of ${this.totalRounds})`
              : 'shield ZEC',
        });
      }

      const outcome = await this.current.run({
        ...runOpts,
        onStep: step => emit(step),
      });
      if (outcome.status === 'uncertain') {
        return this.pause(
          'uncertain',
          `round ${this.round} may already have been sent - zafu is checking; no further round until it is confirmed`,
        );
      }
      this.txids.push(outcome.txid);
      this.current = undefined;
      this.round++;
    }
  }
}
