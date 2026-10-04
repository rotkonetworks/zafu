/**
 * Opening the Ledger over WebHID, in page context only (side panel or tab;
 * the toolbar popup is torn down when the browser asks for the device).
 */

import { LedgerError, type LedgerZcashDevice } from './contract';
import {
  LEDGER_USAGE_PAGE,
  LEDGER_VENDOR_ID,
  createWebHidLedgerDevice,
  requestLedgerHidPermission,
} from './transport-webhid';

interface GrantedHid {
  getDevices(): Promise<
    { vendorId: number; productName?: string; collections?: { usagePage?: number }[] }[]
  >;
}

const granted = async () => {
  const hid = (navigator as unknown as { hid?: GrantedHid }).hid;
  const devices = (await hid?.getDevices().catch(() => [])) ?? [];
  return devices.find(
    d =>
      d.vendorId === LEDGER_VENDOR_ID &&
      (!d.collections?.length || d.collections.some(c => c.usagePage === LEDGER_USAGE_PAGE)),
  );
};

/** Import: always the chooser, from the click itself (no await before this).
 *  Chrome can drop the grant when the device re-enumerates into the Zcash app. */
export const pickLedger = async (): Promise<{
  device: LedgerZcashDevice;
  productName?: string;
}> => {
  await requestLedgerHidPermission();
  return { device: createWebHidLedgerDevice(), productName: (await granted())?.productName };
};

/** Signing: reuse the grant; ask again only when there is none. */
export const openLedger = async (): Promise<LedgerZcashDevice> => {
  if (!(await granted())) {
    await requestLedgerHidPermission().catch(() => {
      throw new LedgerError('not_connected', 'the ledger is not connected');
    });
  }
  return createWebHidLedgerDevice();
};
