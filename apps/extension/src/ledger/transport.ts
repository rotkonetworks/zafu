// Ledger WebHID transport + connection lifecycle (DeviceManagementKit).
//
// CONTEXT WINDOW: WebHID's navigator.hid.requestDevice() requires a live user
// gesture (click) AND a document/window - it CANNOT run in the MV3 service
// worker. connectLedger() must therefore be driven from a page or side-panel
// (onboarding is a real tab; the toolbar popup also works, but the send flow
// gates HID to onboarding). Do not call this from background/service-worker.
//
// The @ledgerhq packages are dynamically imported so this module typechecks
// without them installed and stays out of the main bundle until the Ledger
// flow is actually exercised.

import type {
  DeviceManagementKit,
  DeviceSessionId,
  DiscoveredDevice,
} from '@ledgerhq/device-management-kit';
import type { SignerZcash } from '@ledgerhq/device-signer-kit-zcash';
import { firstFromObservable, runDeviceAction } from './da-util';

export interface LedgerConnection {
  readonly sessionId: string;
  readonly deviceName: string;
  readonly appVersion: string;
}

// Module-scoped singletons. getLedgerAccount() takes no sessionId (see index),
// so the active dmk + session must be retained here across calls within a page
// context. A new connectLedger() replaces them.
let activeDmk: DeviceManagementKit | undefined;
let activeSessionId: DeviceSessionId | undefined;

/** WebHID availability. False in the service worker and on unsupported browsers. */
export function isLedgerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/**
 * Discover + connect a Ledger over WebHID and report the running app version.
 * MUST be called from a user gesture in a page/side-panel context.
 */
export async function connectLedger(): Promise<LedgerConnection> {
  if (!isLedgerSupported()) {
    throw new Error('WebHID unavailable - connect a Ledger from a page (not the service worker)');
  }

  // reflect-metadata is a side-effect polyfill DMK's DI (inversify) needs before
  // it loads. Imported dynamically-first so it stays out of the main bundle.
  await import('reflect-metadata');

  const { DeviceManagementKitBuilder } = await import('@ledgerhq/device-management-kit');
  const { webHidTransportFactory } = await import('@ledgerhq/device-transport-kit-web-hid');

  const dmk = new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build();

  // startDiscovering triggers the WebHID device picker; take the first device.
  const device = await firstFromObservable<DiscoveredDevice>(dmk.startDiscovering({}));
  await dmk.stopDiscovering();

  // ConnectUseCaseArgs takes the DiscoveredDevice itself (not a device id) and
  // `sessionRefresherOptions` (not `options`) - verified against
  // @ledgerhq/device-management-kit 1.7.1 .d.ts.
  const sessionId = await dmk.connect({ device });

  activeDmk = dmk;
  activeSessionId = sessionId;

  // Read the app version via the Zcash signer's getAppConfig (requires the
  // Zcash app to be open on-device). AppConfig is `{ major, minor, patch }` -
  // there is NO `version` string field; join it ourselves so the capability
  // gate (which parses dotted-numeric) gets something it can compare.
  const { SignerZcashBuilder } = await import('@ledgerhq/device-signer-kit-zcash');
  const signer = new SignerZcashBuilder({ dmk, sessionId }).build();
  const { major, minor, patch } = await runDeviceAction(signer.getAppConfig());

  return {
    sessionId,
    deviceName: device.name || 'Ledger',
    appVersion: `${major}.${minor}.${patch}`,
  };
}

/**
 * Build a Zcash signer bound to the active session. Reuses the dmk from the
 * most recent connectLedger(). If a sessionId is supplied it must match the
 * active session (guards against a stale/foreign session id).
 */
export async function getZcashSigner(
  sessionId?: string,
): Promise<{ signer: SignerZcash; sessionId: string }> {
  if (!activeDmk || !activeSessionId) {
    throw new Error('no active ledger session - call connectLedger() first');
  }
  if (sessionId && sessionId !== activeSessionId) {
    throw new Error('ledger session mismatch - reconnect the device');
  }
  const { SignerZcashBuilder } = await import('@ledgerhq/device-signer-kit-zcash');
  const signer = new SignerZcashBuilder({ dmk: activeDmk, sessionId: activeSessionId }).build();
  return { signer, sessionId: activeSessionId };
}
