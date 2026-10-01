import { describe, expect, it } from 'vitest';
import type { ZcashWalletJson } from '../../../state/wallets';
import {
  devicesStatus,
  networksStatus,
  privacyStatus,
  securityStatus,
  unbackedSeats,
} from './settings-status';

const seat = (multisig: Partial<NonNullable<ZcashWalletJson['multisig']>>) =>
  ({ id: String(Math.random()), multisig }) as unknown as ZcashWalletJson;

describe('settings status lines', () => {
  it('counts only self-custody, visible seats that were never exported', () => {
    const wallets = [
      seat({}),
      seat({ custody: 'self' }),
      seat({ backedUpAt: 1 }),
      seat({ hidden: true }),
      seat({ custody: 'airgapSigner' }),
      { id: 'plain' } as unknown as ZcashWalletJson,
    ];
    expect(unbackedSeats(wallets)).toHaveLength(2);
  });

  it('puts an unbacked seat ahead of auto-lock', () => {
    expect(securityStatus(1, '15 min')).toBe('1 group seat not backed up');
    expect(securityStatus(2, '15 min')).toBe('2 group seats not backed up');
    expect(securityStatus(0, '15 min')).toBe('auto-lock 15 min');
    expect(securityStatus(0, 'off')).toBe('auto-lock off');
  });

  it('reads privacy, networks and devices plainly', () => {
    expect(privacyStatus(true, 3)).toBe('private defaults · 3 sites connected');
    expect(privacyStatus(false, 1)).toBe('your settings · 1 site connected');
    expect(privacyStatus(true, 0)).toBe('private defaults · no sites connected');
    expect(networksStatus(['zcash', 'penumbra'])).toBe('zcash · penumbra');
    expect(networksStatus([])).toBe('no networks on');
    expect(devicesStatus(true, 'sumi')).toBe('zigner paired · sumi theme');
  });
});
