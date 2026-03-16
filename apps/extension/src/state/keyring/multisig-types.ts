/**
 * multisig wallet types
 *
 * a multisig wallet is a t-of-n FROST threshold wallet.
 * participants coordinate DKG via the frost relay, then store
 * their key package locally. the public key package + FVK are
 * shared (non-sensitive) — they derive the receiving address
 * and allow all participants to decrypt incoming memos.
 *
 * spending requires t-of-n participants to sign via frost relay.
 */

/** stored per multisig wallet in IDB */
export interface MultisigWallet {
  /** unique wallet id */
  id: string;
  /** user label */
  label: string;
  /** threshold — minimum signers required */
  threshold: number;
  /** total participants */
  maxSigners: number;
  /** hex-encoded FROST key package (SECRET — encrypted at rest) */
  keyPackageHex: string;
  /** hex-encoded FROST public key package (shared, non-sensitive) */
  publicKeyPackageHex: string;
  /** hex-encoded ephemeral seed for signing sessions */
  ephemeralSeedHex: string;
  /** orchard receiving address (unified address string) */
  address: string;
  /** 96-byte orchard FVK derived from FROST group key (hex) */
  orchardFvkHex: string;
  /** mainnet or testnet */
  mainnet: boolean;
  /** creation timestamp */
  createdAt: number;
  /** participant pubkeys (hex ed25519, for display) */
  participants: string[];
  /** links to parent vault */
  vaultId: string;
}

/** zcash wallet entry compatible with existing ZcashWalletJson */
export interface MultisigZcashWallet {
  id: string;
  label: string;
  orchardFvk: string;    // base64-encoded FVK bytes
  address: string;
  accountIndex: number;
  mainnet: boolean;
  ufvk?: string;
  vaultId: string;
  /** multisig-specific fields */
  multisig: {
    threshold: number;
    maxSigners: number;
    publicKeyPackageHex: string;
    keyPackageHex: string;
    ephemeralSeedHex: string;
    participants: string[];
  };
}

/** DKG session state — tracks progress through 3 rounds */
export interface DkgSession {
  /** room code for relay coordination */
  roomCode: string;
  /** relay server URL */
  relayUrl: string;
  /** threshold */
  threshold: number;
  /** max signers */
  maxSigners: number;
  /** current round (0=waiting, 1=round1, 2=round2, 3=complete) */
  round: 0 | 1 | 2 | 3;
  /** our round1 secret (hex, kept locally) */
  secretHex?: string;
  /** our round1 broadcast (hex, sent to relay) */
  broadcastHex?: string;
  /** collected round1 broadcasts from peers */
  peerBroadcasts: string[];
  /** our round2 peer packages */
  peerPackages?: string[];
  /** collected round2 packages from peers */
  collectedRound2: string[];
  /** participants who have joined */
  joinedParticipants: Uint8Array[];
  /** error message if something went wrong */
  error?: string;
}

/** signing session state — tracks a FROST spend authorization */
export interface SigningSession {
  /** room code for relay coordination */
  roomCode: string;
  /** relay server URL */
  relayUrl: string;
  /** current step */
  step: 'round1' | 'collecting-commitments' | 'round2' | 'collecting-shares' | 'aggregating' | 'complete';
  /** our nonces (hex, kept locally) */
  noncesHex?: string;
  /** our signed commitments (hex, broadcast) */
  commitmentsHex?: string;
  /** collected commitments from all signers */
  allCommitments: string[];
  /** sighash from unsigned tx */
  sighashHex?: string;
  /** per-action alphas from unsigned tx */
  alphasHex?: string[];
  /** collected signature shares */
  allShares: string[];
  /** final aggregated signatures (one per action) */
  signatures?: string[];
  /** error */
  error?: string;
}

export const isMultisigWallet = (wallet: { multisig?: unknown }): wallet is MultisigZcashWallet =>
  wallet.multisig !== undefined;
