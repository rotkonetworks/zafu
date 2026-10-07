import { sha256 } from '@noble/hashes/sha256';
// Which envelope each cold signer is asked in, and how its answer is read back.
import { describe, expect, test, vi } from 'vitest';
import {
  cborWrapPczt,
  orchardSignRequest,
  zignerSignRequest,
} from '../routes/popup/send/zcash-send-cbor-helpers';
import { signedPcztOfAnswer } from './zigner-answer';
import { createZignerRound, isZignerDeclined } from './zigner-round';

const PCZT = '50435a54' + 'ab'.repeat(40);
const REDACTED = '50435a54' + 'cd'.repeat(8);

const fakeWasm = (redact: (hex: string) => string = () => REDACTED) => {
  const sent: { data: Uint8Array; type: string; size: number }[] = [];
  return {
    sent,
    redact_pczt_compact: vi.fn(redact),
    ur_encode_frames: (data: Uint8Array, type: string, size: number) => {
      sent.push({ data, type, size });
      return JSON.stringify([`ur:${type}/1-1/x`]);
    },
  };
};

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** the device's full answer: CBOR {1: [0x53 0x04 0x03] || digest || len || pczt} */
const fullAnswer = (pcztHex: string) => {
  const p = bytes(pcztHex);
  const env = new Uint8Array(3 + 32 + 4 + p.length);
  env.set([0x53, 0x04, 0x03]);
  new DataView(env.buffer).setUint32(35, p.length, true);
  env.set(p, 39);
  return cborWrapPczt(env);
};

describe('the orchard request', () => {
  test('zigner: the module envelope, compact when asked', () => {
    const wasm = fakeWasm();
    const r = orchardSignRequest(wasm, PCZT, { zigner: true, compact: true, fragmentSize: 400 });
    expect(r.urFrames[0]).toMatch(/^ur:zigner-module\//);
    expect(r.compact).toBe(true);
    expect(hex(r.envelope)).toBe(`530405${REDACTED}`);
    expect(wasm.sent[0]).toMatchObject({ type: 'zigner-module', size: 400 });
  });

  test('zigner, full: the 0x03 envelope around the whole PCZT', () => {
    const r = orchardSignRequest(fakeWasm(), PCZT, {
      zigner: true,
      compact: false,
      fragmentSize: 200,
    });
    expect(hex(r.envelope)).toBe(`530403${PCZT}`);
    expect(r.compact).toBe(false);
  });

  test('keystone keeps ur:zcash-pczt, never compact', () => {
    const wasm = fakeWasm();
    const r = orchardSignRequest(wasm, PCZT, { zigner: false, compact: true, fragmentSize: 400 });
    expect(r.urFrames[0]).toMatch(/^ur:zcash-pczt\//);
    expect(r.compact).toBe(false);
    expect(hex(r.envelope)).toBe(hex(cborWrapPczt(bytes(PCZT))));
    expect(wasm.redact_pczt_compact).not.toHaveBeenCalled();
  });

  test('a redaction that fails goes out full rather than broken', () => {
    const r = zignerSignRequest(
      fakeWasm(() => {
        throw new Error('nope');
      }),
      PCZT,
      { compact: true, fragmentSize: 200 },
    );
    expect(r.compact).toBe(false);
    expect(hex(r.envelope)).toBe(`530403${PCZT}`);
  });
});

describe("zigner's answer", () => {
  const merge = vi.fn((p: string) => Promise.resolve(p));

  test('a full answer gives the signed PCZT', async () => {
    expect(await signedPcztOfAnswer(fullAnswer(PCZT), { compact: false, pcztHex: '', merge })).toBe(
      PCZT,
    );
  });

  test('the legacy wrap holds the raw PCZT', async () => {
    const legacy = cborWrapPczt(bytes(PCZT));
    expect(await signedPcztOfAnswer(legacy, { compact: false, pcztHex: '', merge })).toBe(PCZT);
  });

  test('the answer must match the request', async () => {
    await expect(
      signedPcztOfAnswer(fullAnswer(PCZT), { compact: true, pcztHex: PCZT, merge }),
    ).rejects.toThrow(/older format/);
    const compact = cborWrapPczt(bytes('5304070100'));
    await expect(
      signedPcztOfAnswer(compact, { compact: false, pcztHex: PCZT, merge }),
    ).rejects.toThrow(/not sent as compact/);
  });
});

describe('one zigner round', () => {
  const req = { pcztHex: PCZT, urFrames: ['ur:zigner-module/1-1/x'], compactRequest: false };

  test('shows the request, then hands back what the device signed', async () => {
    const round = createZignerRound(vi.fn());
    const signed = round.sign(req, 'the swap deposit');
    expect(round.store.getState().shown?.label).toBe('the swap deposit');
    round.scan(true);
    expect(round.store.getState().scanning).toBe(true);
    await round.answer(fullAnswer(PCZT));
    expect(await signed).toBe(PCZT);
    expect(round.store.getState()).toEqual({ shown: null, scanning: false });
  });

  test('stepping back declines the round, and a bad answer fails it', async () => {
    const round = createZignerRound(vi.fn());
    const first = round.sign(req, 'move');
    round.cancel();
    await expect(first).rejects.toSatisfy(isZignerDeclined);
    expect(round.store.getState().shown).toBeNull();

    const second = round.sign(req, 'move');
    await round.answer(cborWrapPczt(bytes('5304070100')));
    await expect(second).rejects.toThrow(/not sent as compact/);
  });

  test('a batch round hands back each signed PCZT in request order, and only a whole batch', async () => {
    const msg = (id: number, hex: string) => {
      const body = bytes(hex);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, body.length, true);
      return [1, id, ...sha256(body), ...len, ...body];
    };
    const batch = cborWrapPczt(
      Uint8Array.from([0x53, 0x04, 0x04, 2, ...msg(0, 'aa'), ...msg(1, 'bbcc')]),
    );
    const round = createZignerRound(vi.fn());
    const both = round.signBatch(req, 2, 'sign once');
    expect(round.store.getState().shown?.label).toBe('sign once');
    await round.answer(batch);
    expect(await both).toEqual(['aa', 'bbcc']);

    const again = round.signBatch(req, 2, 'sign once');
    await round.answer(fullAnswer(PCZT));
    await expect(again).rejects.toThrow(/2 signatures/);
  });
});
