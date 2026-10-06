import { describe, expect, it } from 'vitest';
import { unwrapCborSinglePczt, unwrapSignerEnvelope } from './zcash-send-cbor-helpers';

// The .node.test.mjs beside this file runs a hand copy of the parser; this one
// runs the real module, so the two cannot drift silently.

const wrap = (payload: Uint8Array): Uint8Array => {
  const len = payload.length;
  const header = [0xa1, 0x01];
  if (len <= 23) {
    header.push(0x40 | len);
  } else if (len <= 0xff) {
    header.push(0x58, len);
  } else {
    header.push(0x59, (len >> 8) & 0xff, len & 0xff);
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
};

const withKernel = (payload: Uint8Array, kernelMap: number[]): Uint8Array => {
  const w = wrap(payload);
  const out = new Uint8Array(w.length + 1 + kernelMap.length);
  out.set(w);
  out[0] = 0xa2;
  out[w.length] = 0x02;
  out.set(kernelMap, w.length + 1);
  return out;
};

describe('unwrapSignerEnvelope', () => {
  it('reads the old map(1) envelope with no kernel info', () => {
    const r = unwrapSignerEnvelope(wrap(new Uint8Array([1, 2, 3])));
    expect(Array.from(r.payload)).toEqual([1, 2, 3]);
    expect(r.kernel).toBeNull();
  });

  it('reads kernel info from key 2', () => {
    const env = withKernel(
      new Uint8Array([9, 9]),
      [0xa3, 0x01, 0x03, 0x02, 0x19, 0x01, 0x00, 0x03, 0x01],
    );
    expect(unwrapSignerEnvelope(env).kernel).toEqual({
      bakedModuleVersion: 3,
      activeModuleVersion: 256,
      hostAbiVersion: 1,
    });
    expect(Array.from(unwrapCborSinglePczt(env))).toEqual([9, 9]);
  });

  it('skips unknown kernel keys', () => {
    const env = withKernel(new Uint8Array([1]), [0xa2, 0x01, 0x04, 0x07, 0x05]);
    expect(unwrapSignerEnvelope(env).kernel).toEqual({ bakedModuleVersion: 4 });
  });

  it('rejects duplicate keys, non-uint values and trailing bytes', () => {
    expect(() =>
      unwrapSignerEnvelope(withKernel(new Uint8Array([1]), [0xa2, 0x01, 0x03, 0x01, 0x04])),
    ).toThrow(/duplicate/);
    expect(() =>
      unwrapSignerEnvelope(withKernel(new Uint8Array([1]), [0xa1, 0x01, 0x41, 0x00])),
    ).toThrow(/unsigned int/);
    expect(() =>
      unwrapSignerEnvelope(withKernel(new Uint8Array([1]), [0xa1, 0x01, 0x03, 0xff])),
    ).toThrow(/not canonical/);
    const trailing = new Uint8Array([...wrap(new Uint8Array([1])), 0x00]);
    expect(() => unwrapCborSinglePczt(trailing)).toThrow(/not canonical/);
  });
});
