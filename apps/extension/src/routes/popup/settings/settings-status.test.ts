import { describe, expect, it } from 'vitest';
import type { AllSlices } from '../../../state';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from '../../../state/privacy';
import type { ZcashWalletJson } from '../../../state/wallets';
import {
  devicesStatus,
  displayStatus,
  networkNames,
  networkStatus,
  peopleStatus,
  securityStatus,
  selectZcashNodeHost,
  selectZcashOpenings,
  unbackedSeats,
  zcashStatus,
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

  it('shows auto-lock, and an unbacked seat as a warning beside it', () => {
    expect(securityStatus(1, '15 min')).toEqual({
      text: 'auto-lock 15 min',
      warn: '1 group seat not backed up',
    });
    expect(securityStatus(2, '15 min').warn).toBe('2 group seats not backed up');
    expect(securityStatus(0, '15 min')).toEqual({ text: 'auto-lock 15 min', warn: undefined });
    expect(securityStatus(0, 'off').text).toBe('auto-lock off');
  });

  it('reads each group plainly, from real values', () => {
    expect(networkStatus(9, 3).text).toBe('9 destinations on · 3 sites connected');
    expect(networkStatus(1, 0).text).toBe('1 destination on · no sites connected');
    // the policy view is read once; until then only the sites show
    expect(networkStatus(undefined, 1).text).toBe('1 site connected');
    expect(zcashStatus(true, 'zcash.rotko.net', 0)).toEqual({
      text: 'zcash.rotko.net · private defaults',
    });
    expect(zcashStatus(true, 'zcash.rotko.net', 2)).toEqual({
      text: 'zcash.rotko.net · ',
      warn: '2 settings less private',
    });
    expect(zcashStatus(false, 'zcash.rotko.net', 2).text).toBe(
      'off · turn on under wallets and devices',
    );
    expect(peopleStatus(true, true, 'off').text).toBe('discovery on · zcash.me off');
    expect(peopleStatus(true, false, undefined).text).toBe('discovery off');
    expect(peopleStatus(false, true, 'off').text).toBe('zid off');
    expect(displayStatus('sumi', false).text).toBe('sumi · balances shown');
    expect(displayStatus('washi', true).text).toBe('washi · balances hidden');
    expect(devicesStatus(2, true, networkNames(['zcash', 'penumbra'])).text).toBe(
      '2 wallets · zigner paired · zcash, penumbra on',
    );
    expect(devicesStatus(1, false, []).text).toBe('1 wallet · no networks on');
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

  it('counts what really lets a node or an explorer see more', () => {
    expect(selectZcashOpenings(state({}, ['zcash']))).toBe(0);
    expect(selectZcashOpenings(state({ explorerLinks: 'open' }, ['zcash']))).toBe(1);
    expect(selectZcashOpenings(state({ explorerLinks: 'copy' }, ['zcash']))).toBe(0);
    // history stays on this computer: nobody else sees it
    expect(selectZcashOpenings(state({ enableTransactionHistory: true }, ['zcash']))).toBe(0);
    expect(
      selectZcashOpenings(
        state({ zcashTransparentEachBlock: true }, ['zcash'], {
          memoSyncStrategy: 'fast',
          mempoolWatch: 'on',
        }),
      ),
    ).toBe(3);
    // a lightwalletd node has no memo decoys or mempool watch to switch
    expect(
      selectZcashOpenings(
        state({}, ['zcash'], { backend: 'lightwalletd', memoSyncStrategy: 'fast' } as never),
      ),
    ).toBe(0);
  });

  it('names the zcash node by the host that sees you sync', () => {
    expect(selectZcashNodeHost(state({}, ['zcash'], { endpoint: 'https://zec.rocks:443' }))).toBe(
      'zec.rocks',
    );
    expect(selectZcashNodeHost(state({}, ['zcash']))).not.toBe('auto');
  });
});
