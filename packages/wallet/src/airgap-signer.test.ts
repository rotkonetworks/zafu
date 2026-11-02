import { describe, expect, it } from 'vitest';
import { zignerQrFrames } from './airgap-signer';

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16));
const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 0x53) & 0xff);

describe('zignerQrFrames', () => {
  it('keeps a payload that fits one code as that one code', () => {
    const hex = hexOf(payload(2953));
    expect(zignerQrFrames(hex, 200)).toEqual([hex]);
  });

  it('splits a larger payload into legacy frames zigner reassembles to the same bytes', () => {
    const bytes = payload(4321);
    const frames = zignerQrFrames(hexOf(bytes), 200).map(bytesOf);

    expect(frames).toHaveLength(22);
    const joined: number[] = [];
    frames.forEach((f, i) => {
      const view = new DataView(f.buffer);
      expect(f[0]).toBe(0);
      expect(view.getUint16(1)).toBe(22);
      expect(view.getUint16(3)).toBe(i);
      joined.push(...f.subarray(5));
    });
    expect(Uint8Array.from(joined)).toEqual(bytes);
  });
});
