/**
 * The scanner reads the camera it picked: one probe for the permission, one
 * stream from the chosen camera, and that stream is the one decoded - never
 * a second, default-facing stream opened in its place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zxing = vi.hoisted(() => ({
  decodeFromStream: vi.fn(),
  decodeFromVideoDevice: vi.fn(),
}));
vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    static listVideoInputDevices = () =>
      Promise.resolve([
        { deviceId: 'front', label: 'front camera' },
        { deviceId: 'rear', label: 'back camera' },
      ]);
    decodeFromStream = zxing.decodeFromStream;
    decodeFromVideoDevice = zxing.decodeFromVideoDevice;
  },
}));

const { QrScanner } = await import('./qr-scanner');

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;

describe('qr scanner', () => {
  let root: Root;
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('decodes the stream of the camera it picked, and hands over what it read', async () => {
    const probe = fakeStream();
    const chosen = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(probe).mockResolvedValueOnce(chosen);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    let decoded: (r: { getText: () => string } | undefined) => void = () => undefined;
    zxing.decodeFromStream.mockImplementation((_s, _v, cb: typeof decoded) => {
      decoded = cb;
      return Promise.resolve({ stop: vi.fn() });
    });
    const onScan = vi.fn();

    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => {
      root.render(createElement(QrScanner, { onScan, onClose: vi.fn() }));
    });
    await vi.waitFor(() => expect(zxing.decodeFromStream).toHaveBeenCalled());

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]![0]).toMatchObject({ video: { deviceId: 'rear' } });
    expect(zxing.decodeFromStream.mock.calls[0]![0]).toBe(chosen);
    expect(zxing.decodeFromVideoDevice).not.toHaveBeenCalled();

    act(() => decoded({ getText: () => 'u1example' }));
    expect(onScan).toHaveBeenCalledWith('u1example');
  });
});
