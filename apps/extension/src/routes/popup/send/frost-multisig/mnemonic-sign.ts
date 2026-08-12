// self-custody FROST multisig signing. zafu has the encrypted FROST share
// locally; runs both rounds itself + relays to peers, then aggregates and
// hands the orchard sigs back to the caller for broadcast.

import {
  frostSignRound1InWorker,
  frostSpendSignInWorker,
  frostSpendAggregateInWorker,
  type SendTxPcztUnsignedResult,
} from '../../../../state/keyring/network-worker';
import {
  openRelayRoom,
  subscribePeers,
  sendSignPrefix,
  sendCommitments,
  sendShare,
} from './relay-protocol';
import { waitFor } from './helpers';
import { DEFAULT_RELAY_URL } from '../../multisig/dkg-helpers';

export interface MnemonicFrostSecrets {
  ephemeralSeed: string;
  keyPackage: string;
}

export interface MnemonicFrostMultisig {
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  relayUrl?: string;
}

export interface RunMnemonicFrostSignArgs {
  ms: MnemonicFrostMultisig;
  secrets: MnemonicFrostSecrets;
  unsigned: SendTxPcztUnsignedResult;
  recipient: string;
  amountZat: string;
  /** registers the abort controller so the caller can cancel via UI. */
  setFrostAbort: (a: AbortController) => void;
  setRoomCode: (code: string) => void;
  setProgress: (msg: string) => void;
}

/** runs the 2-round FROST signing protocol on relay; returns aggregated orchard sigs. */
export async function runMnemonicFrostSign({
  ms,
  secrets,
  unsigned,
  recipient,
  amountZat,
  setFrostAbort,
  setRoomCode,
  setProgress,
}: RunMnemonicFrostSignArgs): Promise<string[]> {
  const session = await openRelayRoom(
    ms.relayUrl || DEFAULT_RELAY_URL,
    ms.threshold,
    ms.maxSigners,
    300,
  );
  setRoomCode(session.roomCode);
  setFrostAbort(session.abort);

  setProgress('round 1: generating commitments...');
  const numActions = unsigned.alphas.length;

  // Fail closed on a build that carries no real spends. Every line below
  // indexes per-action state, so zero actions used to die at `peerCommits[0]!`
  // with "Cannot read properties of undefined" - and, worse, a run that
  // completed with zero rounds would hand an EMPTY signature set to the
  // injector, which is precisely the state the NU6.3 multisig gate existed to
  // prevent. Unreachable while that gate refused ironwood upstream; reachable
  // now that it is lifted.
  if (numActions === 0) {
    throw new Error(
      'this transaction has no spends to sign - refusing to open a signing room ' +
        'that could only produce an empty signature set',
    );
  }

  // fresh nonces+commitments per action - never reuse across actions
  const round1s: { nonces: string; commitments: string }[] = [];
  for (let i = 0; i < numActions; i++) {
    round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
  }

  const { peerCommits, peerShares } = subscribePeers(session, numActions);

  await sendSignPrefix(
    session,
    unsigned.sighash,
    unsigned.alphas,
    recipient,
    amountZat,
    unsigned.fee,
    unsigned.pcztHex,
  );
  await sendCommitments(
    session,
    round1s.map(r => r.commitments),
  );

  setProgress(`round 1: waiting for ${ms.threshold - 1} co-signer(s)...`);
  await waitFor(() => peerCommits[0]!.length >= ms.threshold - 1, 120_000);

  setProgress('round 2: signing...');
  const orchardSigs: string[] = [];
  for (let i = 0; i < numActions; i++) {
    const allCommits = [round1s[i]!.commitments, ...peerCommits[i]!];
    const share = await frostSpendSignInWorker(
      secrets.ephemeralSeed,
      secrets.keyPackage,
      round1s[i]!.nonces,
      unsigned.sighash,
      unsigned.alphas[i]!,
      allCommits,
    );
    await sendShare(session, i, share);

    setProgress(`round 2: collecting shares (${i + 1}/${numActions})...`);
    await waitFor(() => peerShares[i]!.length >= ms.threshold - 1, 120_000);

    const allShares = [share, ...peerShares[i]!];
    const sig = await frostSpendAggregateInWorker(
      ms.publicKeyPackage,
      unsigned.sighash,
      unsigned.alphas[i]!,
      allCommits,
      allShares,
    );
    orchardSigs.push(sig);
  }

  session.abort.abort();
  return orchardSigs;
}
