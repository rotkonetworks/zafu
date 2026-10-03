/**
 * One attempt at a send, from the click to its end, and the one way to cancel
 * it. The founder's rule: if a send is cancelled before it is broadcast, it is
 * killed and discarded - whichever way it was cancelled (stop this send, a
 * dismissed password, back out of a signer, the window closing on a cold
 * round). Killing it means:
 *
 * - the worker build is stopped (it races every slow phase, see
 *   workers/build-abort.ts), and every page-side round this attempt holds -
 *   a parked zigner scan, a ledger exchange, a frost room - is ended;
 * - the tracker record and the optimistic outbox entry are marked discarded,
 *   never left pending;
 * - nothing stays reserved: inputs are only marked spent once the network
 *   has the transaction, and a stopped build stashes nothing.
 *
 * Once the attempt has started broadcasting, cancel refuses and says the
 * payment is already on its way. The key is the tracker's opId, so home can
 * stop the same build after this page is gone.
 */

import type { StopOutcome } from '../../../workers/build-abort';

export interface SendRunDeps {
  /** stop the worker build under `key` (network-worker stopBuildInWorker) */
  stopBuild: (key: string) => Promise<StopOutcome>;
  /** mark the tracker record and the outbox entry discarded: nothing was sent */
  discard: (opId: string, tempTxId: string | undefined) => void;
  /** the same, but zafu ended it (a build that never answered): failed, calmly */
  fail: (opId: string, tempTxId: string | undefined, reason: string) => void;
}

export type CancelResult = 'stopped' | 'on-its-way';

export class SendRun {
  /**
   * running: may still be cancelled; sent: broadcast has begun; done: it
   * ended (sent or failed); discarded: cancelled before it left
   */
  private state: 'running' | 'sent' | 'done' | 'discarded' = 'running';
  private wasSent = false;
  private holds = new Set<() => void>();
  /** the optimistic outbox entry, once it exists */
  tempTxId?: string;

  constructor(
    private readonly deps: SendRunDeps,
    /** the tracker opId and the worker build's cancel key */
    readonly key: string = crypto.randomUUID(),
  ) {}

  /** still this page's to drive: not cancelled, not finished */
  get live(): boolean {
    return this.state === 'running' || this.state === 'sent';
  }

  /** cancelled before it left */
  get discarded(): boolean {
    return this.state === 'discarded';
  }

  /** the broadcast has begun: from now on a cancel is refused */
  get sent(): boolean {
    return this.wasSent;
  }

  /** end `fn` with the attempt if it is cancelled; returns the release */
  hold(fn: () => void): () => void {
    if (this.state === 'discarded') {
      fn();
      return () => undefined;
    }
    this.holds.add(fn);
    return () => this.holds.delete(fn);
  }

  /** a signal that aborts when the attempt is cancelled */
  signal(): AbortSignal {
    const ac = new AbortController();
    this.hold(() => ac.abort());
    return ac.signal;
  }

  /** broadcast has begun (a cold signer handed back, or the worker said so) */
  broadcasting(): void {
    if (this.state === 'running') {
      this.state = 'sent';
      this.wasSent = true;
    }
  }

  /** it ended, however it ended; nothing more to cancel */
  finish(): void {
    if (this.state !== 'discarded') {
      this.state = 'done';
    }
    this.holds.clear();
  }

  /**
   * Kill and discard the attempt if it has not been broadcast. The worker has
   * the last word: a build it already committed is on its way. With `failed`,
   * zafu ended it rather than the person, and the records say so.
   */
  async cancel(failed?: string): Promise<CancelResult> {
    if (this.state !== 'running') {
      return this.wasSent ? 'on-its-way' : 'stopped';
    }
    const outcome = await this.deps.stopBuild(this.key);
    if (outcome === 'committed') {
      this.broadcasting();
    }
    if (this.state !== 'running') {
      // it went out, finished or was cancelled while the worker answered
      return this.wasSent ? 'on-its-way' : 'stopped';
    }
    this.state = 'discarded';
    const holds = [...this.holds];
    this.holds.clear();
    for (const end of holds) {
      try {
        end();
      } catch {
        // one round that will not end quietly must not keep the rest alive
      }
    }
    if (failed === undefined) {
      this.deps.discard(this.key, this.tempTxId);
    } else {
      this.deps.fail(this.key, this.tempTxId, failed);
    }
    return 'stopped';
  }
}
