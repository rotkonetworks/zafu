// Wiring tests for the self-custody FROST relay rounds.
//
// The crypto is covered natively in zcli (frost_ironwood_send_v6.rs proves a
// real 2-of-3 signature is accepted by an ironwood action). What is NOT covered
// anywhere else is this orchestration: whether the sighash and the per-spend
// alphas actually reach the co-signers, and whether each round-2 share is
// produced against the alpha belonging to ITS action.
//
// That distinction matters because the failure mode is silent. Pairing action 0
// with action 1's alpha still produces a well-formed 64-byte signature; it just
// does not verify, and the first place anyone finds out is a rejected
// transaction. These tests pin the pairing.
//
// Ironwood is the reason this is newly reachable: before the FROST inputs were
// returned from the ironwood builder, `alphas` was empty here, `numActions` was
// 0, and the loop below never executed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
  openRelayRoom: vi.fn(),
  subscribePeers: vi.fn(),
  sendSignPrefix: vi.fn(),
  sendCommitments: vi.fn(),
  sendShare: vi.fn(),
}));

const worker = vi.hoisted(() => ({
  frostSignRound1InWorker: vi.fn(),
  frostSpendSignInWorker: vi.fn(),
  frostSpendAggregateInWorker: vi.fn(),
}));

vi.mock('./relay-protocol', () => relay);
vi.mock('../../../../state/keyring/network-worker', () => worker);
vi.mock('./helpers', () => ({
  // The real waitFor polls a predicate; peers are already "present" in these
  // tests, so resolve as soon as it holds.
  waitFor: async (pred: () => boolean) => {
    if (!pred()) throw new Error('waitFor predicate never satisfied');
  },
}));
vi.mock('../../multisig/dkg-helpers', () => ({ DEFAULT_RELAY_URL: 'https://relay.invalid' }));

import { runMnemonicFrostSign } from './mnemonic-sign';
import type { SendTxPcztUnsignedResult } from '../../../../state/keyring/network-worker';

const SIGHASH = 'ab'.repeat(32);
/** Two DISTINCT alphas, so a mispaired index is detectable rather than a no-op. */
const ALPHA_0 = '11'.repeat(32);
const ALPHA_1 = '22'.repeat(32);

const unsignedWith = (alphas: string[]): SendTxPcztUnsignedResult =>
  ({
    pcztHex: 'deadbeef',
    summary: 'ironwood send (2 spends)',
    actionCount: alphas.length,
    fee: '10000',
    urFrames: [],
    sighash: SIGHASH,
    alphas,
    spendIndices: alphas.map((_, i) => i),
  }) as unknown as SendTxPcztUnsignedResult;

const ctx = (unsigned: SendTxPcztUnsignedResult) => ({
  ms: {
    publicKeyPackage: 'PKP',
    threshold: 2,
    maxSigners: 3,
    relayUrl: 'https://relay.test',
  },
  secrets: { ephemeralSeed: 'SEED', keyPackage: 'KP' },
  unsigned,
  recipient: 'u1recipient',
  amountZat: '600000',
  setFrostAbort: () => {},
  setRoomCode: () => {},
  setProgress: () => {},
});

beforeEach(() => {
  vi.clearAllMocks();

  relay.openRelayRoom.mockResolvedValue({
    roomCode: 'ROOM',
    abort: new AbortController(),
  });
  // One co-signer (threshold 2 => threshold-1 = 1 peer) has already posted a
  // commitment and a share for every action.
  relay.subscribePeers.mockImplementation((_session: unknown, numActions: number) => ({
    peerCommits: Array.from({ length: numActions }, (_, i) => [`peer-commit-${i}`]),
    peerShares: Array.from({ length: numActions }, (_, i) => [`peer-share-${i}`]),
  }));
  relay.sendSignPrefix.mockResolvedValue(undefined);
  relay.sendCommitments.mockResolvedValue(undefined);
  relay.sendShare.mockResolvedValue(undefined);

  let r1 = 0;
  worker.frostSignRound1InWorker.mockImplementation(async () => {
    const i = r1++;
    return { nonces: `nonce-${i}`, commitments: `own-commit-${i}` };
  });
  worker.frostSpendSignInWorker.mockImplementation(async () => 'own-share');
  worker.frostSpendAggregateInWorker.mockImplementation(
    async (_pkp: string, _sighash: string, alpha: string) => `sig-for-${alpha.slice(0, 4)}`,
  );
});

describe('runMnemonicFrostSign relay wiring', () => {
  it('sends the sighash and every alpha to the co-signers', async () => {
    const unsigned = unsignedWith([ALPHA_0, ALPHA_1]);
    await runMnemonicFrostSign(ctx(unsigned) as never);

    expect(relay.sendSignPrefix).toHaveBeenCalledTimes(1);
    const [, sighash, alphas, recipient, amountZat, fee, pcztHex] =
      relay.sendSignPrefix.mock.calls[0]!;
    expect(sighash).toBe(SIGHASH);
    expect(alphas).toEqual([ALPHA_0, ALPHA_1]);
    // Co-signers verify what they are signing against these, so they must be
    // the build's values, not anything recomputed locally.
    expect(recipient).toBe('u1recipient');
    expect(amountZat).toBe('600000');
    expect(fee).toBe('10000');
    expect(pcztHex).toBe('deadbeef');
  });

  it('signs each action with ITS OWN alpha, not a shared or shifted one', async () => {
    const unsigned = unsignedWith([ALPHA_0, ALPHA_1]);
    await runMnemonicFrostSign(ctx(unsigned) as never);

    expect(worker.frostSpendSignInWorker).toHaveBeenCalledTimes(2);
    // signature: (seed, keyPackage, nonces, sighash, alpha, commitments)
    const call0 = worker.frostSpendSignInWorker.mock.calls[0]!;
    const call1 = worker.frostSpendSignInWorker.mock.calls[1]!;

    expect(call0[3]).toBe(SIGHASH);
    expect(call1[3]).toBe(SIGHASH);
    expect(call0[4]).toBe(ALPHA_0);
    expect(call1[4]).toBe(ALPHA_1);

    // Fresh nonces per action - reuse across actions leaks the share.
    expect(call0[2]).toBe('nonce-0');
    expect(call1[2]).toBe('nonce-1');
    expect(call0[2]).not.toBe(call1[2]);

    // Each round-2 sees its own commitment plus the peer's, for THAT action.
    expect(call0[5]).toEqual(['own-commit-0', 'peer-commit-0']);
    expect(call1[5]).toEqual(['own-commit-1', 'peer-commit-1']);
  });

  it('aggregates per action with the matching alpha and returns sigs in order', async () => {
    const unsigned = unsignedWith([ALPHA_0, ALPHA_1]);
    const sigs = await runMnemonicFrostSign(ctx(unsigned) as never);

    expect(worker.frostSpendAggregateInWorker).toHaveBeenCalledTimes(2);
    const agg0 = worker.frostSpendAggregateInWorker.mock.calls[0]!;
    const agg1 = worker.frostSpendAggregateInWorker.mock.calls[1]!;

    expect(agg0[1]).toBe(SIGHASH);
    expect(agg1[1]).toBe(SIGHASH);
    expect(agg0[2]).toBe(ALPHA_0);
    expect(agg1[2]).toBe(ALPHA_1);
    // own share first, then the peer's, for that action
    expect(agg0[4]).toEqual(['own-share', 'peer-share-0']);
    expect(agg1[4]).toEqual(['own-share', 'peer-share-1']);

    // One signature per action, aligned with spendIndices for the injector.
    expect(sigs).toEqual([`sig-for-${ALPHA_0.slice(0, 4)}`, `sig-for-${ALPHA_1.slice(0, 4)}`]);
    expect(sigs).toHaveLength(unsigned.spendIndices.length);
  });

  it('runs one round-1 per action, so nonces are never reused across actions', async () => {
    await runMnemonicFrostSign(ctx(unsignedWith([ALPHA_0, ALPHA_1])) as never);
    expect(worker.frostSignRound1InWorker).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the build returned no alphas - the pre-ironwood state', async () => {
    // Exactly what the ironwood builder used to return, and why multisig sends
    // had to be refused upstream: zero rounds, zero signatures, and an empty
    // set handed to the injector.
    //
    // This case regressed the moment the gate was lifted: every line after the
    // round-1 loop indexes per-action state, so zero actions threw
    // "Cannot read properties of undefined (reading 'length')" at
    // `peerCommits[0]!` - an opaque crash after a signing room had already been
    // opened. It must be a refusal with a reason instead.
    await expect(runMnemonicFrostSign(ctx(unsignedWith([])) as never)).rejects.toThrow(
      /no spends to sign/,
    );

    expect(worker.frostSignRound1InWorker).not.toHaveBeenCalled();
    expect(worker.frostSpendSignInWorker).not.toHaveBeenCalled();
    expect(worker.frostSpendAggregateInWorker).not.toHaveBeenCalled();
    // and no room was opened for a session that could never produce a signature
    expect(relay.sendSignPrefix).not.toHaveBeenCalled();
  });
});
