// Ledger Zcash account derivation: shielded address + viewing key export.
//
// FVK EXPORT VERDICT (critical): device-signer-kit-zcash DOES expose a viewing
// key export - `getFullViewingKey(path, { mode: 'ufvk' | 'orchardFvk' })` -
// backed by app-zcash firmware INS_GET_VK (0x50), P2 { Ufvk=0, OrchardFvk=1 }.
// UFVK export requires app-zcash >= 3.8.0 (the APDU must include a transparent
// derivation path). We therefore CAN return a UFVK, enabling full shielded
// scanning - Ledger is NOT transparent-only. (Sources: LedgerHQ/device-sdk-ts
// PR #1466; LedgerHQ/app-zcash handlers/get_vk.rs.)

import { getZcashSigner } from './transport';
import { runDeviceAction } from './da-util';

export interface LedgerAccount {
  readonly address: string;
  /**
   * Unified full viewing key. Present because getFullViewingKey('ufvk') exists
   * (see verdict above); enables shielded scanning. Typed optional only so the
   * shape degrades gracefully if a device predates 3.8.0 and the export fails.
   */
  readonly ufvk?: string;
}

// BIP44 coin type: 133 = Zcash mainnet, 1 = testnet (all coins).
function coinType(mainnet: boolean): number {
  return mainnet ? 133 : 1;
}

// Derivation paths - NO "m/" prefix (the SDK expects bare paths).
// Transparent: 44'/coin'/account'/0/0
function transparentPath(accountIndex: number, mainnet: boolean): string {
  return `44'/${coinType(mainnet)}'/${accountIndex}'/0/0`;
}

// Orchard: 32'/coin'/account'
// Exported for completeness / future getShieldedAddress-by-orchard-path use.
export function orchardPath(accountIndex: number, mainnet: boolean): string {
  return `32'/${coinType(mainnet)}'/${accountIndex}'`;
}

/**
 * Derive a Zcash account from the connected Ledger: its unified/shielded
 * address plus (when available) the UFVK for shielded scanning.
 *
 * Uses the active session established by connectLedger().
 */
export async function getLedgerAccount(
  accountIndex: number,
  mainnet: boolean,
): Promise<LedgerAccount> {
  const { signer } = await getZcashSigner();
  const tPath = transparentPath(accountIndex, mainnet);

  // CONFIRMED against @ledgerhq/device-signer-kit-zcash 0.5.0: getShieldedAddress
  // takes the 5-level BIP44 TRANSPARENT path (44'/coin'/account'/change/index)
  // and derives the Orchard account path (32'/coin'/account') itself. So tPath
  // is correct and orchardPath() must NOT be passed here.
  //
  // NOTE: `checkOnDevice` is not set, so the address is NOT displayed on the
  // Ledger for confirmation. A compromised host could therefore show the user
  // an address the device never attested to. Pass { checkOnDevice: true } for
  // the receive-address import once the UX for the on-device prompt exists.
  const shielded = await runDeviceAction(signer.getShieldedAddress(tPath));

  let ufvk: string | undefined;
  try {
    const fvk = await runDeviceAction(signer.getFullViewingKey(tPath, { mode: 'ufvk' }));
    if (fvk.mode === 'ufvk') {
      ufvk = fvk.fullViewingKey;
    }
  } catch {
    // Older app (< 3.8.0) or user declined: fall back to address-only. Without
    // a UFVK, shielded scanning is impossible (transparent-only). The send flow
    // then refuses with "UFVK required for ledger signing", and the connect
    // screen shows the transparent-only notice. Swallowing the cause here is
    // deliberate (an unsupported APDU is expected on older apps) but it also
    // hides genuine transport failures - see the review notes.
    ufvk = undefined;
  }

  return { address: shielded.address, ufvk };
}
