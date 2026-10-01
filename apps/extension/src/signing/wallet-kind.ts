/**
 * Which signer a wallet record holds: the one place a record becomes a kind.
 *
 * Pure facts, no feature flags; callers apply flags. Keystone, Ledger and
 * viewing-key imports all ride the `zigner-zafu` vault, so `KeyInfo.type`
 * alone cannot tell them apart - the discriminator is
 * `insensitive.coldSignerType`.
 */

export type WalletKind =
  | 'hot' // mnemonic vault
  | 'zigner' // zigner-zafu vault, coldSignerType zigner or absent
  | 'keystone'
  | 'ledger-shielded' // a ledger without a transparent address
  | 'ledger-transparent' // a ledger with a transparent address (hw-app-btc)
  | 'frost-self' // multisig, share held encrypted on zafu
  | 'frost-airgap' // multisig, share held on a zigner
  | 'viewing-key'; // sees, never spends

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
  if (cold === 'viewing-key') {
    return 'viewing-key';
  }
  return key.type === 'keystone' || cold === 'keystone' ? 'keystone' : 'zigner';
};

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

const VIEWING_KEY: Refusal = {
  icon: 'i-ph-eye',
  title: 'this wallet is a viewing key',
  body: "it can see this wallet's transactions but cannot spend. send from the wallet that holds the keys.",
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

const REFUSALS: Partial<Record<WalletKind, (f: SendFlags) => Refusal | null>> = {
  'viewing-key': () => VIEWING_KEY,
  'ledger-shielded': f =>
    f.hardwareWallet ? null : f.ledgerTransparent ? LEDGER_SHIELDED : LEDGER_OFF,
  'ledger-transparent': f => (f.ledgerTransparent || f.hardwareWallet ? null : LEDGER_OFF),
};

/** Why this wallet cannot send zcash, or null when a signer for it exists. A
 *  refused kind is never handed to another device's flow. */
export const zcashSendRefusal = (kind: WalletKind, flags: SendFlags): Refusal | null =>
  REFUSALS[kind]?.(flags) ?? null;
