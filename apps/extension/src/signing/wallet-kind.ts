/**
 * Which signer a wallet record holds, and what that signer can do: the one
 * place a record becomes a kind, and the one table of what each kind can do.
 *
 * Pure facts, no feature flags; callers pass flags in. Keystone, Ledger and
 * viewing-key imports all ride the `zigner-zafu` vault, so `KeyInfo.type`
 * alone cannot tell them apart - the discriminator is
 * `insensitive.coldSignerType`. A record zafu does not recognise is `unknown`
 * and refuses everything; it is never guessed to be a zigner.
 */

export type WalletKind =
  | 'hot' // mnemonic vault
  | 'zigner' // zigner-zafu vault, coldSignerType zigner or absent
  | 'keystone'
  | 'ledger-shielded' // a ledger without a transparent address
  | 'ledger-transparent' // a ledger with a transparent address (hw-app-btc)
  | 'frost-self' // multisig, share held encrypted on zafu
  | 'frost-airgap' // multisig, share held on a zigner
  | 'viewing-key' // sees, never spends
  | 'unknown'; // a vault type or cold signer zafu does not know

export interface WalletFacts {
  readonly type: string;
  readonly insensitive?: Record<string, unknown>;
}

export interface ZcashFacts {
  readonly multisig?: { readonly custody?: string };
  readonly transparentAddress?: string;
}

export const walletKind = (key: WalletFacts, zcash?: ZcashFacts): WalletKind => {
  if (key.type === 'mnemonic') {
    return 'hot';
  }
  if (zcash?.multisig) {
    return zcash.multisig.custody === 'airgapSigner' ? 'frost-airgap' : 'frost-self';
  }
  if (key.type === 'frost-multisig') {
    return 'frost-self';
  }
  const cold = key.insensitive?.['coldSignerType'];
  if (key.type === 'ledger' || cold === 'ledger') {
    return zcash?.transparentAddress ? 'ledger-transparent' : 'ledger-shielded';
  }
  if (key.type === 'keystone' || cold === 'keystone') {
    return 'keystone';
  }
  if (key.type !== 'zigner-zafu') {
    return 'unknown';
  }
  return (cold ?? 'zigner') === 'zigner'
    ? 'zigner'
    : cold === 'viewing-key'
      ? 'viewing-key'
      : 'unknown';
};

export type ZcashPool = 'orchard' | 'ironwood';

/** the zcash send implementations; signing/resolve.ts picks one per kind */
export type ZcashArm =
  | 'hot'
  | 'zigner'
  | 'ledger-shielded'
  | 'ledger-transparent'
  | 'frost-self'
  | 'frost-airgap';

export interface Refusal {
  readonly icon: string;
  readonly title: string;
  readonly body: string;
}

export interface SendFlags {
  /** HARDWARE_WALLET_ENABLED: ledger shielded (PCZT over WebHID) */
  readonly hardwareWallet: boolean;
  /** LEDGER_TRANSPARENT_ENABLED: ledger t->t through the bitcoin app */
  readonly ledgerTransparent: boolean;
}

export interface Caps {
  /** the zcash send implementation under these flags, or why there is none */
  readonly zcash: (f: SendFlags) => ZcashArm | Refusal;
  /** set when this signer reads orchard PCZTs only: why an ironwood send is refused */
  readonly orchardOnly?: Refusal;
  /** the turnstile migration (an ironwood build on the zigner QR) is offered */
  readonly migrate?: true;
  /** signs a t->t with an OP_RETURN (a thorchain deposit); a signer that can't show the memo can't */
  readonly opReturn?: true;
  /** a password unlocks a secret held on zafu before signing */
  readonly unlockToSign: boolean;
  readonly signLabel: string;
  /** after a send, offer to re-sync the device's offline view */
  readonly afterSend?: 'sync-zigner';
  /** who signs for cosmos chains; absent when this kind holds no cosmos key */
  readonly cosmos?: 'hot' | 'zigner';
  /** why this kind cannot sign a zafu identity, or null when it can */
  readonly zid: string | null;
}

const VIEWING_KEY: Refusal = {
  icon: 'i-ph-eye',
  title: 'this wallet is a viewing key',
  body: "it can see this wallet's transactions but cannot spend. send from the wallet that holds the keys.",
};

const UNKNOWN: Refusal = {
  icon: 'i-ph-question',
  title: "zafu does not recognise this wallet's signer",
  body: 'nothing was sent · please send from a zigner or a phrase wallet',
};

const LEDGER_SHIELDED: Refusal = {
  icon: 'i-ph-usb',
  title: 'ledger signs transparent zcash only for now',
  body: "shielded sends need a zigner or this wallet's phrase",
};

const LEDGER_OFF: Refusal = {
  icon: 'i-ph-usb',
  title: 'ledger signing is not ready yet',
  body: "sends need a zigner or this wallet's phrase",
};

const orchardOnly = (device: string, icon: string): Refusal => ({
  icon,
  title: `${device} signs orchard only for now`,
  body: "ironwood sends need a zigner or this wallet's phrase",
});

const LEDGER_ZID =
  'ledger cannot sign a zafu identity yet. please sign in with a zigner or a phrase wallet.';

const LEDGER = { unlockToSign: false, signLabel: 'sign with ledger', zid: LEDGER_ZID } as const;
const NEVER = { unlockToSign: false, signLabel: '' } as const;

export const CAPS: Record<WalletKind, Caps> = {
  hot: {
    zcash: () => 'hot',
    unlockToSign: true,
    signLabel: 'confirm and send',
    migrate: true,
    opReturn: true,
    cosmos: 'hot',
    zid: null,
  },
  zigner: {
    zcash: () => 'zigner',
    unlockToSign: false,
    signLabel: 'sign with zafu zigner',
    afterSend: 'sync-zigner',
    migrate: true,
    cosmos: 'zigner',
    zid: null,
  },
  // keystone reads orchard PCZTs only: an ironwood build rides zigner's
  // `ur:zigner-module` envelope, which keystone cannot read.
  keystone: {
    zcash: () => 'zigner',
    orchardOnly: orchardOnly('keystone', 'i-ph-qr-code'),
    unlockToSign: false,
    signLabel: 'sign with keystone',
    zid: 'keystone cannot sign a zafu identity. please sign in with a zigner or a phrase wallet.',
  },
  'ledger-shielded': {
    ...LEDGER,
    zcash: f =>
      f.hardwareWallet ? 'ledger-shielded' : f.ledgerTransparent ? LEDGER_SHIELDED : LEDGER_OFF,
    orchardOnly: orchardOnly('ledger', 'i-ph-usb'),
  },
  'ledger-transparent': {
    ...LEDGER,
    // t->t through the bitcoin app; with only the shielded flag on, the PCZT path
    zcash: f =>
      f.ledgerTransparent
        ? 'ledger-transparent'
        : f.hardwareWallet
          ? 'ledger-shielded'
          : LEDGER_OFF,
  },
  'frost-self': {
    zcash: () => 'frost-self',
    unlockToSign: true,
    signLabel: 'confirm and send',
    zid: null,
  },
  'frost-airgap': {
    zcash: () => 'frost-airgap',
    unlockToSign: false,
    signLabel: 'sign with zafu zigner',
    zid: null,
  },
  'viewing-key': {
    ...NEVER,
    zcash: () => VIEWING_KEY,
    zid: 'this wallet is a viewing key and holds no identity key to sign with.',
  },
  unknown: {
    ...NEVER,
    zcash: () => UNKNOWN,
    unlockToSign: true,
    zid: 'zafu does not recognise this wallet and cannot sign a zafu identity with it.',
  },
};

/** The zcash send implementation for this wallet from `pool`, or why there is
 *  none. A refused kind is never handed to another device's flow. */
export const zcashArm = (kind: WalletKind, flags: SendFlags, pool: ZcashPool) => {
  const { zcash, orchardOnly } = CAPS[kind];
  const arm = zcash(flags);
  return typeof arm === 'string' && pool === 'ironwood' && orchardOnly ? orchardOnly : arm;
};

/** Why this wallet cannot send zcash from `pool`, or null when it can. */
export const zcashSendRefusal = (kind: WalletKind, flags: SendFlags, pool: ZcashPool) => {
  const arm = zcashArm(kind, flags, pool);
  return typeof arm === 'string' ? null : arm;
};
