/**
 * One zigner, both networks: "scan next" on the found screen adds the first
 * code's wallet before the camera opens again, so the second code joins it
 * instead of being the only one that lands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const keyRing = vi.hoisted(() => ({
  keyInfos: [] as unknown[],
  addZignerUnencrypted: vi.fn(() => Promise.resolve('v1')),
}));
vi.mock('../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ keyRing }),
}));
vi.mock('../../state/keyring', () => ({
  keyRingSelector: (s: { keyRing: unknown }) => s.keyRing,
}));
const camera = vi.hoisted(() => ({ onScan: (_: string) => undefined as void }));
vi.mock('../../shared/components/qr-scanner', () => ({
  QrScanner: ({ onScan }: { onScan: (data: string) => void }) => {
    camera.onScan = onScan;
    return null;
  },
}));
vi.mock('../../shared/components/animated-qr-scanner', () => ({ AnimatedQrScanner: () => null }));

const zid = 'zid-of-one-device';
vi.mock('./parse-connect-code', () => ({
  parseConnectCodeBytes: () => ({ ok: false, message: 'unused' }),
  parseConnectCode: (raw: string) =>
    raw === 'penumbra'
      ? {
          ok: true,
          network: 'penumbra',
          device: 'zigner',
          accountIndex: 0,
          label: null,
          walletIdBytes: new Uint8Array([1]),
          fvkBytes: new Uint8Array([2]),
          fvkBech32m: 'penumbrafullviewingkey1example',
          zidPublicKey: zid,
        }
      : {
          ok: true,
          network: 'zcash',
          device: 'zigner',
          accountIndex: 0,
          label: null,
          ufvk: 'uview1example',
          mainnet: true,
          zidPublicKey: zid,
        },
}));

const { DeviceScanner } = await import('./device-scanner');

describe('device scanner', () => {
  let root: Root;
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent === text)!;

  it('keeps the first network when the other network is scanned next', async () => {
    const onDone = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(DeviceScanner, { onDone, onCancel: vi.fn() })));

    act(() => camera.onScan('penumbra'));
    await act(async () => button('scan next').click());
    expect(keyRing.addZignerUnencrypted).toHaveBeenCalledTimes(1);
    expect(keyRing.addZignerUnencrypted).toHaveBeenLastCalledWith(
      expect.objectContaining({ fullViewingKey: 'penumbrafullviewingkey1example' }),
      'zigner penumbra',
      undefined,
    );
    expect(onDone).not.toHaveBeenCalled();

    act(() => camera.onScan('zcash'));
    await act(async () => button('add wallet').click());
    expect(keyRing.addZignerUnencrypted).toHaveBeenCalledTimes(2);
    expect(keyRing.addZignerUnencrypted).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewingKey: 'uview1example', zidPublicKey: zid }),
      'zigner zcash',
      'v1',
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    // the second add is told the vault the first created, so it can join
    // even if a code has no ZID
    expect(keyRing.addZignerUnencrypted.mock.calls[1]![2]).toBe('v1');
  });
});
