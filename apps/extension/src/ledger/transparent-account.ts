/**
 * Transparent Ledger account descriptor.
 *
 * A transparent Ledger send needs three things the shielded import does not
 * currently persist: the account's t-address (to fetch UTXOs from and to route
 * change to) and the BIP44 path the device signs those inputs / derives change
 * under. This reads both from the connected device in one place, so the connect
 * screen and the send flow agree on the exact path.
 *
 * The address is re-derivable on demand from the connected device, so the
 * current wallet record (which stores the unified/orchard `address`, not a
 * transparent one) does not have to change for the send flow to work - the flow
 * can call this at send time. Persisting the t-address into the zcash wallet
 * record would save the round trip but needs a keyring-schema field
 * (`transparentAddress`) that does not exist yet.
 */

import { getLedgerTransparentAddress, transparentPath } from './transparent';

export interface LedgerTransparentAccount {
  /** the account's transparent (t1.../tm...) address, read from the device. */
  readonly address: string;
  /** BIP44 path `44'/coin'/accountIndex'/0/0` controlling that address. */
  readonly path: string;
  readonly accountIndex: number;
  readonly mainnet: boolean;
}

/** Read the transparent account descriptor from the connected Ledger. */
export async function getLedgerTransparentAccount(
  accountIndex: number,
  mainnet: boolean,
): Promise<LedgerTransparentAccount> {
  const address = await getLedgerTransparentAddress(accountIndex, mainnet);
  return { address, path: transparentPath(accountIndex, mainnet), accountIndex, mainnet };
}
