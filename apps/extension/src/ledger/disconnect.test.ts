import { describe, expect, it } from 'vitest';
import { isLedgerGone } from './disconnect';

const named = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('isLedgerGone', () => {
  it.each([
    new Error('{"_tag":"DeviceDisconnectedWhileSendingError","message":"device disconnected"}'),
    new Error('{"_tag":"DeviceSessionNotFound"}'),
    named('DisconnectedDevice', 'Ledger Device is disconnected'),
    named('DisconnectedDeviceDuringOperation', 'write failed'),
    named('NotFoundError', 'No device selected.'),
    new Error('Ledger device: CLA_NOT_SUPPORTED (0x6e00)'),
    new Error('no active ledger session - call connectLedger() first'),
  ])('reads %s as the device going away', err => {
    expect(isLedgerGone(err)).toBe(true);
  });

  it.each([
    new Error('ledger device action stopped (cancelled on device)'),
    new Error('ledger zcash app 3.7.0 < 3.8.0: shielded signing unavailable'),
    new Error('broadcast failed: tx-expiring-soon'),
    new Error('hardware wallet support is not enabled'),
  ])('keeps %s a plain failure', err => {
    expect(isLedgerGone(err)).toBe(false);
  });
});
