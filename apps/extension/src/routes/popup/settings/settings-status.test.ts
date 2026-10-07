import { describe, expect, it } from 'vitest';
import type { AllSlices } from '../../../state';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from '../../../state/privacy';
import type { ZcashWalletJson } from '../../../state/wallets';
import {
  devicesStatus,
  networksStatus,
  privacyStatus,
  securityStatus,
  selectOpenings,
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
    expect(privacyStatus(0, 3)).toBe('private defaults · 3 sites connected');
    expect(privacyStatus(1, 1)).toBe('1 setting less private · 1 site connected');
    expect(privacyStatus(2, 0)).toBe('2 settings less private · no sites connected');
    expect(networksStatus(['zcash', 'penumbra'])).toBe('zcash · penumbra');
    expect(networksStatus([])).toBe('no networks on');
    expect(devicesStatus(true, 'sumi')).toBe('zigner paired · sumi theme');
  });

  const state = (
    settings: Partial<PrivacySettings>,
    enabled: string[],
    zcash: { endpoint?: string; memoSyncStrategy?: string; mempoolWatch?: string } = {},
  ) =>
    ({
      privacy: { settings: { ...DEFAULT_PRIVACY_SETTINGS, ...settings } },
      keyRing: { enabledNetworks: enabled },
      networks: { networks: { zcash: { backend: 'zidecar', ...zcash } } },
    }) as unknown as AllSlices;

  it('counts what really lets more be seen, only where its network is on', () => {
    expect(selectOpenings(state({}, ['zcash']))).toBe(0);
    expect(selectOpenings(state({ enableExplorerLinks: true }, ['zcash']))).toBe(1);
    expect(
      selectOpenings(
        state({ zcashTransparentEachBlock: true }, ['zcash'], {
          memoSyncStrategy: 'fast',
          mempoolWatch: 'on',
        }),
      ),
    ).toBe(3);
    // the zcash-only switches stay quiet while zcash is off
    expect(
      selectOpenings(
        state({ zcashTransparentEachBlock: true }, ['penumbra'], { memoSyncStrategy: 'fast' }),
      ),
    ).toBe(0);
    // a lightwalletd node has no memo decoys or mempool watch to switch
    expect(
      selectOpenings(
        state({}, ['zcash'], { backend: 'lightwalletd', memoSyncStrategy: 'fast' } as never),
      ),
    ).toBe(0);
  });
});
