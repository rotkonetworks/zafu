import type { InjectiveWallet } from '@repo/wallet/networks/injective/derive';
import {
  broadcastInjectiveTx,
  queryInjectiveAccount,
  queryInjectiveTx,
} from '@repo/wallet/networks/injective/client';
import { buildSignedInjectiveTx } from '@repo/wallet/networks/injective/tx';
import {
  MSG_TRANSFER_TYPE_URL,
  MSG_SEND_TYPE_URL,
  allowanceCovers,
  buildMsgGrantAllowance,
  buildMsgRevokeAllowance,
  queryFeeAllowance,
} from '@repo/wallet/networks/injective/feegrant';

/** A grant tx measured 116,472 gas on mainnet (simulate); a revoke+grant a bit more. */
const GRANT_GAS = 250_000n;
/** Injective's minimum_gas_price (inj-only). */
const GAS_PRICE = 160_000_000n;
const INCLUSION_POLL_MS = 1_500;
const INCLUSION_TIMEOUT_MS = 45_000;

export interface GranterOptions {
  lcdUrl: string;
  chainId: string;
  spendLimit: bigint;
  grantTtlMs: number;
  shieldFee: bigint;
}

export interface GranterDeps {
  fetchFn: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export type GrantOutcome =
  | { status: 'exists'; expiresAt?: string }
  | { status: 'granted'; txhash: string; height: string; expiresAt: string };

export class GrantError extends Error {
  constructor(
    message: string,
    /** true when the chain may still include it; the client should retry the request */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

export class Granter {
  /** Tail of the serial queue: one hot key, one sequence number. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly wallet: InjectiveWallet,
    private readonly opts: GranterOptions,
    private readonly deps: GranterDeps,
  ) {}

  get address(): string {
    return this.wallet.address;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Make sure `grantee` holds a usable allowance from us. Resolves only after
   * a new grant is included in a block, so the client can use it at once.
   */
  ensureGrant(grantee: string, messageType: string = MSG_TRANSFER_TYPE_URL): Promise<GrantOutcome> {
    return this.exclusive(async () => {
      const { lcdUrl, chainId } = this.opts;
      const fee = { denom: 'inj', amount: this.opts.shieldFee.toString() };

      const existing = await queryFeeAllowance(lcdUrl, this.address, grantee, this.deps.fetchFn);
      // An older grant may be transfer-only; asking for a send then revokes it
      // and re-grants with both, in one tx.
      if (existing && allowanceCovers(existing, fee, messageType, this.deps.now())) {
        return { status: 'exists', expiresAt: existing.expiration?.toISOString() };
      }

      const expiration = new Date(this.deps.now().getTime() + this.opts.grantTtlMs);
      const msgs = [
        // MsgGrantAllowance fails if any allowance exists for the pair, so an
        // exhausted/expiring one is revoked in the same tx.
        ...(existing ? [buildMsgRevokeAllowance(this.address, grantee)] : []),
        buildMsgGrantAllowance({
          granter: this.address,
          grantee,
          spendLimit: [{ denom: 'inj', amount: this.opts.spendLimit.toString() }],
          expiration,
          // shield into Penumbra (IBC) and send out (bank send) - nothing else
          allowedMessages: [MSG_TRANSFER_TYPE_URL, MSG_SEND_TYPE_URL],
        }),
      ];

      const { accountNumber, sequence } = await queryInjectiveAccount(
        lcdUrl,
        this.address,
        this.deps.fetchFn,
      );
      const raw = buildSignedInjectiveTx({
        msgs,
        fee: {
          amount: [{ denom: 'inj', amount: (GRANT_GAS * GAS_PRICE).toString() }],
          gas: GRANT_GAS.toString(),
        },
        pubKey: this.wallet.publicKey,
        privKey: this.wallet.privateKey,
        accountNumber,
        sequence,
        chainId,
      });

      const res = await broadcastInjectiveTx(lcdUrl, raw, this.deps.fetchFn);
      if (res.code !== 0) {
        throw new GrantError(`grant rejected by chain (code ${res.code}): ${res.rawLog}`);
      }

      const height = await this.waitForInclusion(res.txhash);
      return { status: 'granted', txhash: res.txhash, height, expiresAt: expiration.toISOString() };
    });
  }

  private async waitForInclusion(txhash: string): Promise<string> {
    const deadline = this.deps.now().getTime() + INCLUSION_TIMEOUT_MS;
    while (this.deps.now().getTime() < deadline) {
      await this.deps.sleep(INCLUSION_POLL_MS);
      try {
        const st = await queryInjectiveTx(this.opts.lcdUrl, txhash, this.deps.fetchFn);
        if (st.found) {
          if (st.code !== 0) {
            throw new GrantError(`grant tx failed on-chain (code ${st.code}): ${st.rawLog ?? ''}`);
          }
          return st.height ?? '';
        }
      } catch (e) {
        if (e instanceof GrantError) {
          throw e;
        }
        // transient LCD error: keep polling until the deadline
      }
    }
    // Still in the mempool. Holding the queue for longer would stall every
    // other client; a retry will see the allowance once it lands.
    throw new GrantError('grant submitted but not yet confirmed; retry in a few seconds', true);
  }
}
