import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, isFountainBytes, reviveCborPayload } from './cbor-wire';

const ENV = new Uint8Array([0x53, 0x04, 0x03, 1, 2, 3, 4, 5, 6, 7, 8]);
const UR_FRAMES = ['ur:zigner-module/guaaaxadao'];

describe('cbor wire', () => {
  it('JSON leaves a Uint8Array as a plain object, and hex survives', () => {
    const broken = JSON.parse(JSON.stringify({ cborData: ENV })).cborData as object;
    expect(broken instanceof Uint8Array).toBe(false);
    expect((broken as { byteLength?: number }).byteLength).toBeUndefined();

    const wire = JSON.parse(JSON.stringify({ cborHex: bytesToHex(ENV) })) as { cborHex: string };
    const revived = reviveCborPayload(wire);
    expect(revived.cborData).toEqual(ENV);
    expect(revived.cborData).toBeInstanceOf(Uint8Array);
  });

  it('a send-tx-pczt-unsigned payload round-trips and the frames still carry the envelope', () => {
    const sent = {
      type: 'send-tx-pczt-unsigned',
      payload: {
        pcztHex: 'aa',
        summary: 'ironwood send (1 spend)',
        urFrames: UR_FRAMES,
        cborHex: bytesToHex(ENV),
        cborBytes: ENV.length,
        compactRequest: false,
      },
    };
    const wire = JSON.parse(JSON.stringify(sent)) as typeof sent;
    const revived = reviveCborPayload(wire.payload);
    expect(revived.cborData).toEqual(ENV);
    expect(isFountainBytes(revived.cborData)).toBe(true);
    expect(revived.urFrames).toEqual(UR_FRAMES);
  });

  it('an array payload such as the notes list comes back as the same array', () => {
    const notes = [
      { value: '1', height: 2 },
      { value: '3', height: 4 },
    ];
    const revived = reviveCborPayload(notes);
    expect(revived).toBe(notes);
    expect(Array.isArray(revived)).toBe(true);
    expect([...revived]).toHaveLength(2);
  });

  it('a Uint8Array payload is left alone', () => {
    expect(reviveCborPayload(ENV)).toBe(ENV);
  });

  it('a nested zigner shield payload is revived too', () => {
    const wire = JSON.parse(
      JSON.stringify({
        sighashes: [],
        zigner: { urFrames: UR_FRAMES, cborHex: bytesToHex(ENV), cborBytes: ENV.length },
      }),
    ) as { zigner: { cborData?: Uint8Array } };
    const revived = reviveCborPayload(wire);
    expect(revived.zigner.cborData).toEqual(ENV);
  });

  it('a number array on the wire is accepted', () => {
    const asArray = reviveCborPayload({ cborData: Array.from(ENV) });
    expect(asArray.cborData).toEqual(ENV);
  });

  it('does not mutate the payload that will be broadcast', () => {
    const payload = { cborHex: bytesToHex(ENV), urFrames: UR_FRAMES };
    const revived = reviveCborPayload(payload);
    expect(payload).not.toHaveProperty('cborData');
    expect(revived.cborData).toEqual(ENV);
  });
});

describe('isFountainBytes', () => {
  it('accepts only a non-empty Uint8Array, so the QR keeps the prebuilt frames otherwise', () => {
    const object = JSON.parse(JSON.stringify({ cborData: ENV })).cborData as object;
    expect(isFountainBytes(ENV)).toBe(true);
    expect(isFountainBytes(new Uint8Array())).toBe(false);
    expect(isFountainBytes(object)).toBe(false);
    expect(isFountainBytes(undefined)).toBe(false);
  });
});

describe('hex', () => {
  it('round-trips and rejects odd or non-hex input', () => {
    expect(hexToBytes(bytesToHex(ENV))).toEqual(ENV);
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
    expect(() => hexToBytes('zz')).toThrow(/non-hex/);
  });
});
