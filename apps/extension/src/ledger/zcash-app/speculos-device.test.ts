/**
 * Unit tests for the Speculos transport, against a scripted fake driver. These
 * always run; the emulator suite is ./speculos.e2e.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError, type ApduCommand } from './contract';
import {
  SpeculosZcashDevice,
  awaitsReview,
  compareAppVersions,
  parseAppAndVersion,
  parseSpeculosUrl,
  serializeApdu,
  statusWordFailure,
  type SpeculosDriver,
} from './speculos-device';

const hex = (s: string) => Uint8Array.from(s.match(/../g)?.map(b => Number.parseInt(b, 16)) ?? []);
const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const cmd = (ins: number, p1 = 0, p2 = 0, data = new Uint8Array(), cla = 0xe0): ApduCommand => ({
  cla,
  ins,
  p1,
  p2,
  data,
});

/** Fake Speculos: answers queued APDU replies and a scripted screen sequence. */
class FakeDriver implements SpeculosDriver {
  sent: string[] = [];
  presses: string[] = [];
  screens: string[];
  private screenAt = 0;

  constructor(
    private readonly replies: { data?: string; sw: number; delayMs?: number }[],
    screens: string[] = ['Zcash app is ready'],
  ) {
    this.screens = screens;
  }

  async apdu(bytes: Uint8Array) {
    this.sent.push(toHex(bytes));
    const r = this.replies.shift();
    if (!r) {
      throw new Error('no reply scripted');
    }
    if (r.delayMs) {
      await new Promise(res => setTimeout(res, r.delayMs));
    }
    return { data: hex(r.data ?? ''), sw: r.sw };
  }

  async screen() {
    return this.screens[Math.min(this.screenAt, this.screens.length - 1)]!;
  }

  async press(button: 'left' | 'right' | 'both') {
    this.presses.push(button);
    this.screenAt += 1;
  }
}

const fast = {
  pollMs: 1,
  reviewBusyRetryMs: 1,
  settleTimeoutMs: 50,
  idleScreen: 'Zcash app is ready',
};

describe('APDU framing and decoding', () => {
  it('serializes short APDUs and refuses oversize payloads', () => {
    expect(toHex(serializeApdu(cmd(0x50, 0x80)))).toBe('e050800000');
    expect(() => serializeApdu(cmd(0x56, 0, 0, new Uint8Array(256)))).toThrow(LedgerError);
    expect(() => serializeApdu({ ...cmd(0x56), p1: 0x100 })).toThrow(/p1/);
  });

  it('decodes GET_APP_AND_VERSION as answered by Speculos (Zcash 3.9.4)', () => {
    // captured from the 3.9.4 ELF under Speculos
    expect(parseAppAndVersion(hex('01055a6361736805332e392e340100'))).toEqual({
      name: 'Zcash',
      version: '3.9.4',
    });
    expect(parseAppAndVersion(hex('01044f4c4f5305312e302e30'))).toEqual({
      name: 'OLOS',
      version: '1.0.0',
    });
    expect(() => parseAppAndVersion(hex('02'))).toThrow(/format/);
    expect(() => parseAppAndVersion(hex('01055a63'))).toThrow(/truncated/);
    expect(() => parseAppAndVersion(hex('01055a6361736805332e392e340200'))).toThrow(/flags/);
  });

  it('keeps failure kinds distinct', () => {
    expect(statusWordFailure(0x5515)).toBe('locked');
    expect(statusWordFailure(0x6982)).toBe('locked');
    expect(statusWordFailure(0x6985)).toBe('rejected');
    expect(statusWordFailure(0x5501)).toBe('rejected');
    expect(statusWordFailure(0x6e00)).toBe('app_not_open');
    expect(statusWordFailure(0x6d00)).toBe('app_not_open');
    expect(statusWordFailure(0x6a84)).toBe('unsupported_transaction');
    expect(statusWordFailure(0x6986)).toBe('change_to_other_account');
    expect(statusWordFailure(0x6601)).toBe('busy');
    expect(statusWordFailure(0xb007)).toBe('protocol_error');
    expect(statusWordFailure(0x6a80)).toBe('protocol_error');
  });

  it('compares app versions numerically', () => {
    expect(compareAppVersions('3.9.4', '3.9.4')).toBe(0);
    expect(compareAppVersions('3.10.0', '3.9.4')).toBe(1);
    expect(compareAppVersions('3.9.3', '3.9.4')).toBe(-1);
  });

  it('knows which commands block on a review', () => {
    expect(awaitsReview(cmd(0x50, 0x00))).toBe(true);
    expect(awaitsReview(cmd(0x50, 0x80))).toBe(false);
    expect(awaitsReview(cmd(0x51, 0x01))).toBe(true);
    expect(awaitsReview(cmd(0x51, 0x00))).toBe(false);
    expect(awaitsReview(cmd(0x56, 0x01, 0x01))).toBe(true);
    expect(awaitsReview(cmd(0x58, 0x01, 0x01))).toBe(true);
    expect(awaitsReview(cmd(0x58, 0x80, 0x00))).toBe(false);
    expect(awaitsReview(cmd(0x57, 0, 0))).toBe(false);
    expect(awaitsReview(cmd(0x01, 0, 0, new Uint8Array(), 0xb0))).toBe(false);
  });

  it('accepts only loopback IP origins for Speculos', () => {
    expect(parseSpeculosUrl('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000');
    expect(parseSpeculosUrl('http://127.0.0.1:5000/')).toBe('http://127.0.0.1:5000');
    expect(parseSpeculosUrl('http://[::1]:5000')).toBe('http://[::1]:5000');
    expect(() => parseSpeculosUrl('http://localhost:5000')).toThrow(/loopback/);
    expect(() => parseSpeculosUrl('http://192.168.1.5:5000')).toThrow(/loopback/);
    expect(() => parseSpeculosUrl('https://127.0.0.1:5000')).toThrow(/http/);
    expect(() => parseSpeculosUrl('http://127.0.0.1')).toThrow(/port/);
    expect(() => parseSpeculosUrl('http://127.0.0.1:5000/apdu')).toThrow(/origin/);
    expect(() => parseSpeculosUrl('http://u:p@127.0.0.1:5000')).toThrow(/credentials/);
  });
});

describe('SpeculosZcashDevice', () => {
  it('reports the running app and refuses to "open" anything but Zcash', async () => {
    const zcash = new SpeculosZcashDevice(
      new FakeDriver([{ data: '01055a6361736805332e392e340100', sw: 0x9000 }]),
      fast,
    );
    await expect(zcash.openZcashApp()).resolves.toEqual({ name: 'Zcash', version: '3.9.4' });

    const other = new SpeculosZcashDevice(
      new FakeDriver([{ data: '0107426974636f696e05322e322e30', sw: 0x9000 }]),
      fast,
    );
    await expect(other.openZcashApp()).rejects.toMatchObject({ failure: 'app_not_open' });
  });

  it('strips status words, and raises a typed error carrying the status word', async () => {
    const drv = new FakeDriver([{ data: 'aabb', sw: 0x9000 }, { sw: 0x6a80 }]);
    const dev = new SpeculosZcashDevice(drv, fast);
    await expect(dev.exchange([cmd(0x52)])).resolves.toEqual([hex('aabb')]);
    const err = await dev.exchange([cmd(0x52)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err).toMatchObject({ failure: 'protocol_error', statusWord: 0x6a80 });
  });

  it('replays 0x6901 (review still drawing) at most three times', async () => {
    const ok = new FakeDriver([{ sw: 0x6901 }, { sw: 0x6901 }, { data: '01', sw: 0x9000 }]);
    await expect(new SpeculosZcashDevice(ok, fast).exchange([cmd(0x57)])).resolves.toEqual([
      hex('01'),
    ]);
    expect(ok.sent).toHaveLength(3);

    const stuck = new FakeDriver([{ sw: 0x6901 }, { sw: 0x6901 }, { sw: 0x6901 }, { sw: 0x9000 }]);
    await expect(new SpeculosZcashDevice(stuck, fast).exchange([cmd(0x57)])).rejects.toMatchObject({
      failure: 'busy',
      statusWord: 0x6901,
    });
    expect(stuck.sent).toHaveLength(3);
  });

  it('refuses a concurrent operation with "busy"', async () => {
    const drv = new FakeDriver([{ sw: 0x9000, delayMs: 20 }]);
    const dev = new SpeculosZcashDevice(drv, fast);
    const first = dev.exchange([cmd(0x52)]);
    await expect(dev.exchange([cmd(0x52)])).rejects.toMatchObject({ failure: 'busy' });
    await first;
    expect(drv.sent).toHaveLength(1);
  });

  it('honours an aborted signal before sending anything', async () => {
    const drv = new FakeDriver([]);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      new SpeculosZcashDevice(drv, fast).exchange([cmd(0x52)], { signal: ctl.signal }),
    ).rejects.toMatchObject({ failure: 'cancelled' });
    expect(drv.sent).toHaveLength(0);
  });

  it('maps an unreachable emulator to "not_connected"', async () => {
    const dead: SpeculosDriver = {
      apdu: () => Promise.reject(new Error('ECONNREFUSED')),
      screen: () => Promise.resolve(''),
      press: () => Promise.resolve(),
    };
    await expect(new SpeculosZcashDevice(dead, fast).currentApp()).rejects.toMatchObject({
      failure: 'not_connected',
    });
  });

  it('walks a review only once review text is up, then approves', async () => {
    // screens as the 3.9.4 app draws a UFVK export on a Nano S+
    const drv = new FakeDriver(
      [{ data: '0003757677', sw: 0x9000, delayMs: 60 }],
      [
        'Share Zcash Unified  Full Viewing Key?',
        'Address (1/3) uview1...',
        'Account #0',
        'Confirm',
        'Zcash app is ready',
      ],
    );
    const phases: string[] = [];
    const dev = new SpeculosZcashDevice(drv, fast);
    await dev.exchange([cmd(0x50, 0x00)], { onPhase: p => phases.push(p.phase) });
    expect(phases).toEqual(['sending', 'review', 'done']);
    expect(drv.presses).toEqual(['right', 'right', 'right', 'both']);
    expect(dev.lastReviewScreens[0]).toMatch(/Viewing Key/);
  });

  it('never presses on the idle screen (would walk into "Quit")', async () => {
    const drv = new FakeDriver([{ sw: 0x9000, delayMs: 30 }], ['Zcash app is ready']);
    await new SpeculosZcashDevice(drv, fast).exchange([cmd(0x50, 0x00)]);
    expect(drv.presses).toEqual([]);
  });

  it('rejects on request and surfaces "rejected"', async () => {
    const drv = new FakeDriver(
      [{ sw: 0x6985, delayMs: 60 }],
      [
        'Share Zcash Unified  Full Viewing Key?',
        'Account #0',
        'Confirm',
        'Cancel',
        'Zcash app is ready',
      ],
    );
    const dev = new SpeculosZcashDevice(drv, fast).withDecision('reject');
    await expect(dev.exchange([cmd(0x50, 0x00)])).rejects.toMatchObject({
      failure: 'rejected',
      statusWord: 0x6985,
    });
    expect(drv.presses).toEqual(['right', 'right', 'right', 'both']);
  });
});
