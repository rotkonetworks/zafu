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
    raw === 'no-zid'
      ? {
          ok: true,
          network: 'zcash',
          device: 'zigner',
          accountIndex: 0,
          label: null,
          ufvk: 'uview1example',
          mainnet: true,
        }
      : raw === 'penumbra'
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

  const mount = (onDone = vi.fn()) => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(DeviceScanner, { onDone, onCancel: vi.fn() })));
    return onDone;
  };

  it('stays on the code with the reason when adding it fails, and opens no camera', async () => {
    keyRing.addZignerUnencrypted.mockClear();
    keyRing.addZignerUnencrypted.mockImplementationOnce(() =>
      Promise.reject(new Error('could not add this wallet')),
    );
    const onDone = mount();
    act(() => camera.onScan('penumbra'));
    camera.onScan = () => undefined;
    await act(async () => button('scan next').click());
    expect(document.body.textContent).toContain('could not add this wallet');
    expect(button('scan next')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('offers no second network for a code without a ZID: it could not join this wallet', () => {
    mount();
    act(() => camera.onScan('no-zid'));
    expect(button('scan next')).toBeUndefined();
  });

  it('keeps the first network when the other network is scanned next', async () => {
    keyRing.addZignerUnencrypted.mockClear();
    const onDone = mount();

    act(() => camera.onScan('penumbra'));
    await act(async () => button('scan next').click());
    expect(keyRing.addZignerUnencrypted).toHaveBeenCalledTimes(1);
    expect(keyRing.addZignerUnencrypted).toHaveBeenLastCalledWith(
      expect.objectContaining({ fullViewingKey: 'penumbrafullviewingkey1example' }),
      'zigner penumbra',
    );
    expect(onDone).not.toHaveBeenCalled();

    act(() => camera.onScan('zcash'));
    await act(async () => button('add wallet').click());
    expect(keyRing.addZignerUnencrypted).toHaveBeenCalledTimes(2);
    expect(keyRing.addZignerUnencrypted).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewingKey: 'uview1example', zidPublicKey: zid }),
      'zigner zcash',
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
