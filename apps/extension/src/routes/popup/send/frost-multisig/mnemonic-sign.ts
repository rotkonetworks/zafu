// self-custody FROST multisig signing. zafu has the encrypted FROST share
// locally; runs both rounds itself + relays to peers, then aggregates and
// hands the orchard sigs back to the caller for broadcast.

import {
  frostSignRound1InWorker,
  frostSpendSignInWorker,
  frostSpendAggregateInWorker,
  type SendTxUnsignedResult,
} from '../../../../state/keyring/network-worker';
import {
  openRelayRoom,
  subscribePeers,
  sendSignPrefix,
  sendCommitments,
  sendShare,
} from './relay-protocol';
import { waitFor } from './helpers';

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
  unsigned: SendTxUnsignedResult;
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
    ms.relayUrl || 'https://poker.zk.bot',
    ms.threshold,
    ms.maxSigners,
    300,
  );
  setRoomCode(session.roomCode);
  setFrostAbort(session.abort);

  setProgress('round 1: generating commitments...');
  const numActions = unsigned.alphas.length;

  // fresh nonces+commitments per action — never reuse across actions
  const round1s: { nonces: string; commitments: string }[] = [];
  for (let i = 0; i < numActions; i++) {
    round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
  }

  const { peerCommits, peerShares } = subscribePeers(session, numActions);

  await sendSignPrefix(session, unsigned.sighash, unsigned.alphas, recipient, amountZat, unsigned.fee);
  await sendCommitments(session, round1s.map(r => r.commitments));

  setProgress(`round 1: waiting for ${ms.threshold - 1} co-signer(s)...`);
  await waitFor(() => peerCommits[0]!.length >= ms.threshold - 1, 120_000);

  setProgress('round 2: signing...');
  const orchardSigs: string[] = [];
  for (let i = 0; i < numActions; i++) {
    const allCommits = [round1s[i]!.commitments, ...peerCommits[i]!];
    const share = await frostSpendSignInWorker(
      secrets.keyPackage, round1s[i]!.nonces, unsigned.sighash, unsigned.alphas[i]!, allCommits,
    );
    await sendShare(session, i, share);

    setProgress(`round 2: collecting shares (${i + 1}/${numActions})...`);
    await waitFor(() => peerShares[i]!.length >= ms.threshold - 1, 120_000);

    const allShares = [share, ...peerShares[i]!];
    const sig = await frostSpendAggregateInWorker(
      ms.publicKeyPackage, unsigned.sighash, unsigned.alphas[i]!, allCommits, allShares,
    );
    orchardSigs.push(sig);
  }

  session.abort.abort();
  return orchardSigs;
}
