/**
 * Durable checkpoints of Ledger-signed transactions (vizor operations.rs).
 *
 * A signed transaction is written here BEFORE it is broadcast, so a failed
 * broadcast, a crashed page or a lost connection retries with the SAME signed
 * bytes and never asks the Ledger to approve again. States:
 *
 *   signed              written, not yet (known to be) broadcast; recovery may
 *                       broadcast it again with the stored bytes
 *   broadcast_uncertain a broadcast attempt ended without a verdict (transport
 *                       failure); the node may have it. Resolved only by seeing
 *                       the txid on chain - never re-signed, never replaced
 *   broadcast           the node accepted it; waiting for acknowledgement
 *   acknowledged        terminal: the record is deleted
 *
 * The signed bytes (and the build handle) are sealed with the wallet's session
 * key, the same key that seals the vaults; metadata (state, txid, wallet,
 * network) stays readable so recovery can list work while locked. The keyring's
 * password change re-seals them with every other box in local storage.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import type { LedgerSignedOperation } from './contract';

/** Which chain the checkpoint belongs to: a testnet tx never broadcasts on mainnet. */
export type LedgerNetwork = 'main' | 'test';

export type LedgerOperationState = LedgerSignedOperation['state'];

/** The contract record plus what zafu needs to broadcast and account for it. */
export interface StoredLedgerOperation extends LedgerSignedOperation {
  readonly network: LedgerNetwork;
  /** worker handle for input/send bookkeeping at broadcast */
  readonly coldSendId?: string;
  /** short human label for the tracker ("send 0.5 ZEC", "shield round 2 of 3") */
  readonly label?: string;
  /** last broadcast error, for the recovery UI */
  readonly message?: string;
  readonly updatedAt: number;
}

/** A record without its sealed payload (listing never decrypts). */
export type LedgerOperationMeta = Omit<StoredLedgerOperation, 'signedTxHex' | 'coldSendId'>;

export interface NewLedgerOperation {
  readonly operationId: string;
  readonly walletId: string;
  readonly network: LedgerNetwork;
  readonly kind: LedgerSignedOperation['kind'];
  readonly signedTxHex: string;
  readonly txid: string;
  readonly coldSendId?: string;
  readonly label?: string;
}

/** Minimal async key-value area (chrome.storage.local in production). */
export interface KeyValueArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Seals with the wallet key. `unseal` throws when locked or on a foreign key. */
export interface Sealer {
  seal(plaintext: string): Promise<string>;
  unseal(sealed: string): Promise<string>;
}

interface Envelope {
  meta: LedgerOperationMeta;
  /** Sealer output of JSON {signedTxHex, coldSendId} */
  sealed: string;
}

interface SealedPayload {
  signedTxHex: string;
  coldSendId?: string;
}

type EnvelopeMap = Record<string, Envelope>;

export const LEDGER_OPERATIONS_KEY = 'zafuLedgerSignedOperations';

export class LedgerOperationStoreError extends Error {
  constructor(
    readonly code: 'conflict' | 'not_found' | 'wrong_state' | 'undecryptable',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerOperationStoreError';
  }
}

const isEnvelopeMap = (v: unknown): v is EnvelopeMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface LedgerOperationStore {
  /**
   * Write a signed operation in state `signed`. Idempotent for EXACTLY the same
   * data (a retried checkpoint); a different payload under the same id is a
   * conflict, never an overwrite.
   */
  checkpoint(op: NewLedgerOperation): Promise<LedgerOperationMeta>;
  /** Full record with the signed bytes (unseals). */
  get(operationId: string): Promise<StoredLedgerOperation | undefined>;
  list(filter?: { walletId?: string; network?: LedgerNetwork }): Promise<LedgerOperationMeta[]>;
  /** Compare-and-set state transition. */
  transition(
    operationId: string,
    from: readonly LedgerOperationState[],
    to: LedgerOperationState,
    patch?: { txid?: string; message?: string },
  ): Promise<LedgerOperationMeta>;
  /** Terminal: a `broadcast` record is acknowledged and deleted. */
  acknowledge(operationId: string): Promise<void>;
  /** Drop a record the network definitively refused (rejected broadcast). */
  discard(operationId: string, from: readonly LedgerOperationState[]): Promise<void>;
}

export interface LedgerOperationStoreDeps {
  readonly area: KeyValueArea;
  readonly sealer: Sealer;
  readonly now?: () => number;
}

export function createLedgerOperationStore(deps: LedgerOperationStoreDeps): LedgerOperationStore {
  const now = deps.now ?? Date.now;
  // Serialize read-modify-write within this document; state transitions are
  // compare-and-set so a second document racing us fails closed, not silently.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async (): Promise<EnvelopeMap> => {
    const raw = await deps.area.get(LEDGER_OPERATIONS_KEY);
    return isEnvelopeMap(raw) ? { ...raw } : {};
  };
  const write = (map: EnvelopeMap) => deps.area.set(LEDGER_OPERATIONS_KEY, map);

  const unsealPayload = async (env: Envelope): Promise<SealedPayload> => {
    let text: string;
    try {
      text = await deps.sealer.unseal(env.sealed);
    } catch (e) {
      throw new LedgerOperationStoreError(
        'undecryptable',
        `ledger operation ${env.meta.operationId} cannot be decrypted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const parsed = JSON.parse(text) as SealedPayload;
    if (typeof parsed.signedTxHex !== 'string' || parsed.signedTxHex.length === 0) {
      throw new LedgerOperationStoreError('undecryptable', 'sealed ledger operation is malformed');
    }
    return parsed;
  };

  return {
    checkpoint: op =>
      serial(async () => {
        const map = await read();
        const existing = map[op.operationId];
        if (existing) {
          const payload = await unsealPayload(existing);
          const same =
            payload.signedTxHex === op.signedTxHex &&
            (payload.coldSendId ?? undefined) === (op.coldSendId ?? undefined) &&
            existing.meta.walletId === op.walletId &&
            existing.meta.network === op.network &&
            existing.meta.kind === op.kind &&
            existing.meta.txid === op.txid;
          if (!same) {
            throw new LedgerOperationStoreError(
              'conflict',
              `ledger operation ${op.operationId} already holds a different transaction`,
            );
          }
          return existing.meta;
        }
        const t = now();
        const meta: LedgerOperationMeta = {
          operationId: op.operationId,
          walletId: op.walletId,
          network: op.network,
          kind: op.kind,
          state: 'signed',
          txid: op.txid,
          ...(op.label ? { label: op.label } : {}),
          createdAt: t,
          updatedAt: t,
        };
        const payload: SealedPayload = {
          signedTxHex: op.signedTxHex,
          ...(op.coldSendId ? { coldSendId: op.coldSendId } : {}),
        };
        map[op.operationId] = { meta, sealed: await deps.sealer.seal(JSON.stringify(payload)) };
        await write(map);
        return meta;
      }),

    get: async operationId => {
      const env = (await read())[operationId];
      if (!env) {
        return undefined;
      }
      const payload = await unsealPayload(env);
      return {
        ...env.meta,
        signedTxHex: payload.signedTxHex,
        ...(payload.coldSendId ? { coldSendId: payload.coldSendId } : {}),
      };
    },

    list: async (filter = {}) =>
      Object.values(await read())
        .map(e => e.meta)
        .filter(
          m =>
            (filter.walletId === undefined || m.walletId === filter.walletId) &&
            (filter.network === undefined || m.network === filter.network),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId)),

    transition: (operationId, from, to, patch = {}) =>
      serial(async () => {
        const map = await read();
        const env = map[operationId];
        if (!env) {
          throw new LedgerOperationStoreError(
            'not_found',
            `ledger operation ${operationId} is gone`,
          );
        }
        if (!from.includes(env.meta.state)) {
          throw new LedgerOperationStoreError(
            'wrong_state',
            `ledger operation ${operationId} is ${env.meta.state}, expected ${from.join(' | ')}`,
          );
        }
        const meta: LedgerOperationMeta = {
          ...env.meta,
          state: to,
          ...(patch.txid !== undefined ? { txid: patch.txid } : {}),
          ...(patch.message !== undefined ? { message: patch.message } : {}),
          updatedAt: now(),
        };
        map[operationId] = { ...env, meta };
        await write(map);
        return meta;
      }),

    acknowledge: operationId =>
      serial(async () => {
        const map = await read();
        const env = map[operationId];
        if (!env) {
          return; // already acknowledged
        }
        if (env.meta.state !== 'broadcast') {
          throw new LedgerOperationStoreError(
            'wrong_state',
            `ledger operation ${operationId} is ${env.meta.state}; only a broadcast result can be acknowledged`,
          );
        }
        delete map[operationId];
        await write(map);
      }),

    discard: (operationId, from) =>
      serial(async () => {
        const map = await read();
        const env = map[operationId];
        if (!env) {
          return;
        }
        if (!from.includes(env.meta.state)) {
          throw new LedgerOperationStoreError(
            'wrong_state',
            `ledger operation ${operationId} is ${env.meta.state}; refusing to discard`,
          );
        }
        delete map[operationId];
        await write(map);
      }),
  };
}

/**
 * Per-operation exclusive claim, across every zafu document when Web Locks are
 * available (side panel + tab + popup share the extension origin), otherwise
 * within this document. `fn` runs only if the claim is free; returns
 * `{ claimed: false }` otherwise, so recovery skips an operation whose signing
 * surface still owns it (vizor LedgerOperationClaimRegistry + BroadcastGuard).
 */
const localClaims = new Set<string>();
export async function withOperationClaim<T>(
  operationId: string,
  fn: () => Promise<T>,
): Promise<{ claimed: true; value: T } | { claimed: false }> {
  const name = `zafu-ledger-operation:${operationId}`;
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    let ran = false;
    let value: T | undefined;
    await locks.request(name, { ifAvailable: true }, async lock => {
      if (!lock) {
        return;
      }
      ran = true;
      value = await fn();
    });
    return ran ? { claimed: true, value: value as T } : { claimed: false };
  }
  if (localClaims.has(name)) {
    return { claimed: false };
  }
  localClaims.add(name);
  try {
    return { claimed: true, value: await fn() };
  } finally {
    localClaims.delete(name);
  }
}
