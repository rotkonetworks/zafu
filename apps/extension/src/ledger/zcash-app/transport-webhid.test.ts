/**
 * Tests for ./transport-webhid.ts against a fake WebHID device.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0),
 * modified: app-info and APDU vectors from rust/src/wallet/ledger/transport.rs
 * tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ApduCommand, LedgerFailure, LedgerSigningPhase } from './contract';
import {
  LedgerError,
  MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS,
  MIN_ZCASH_APP_VERSION_FOR_SIGNING,
} from './contract';
import {
  HID_PACKET_SIZE,
  HidResponseAssembler,
  STATUS_WORDS,
  WebHidLedgerDevice,
  assertLedgerPageContext,
  compareZcashAppVersion,
  decodeAppAndVersion,
  frameApdu,
  isDashboardApp,
  requireZcashApp,
  serializeApdu,
  zcashAppVersionAtLeast,
  type HidConnectionEventLike,
  type HidDeviceLike,
  type HidHostLike,
  type HidInputReportEventLike,
  type LedgerTimings,
} from './transport-webhid';

// ---------------------------------------------------------------------------
// fake WebHID
// ---------------------------------------------------------------------------

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));
const sw = (code: number, data: Uint8Array = new Uint8Array()) => {
  const out = new Uint8Array(data.length + 2);
  out.set(data);
  out[data.length] = code >> 8;
  out[data.length + 1] = code & 0xff;
  return out;
};
const appInfo = (name: string, version: string) =>
  sw(
    0x9000,
    Uint8Array.from([
      1,
      name.length,
      ...new TextEncoder().encode(name),
      version.length,
      ...new TextEncoder().encode(version),
    ]),
  );
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** What the fake device does with one request. */
type Reply = Uint8Array | 'hold' | 'disconnect';

interface Received {
  apdu: Uint8Array;
  at: number;
}

class FakeLedger implements HidDeviceLike {
  readonly vendorId = 0x2c97;
  readonly productId = 0x5011;
  readonly collections = [{ usagePage: 0xffa0 }];
  opened = false;
  received: Received[] = [];
  repliedAt: number[] = [];
  private listeners = new Set<(e: HidInputReportEventLike) => void>();
  private assembler = new HidResponseAssembler();
  private held: (() => void) | undefined;

  constructor(
    private readonly host: FakeHost,
    public handler: (apdu: Uint8Array) => Reply,
  ) {}

  open() {
    this.opened = true;
    return Promise.resolve();
  }
  close() {
    this.opened = false;
    return Promise.resolve();
  }
  addEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'inputreport', l: (e: HidInputReportEventLike) => void) {
    this.listeners.delete(l);
  }

  sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.opened) {
      return Promise.reject(new Error('device not opened'));
    }
    expect(reportId).toBe(0);
    expect(data.length).toBe(HID_PACKET_SIZE);
    const apdu = this.assembler.push(data);
    if (apdu) {
      this.assembler = new HidResponseAssembler();
      this.received.push({ apdu, at: Date.now() });
      const reply = this.handler(apdu);
      if (reply === 'disconnect') {
        setTimeout(() => this.host.unplug(this), 0);
      } else if (reply === 'hold') {
        // released later by release(); the response answers THIS request
        this.held = () => this.reply(sw(0x9000, Uint8Array.from([0xee])));
      } else {
        setTimeout(() => this.reply(reply), 0);
      }
    }
    return Promise.resolve();
  }

  release(response?: Uint8Array) {
    const h = this.held;
    this.held = undefined;
    if (response) {
      this.reply(response);
    } else {
      h?.();
    }
  }

  private reply(response: Uint8Array) {
    this.repliedAt.push(Date.now());
    for (const packet of frameApdu(response)) {
      const e: HidInputReportEventLike = { reportId: 0, data: new DataView(packet.buffer) };
      for (const l of this.listeners) {
        l(e);
      }
    }
  }
}

class FakeHost implements HidHostLike {
  devices: FakeLedger[] = [];
  private listeners = new Set<(e: HidConnectionEventLike) => void>();

  plug(handler: (apdu: Uint8Array) => Reply): FakeLedger {
    const d = new FakeLedger(this, handler);
    this.devices.push(d);
    return d;
  }
  unplug(d: FakeLedger) {
    this.devices = this.devices.filter(x => x !== d);
    d.opened = false;
    for (const l of this.listeners) {
      l({ device: d });
    }
  }
  getDevices() {
    return Promise.resolve([...this.devices] as HidDeviceLike[]);
  }
  requestDevice() {
    return Promise.resolve([...this.devices] as HidDeviceLike[]);
  }
  addEventListener(_t: 'disconnect', l: (e: HidConnectionEventLike) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'disconnect', l: (e: HidConnectionEventLike) => void) {
    this.listeners.delete(l);
  }
}

const FAST: Partial<LedgerTimings> = {
  cooldownMs: 0,
  cooldownPollMs: 5,
  appTransitionTimeoutMs: 400,
  appTransitionPollMs: 10,
  reviewHintMs: 30,
};

const cmd = (ins: number, data: number[] = [], p1 = 0, p2 = 0): ApduCommand => ({
  cla: 0xe0,
  ins,
  p1,
  p2,
  data: Uint8Array.from(data),
});

/** Echo `ins` back as the response data. */
const echo = (apdu: Uint8Array): Reply => sw(0x9000, Uint8Array.from([apdu[1]!]));

async function failure(p: Promise<unknown>): Promise<LedgerError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return e as LedgerError;
  }
  throw new Error('expected a LedgerError');
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

describe('HID framing', () => {
  it('frames channel 0x0101, tag 0x05, seq, and a length prefix only in the first packet', () => {
    const apdu = serializeApdu(
      cmd(
        0x56,
        Array.from({ length: 200 }, (_, i) => i),
      ),
    );
    const packets = frameApdu(apdu);
    // 2 length bytes + 205 APDU bytes, 59 payload bytes per packet
    expect(packets).toHaveLength(Math.ceil((apdu.length + 2) / 59));
    packets.forEach((p, i) => {
      expect(p.length).toBe(64);
      expect([...p.subarray(0, 5)]).toEqual([0x01, 0x01, 0x05, i >> 8, i & 0xff]);
    });
    expect([...packets[0]!.subarray(5, 7)]).toEqual([0x00, apdu.length]);
    expect([...packets[0]!.subarray(7, 12)]).toEqual([0xe0, 0x56, 0, 0, 200]);
  });

  it('round-trips through the assembler for every size up to 255 data bytes', () => {
    for (const n of [0, 1, 52, 53, 54, 111, 112, 255]) {
      const apdu = serializeApdu(
        cmd(
          0x01,
          Array.from({ length: n }, (_, i) => (i * 7) & 0xff),
        ),
      );
      const a = new HidResponseAssembler();
      let out: Uint8Array | undefined;
      for (const p of frameApdu(apdu)) {
        expect(out).toBeUndefined();
        out = a.push(p);
      }
      expect(out).toEqual(apdu);
    }
  });

  it('rejects a wrong channel, tag or sequence', () => {
    const [p0, p1] = frameApdu(serializeApdu(cmd(1, Array(100).fill(0))));
    const bad = (mut: (p: Uint8Array) => void, which = p0!) => {
      const p = which.slice();
      mut(p);
      return p;
    };
    expect(() => new HidResponseAssembler().push(bad(p => (p[1] = 2)))).toThrow(/channel/);
    expect(() => new HidResponseAssembler().push(bad(p => (p[2] = 6)))).toThrow(/tag/);
    const a = new HidResponseAssembler();
    a.push(p0!);
    expect(() => a.push(bad(p => (p[4] = 5), p1))).toThrow(/sequence/);
  });

  it('serializes the device-management APDUs exactly as vizor', () => {
    expect([
      ...serializeApdu({ cla: 0xb0, ins: 0x01, p1: 0, p2: 0, data: new Uint8Array() }),
    ]).toEqual([0xb0, 0x01, 0x00, 0x00, 0x00]);
    expect([
      ...serializeApdu({
        cla: 0xe0,
        ins: 0xd8,
        p1: 0,
        p2: 0,
        data: new TextEncoder().encode('Zcash'),
      }),
    ]).toEqual([0xe0, 0xd8, 0x00, 0x00, 0x05, 0x5a, 0x63, 0x61, 0x73, 0x68]);
    expect(() => serializeApdu(cmd(1, Array(256).fill(0)))).toThrow(/255/);
    expect(() => serializeApdu({ ...cmd(1), p2: 256 })).toThrow(/p2/);
  });

  it('decodes GET_APP_AND_VERSION (vizor vectors) and rejects malformed ones', () => {
    expect(decodeAppAndVersion(hex('0105424f4c4f5309312e342e302d726332'))).toEqual({
      name: 'BOLOS',
      version: '1.4.0-rc2',
    });
    expect(decodeAppAndVersion(hex('01055a6361736805332e392e320102'))).toEqual({
      name: 'Zcash',
      version: '3.9.2',
    });
    expect(() => decodeAppAndVersion(Uint8Array.from([2]))).toThrow(/unsupported/);
    expect(() => decodeAppAndVersion(Uint8Array.from([1, 5, 0x5a]))).toThrow(/truncated app name/);
    expect(() => decodeAppAndVersion(Uint8Array.from([1, 1, 0x5a, 1, 0x31, 2, 0]))).toThrow(
      /malformed flags/,
    );
  });
});

// ---------------------------------------------------------------------------
// status words
// ---------------------------------------------------------------------------

describe('status word mapping', () => {
  // Written out independently of STATUS_WORDS so a table edit is caught.
  const expected: [number, LedgerFailure][] = [
    [0x6985, 'rejected'],
    [0x5501, 'rejected'],
    [0x5515, 'locked'],
    [0x6982, 'locked'],
    [0x5303, 'locked'],
    [0x63c0, 'locked'],
    [0x5502, 'locked'],
    [0x6e00, 'app_not_open'],
    [0x6d00, 'app_not_open'],
    [0x6807, 'app_not_open'],
    [0xb007, 'app_not_open'],
    [0x6faa, 'app_not_open'],
    [0x6601, 'busy'],
    [0x6901, 'busy'],
    [0x6a84, 'unsupported_transaction'],
    [0x6a80, 'unsupported_transaction'],
    [0x6986, 'change_to_other_account'],
    [0x6f01, 'protocol_error'],
    [0x6f02, 'protocol_error'],
    [0x6b00, 'protocol_error'],
    [0x6700, 'protocol_error'],
    [0x5223, 'protocol_error'],
    [0x6f00, 'protocol_error'],
    [0x6f03, 'protocol_error'],
    [0x1234, 'protocol_error'], // unknown
  ];

  it('covers exactly the vizor-classified codes', () => {
    expect(new Set(STATUS_WORDS.keys())).toEqual(
      new Set(expected.map(([c]) => c).filter(c => c !== 0x1234)),
    );
  });

  it.each(expected)('0x%s -> %s, with the status word attached', async (code, kind) => {
    const host = new FakeHost();
    const dev = host.plug(() => sw(code));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const err = await failure(ledger.exchange([cmd(0x57), cmd(0x59)]));
    expect(err.failure).toBe(kind);
    expect(err.statusWord).toBe(code);
    // stops at the failing command; 0x6901 is replayed up to 3 times first
    expect(dev.received).toHaveLength(code === 0x6901 ? 3 : 1);
  });

  it('replays 0x6901 and succeeds when the display frees up', async () => {
    const host = new FakeHost();
    let n = 0;
    const dev = host.plug(a => (n++ === 0 ? sw(0x6901) : echo(a)));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect(await ledger.exchange([cmd(0x57)])).toEqual([Uint8Array.from([0x57])]);
    expect(dev.received).toHaveLength(2);
  });

  it('strips status words and returns responses in plan order', async () => {
    const host = new FakeHost();
    host.plug(echo);
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const out = await ledger.exchange([cmd(0x52), cmd(0x53), cmd(0x55)]);
    expect(out.map(r => [...r])).toEqual([[0x52], [0x53], [0x55]]);
  });
});

// ---------------------------------------------------------------------------
// operation slot, cancel, phases
// ---------------------------------------------------------------------------

describe('one operation at a time', () => {
  it('rejects a concurrent call with busy', async () => {
    const host = new FakeHost();
    const dev = host.plug(() => 'hold');
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const first = ledger.exchange([cmd(0x57)]);
    await tick(5);
    expect((await failure(ledger.exchange([cmd(0x59)]))).failure).toBe('busy');
    expect((await failure(ledger.currentApp())).failure).toBe('busy');
    expect((await failure(ledger.openZcashApp())).failure).toBe('busy');
    dev.release();
    expect(await first).toEqual([Uint8Array.from([0xee])]);
    expect(dev.received).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('sends nothing when already aborted', async () => {
    const host = new FakeHost();
    const dev = host.plug(echo);
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const ac = new AbortController();
    ac.abort();
    expect((await failure(ledger.exchange([cmd(0x57)], { signal: ac.signal }))).failure).toBe(
      'cancelled',
    );
    expect(dev.received).toHaveLength(0);
  });

  it('stops mid-plan, never claims the prompt was dismissed, and keeps the late answer out of the next exchange', async () => {
    const host = new FakeHost();
    const dev = host.plug(a => (a[1] === 0x53 ? 'hold' : echo(a)));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const ac = new AbortController();
    const run = ledger.exchange([cmd(0x52), cmd(0x53), cmd(0x55)], { signal: ac.signal });
    await tick(20);
    ac.abort();
    const err = await failure(run);
    expect(err.failure).toBe('cancelled');
    expect(err.message).toMatch(/still shows a prompt/);
    expect(err.message).not.toMatch(/dismiss/i);
    expect(dev.received.map(r => r.apdu[1])).toEqual([0x52, 0x53]); // 0x55 never sent

    // the device still owes the 0x53 answer: nothing may be sent meanwhile
    expect((await failure(ledger.exchange([cmd(0x57)]))).failure).toBe('busy');
    expect(dev.received).toHaveLength(2);

    dev.release(); // late 0x53 answer (data 0xee) arrives and is discarded
    await tick(5);
    expect(await ledger.exchange([cmd(0x57)])).toEqual([Uint8Array.from([0x57])]);
  });
});

describe('phases', () => {
  it('reports connecting, per-command progress, review on a slow answer, and done', async () => {
    const host = new FakeHost();
    const dev = host.plug(a => (a[1] === 0x56 ? 'hold' : echo(a)));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const phases: LedgerSigningPhase[] = [];
    const run = ledger.exchange([cmd(0x54), cmd(0x56), cmd(0x57)], {
      onPhase: p => phases.push(p),
    });
    await tick(60);
    dev.release(sw(0x9000));
    await run;
    expect(phases).toEqual([
      { phase: 'connecting' },
      { phase: 'sending', sent: 0, total: 3 },
      { phase: 'sending', sent: 1, total: 3 },
      { phase: 'review' },
      { phase: 'sending', sent: 2, total: 3 },
      { phase: 'sending', sent: 3, total: 3 },
      { phase: 'done' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// cooldown
// ---------------------------------------------------------------------------

describe('post-signing cooldown', () => {
  it('holds the next command until the status screen clears, after success and after failure', async () => {
    const host = new FakeHost();
    let fail = false;
    const dev = host.plug(a => (fail && a[1] === 0x57 ? sw(0x6985) : echo(a)));
    const ledger = new WebHidLedgerDevice({ host, timings: { ...FAST, cooldownMs: 120 } });

    await ledger.exchange([cmd(0x57)]);
    const signedAt = dev.repliedAt.at(-1)!;
    await ledger.currentApp().catch(() => undefined); // any follow-up waits
    expect(dev.received[1]!.at - signedAt).toBeGreaterThanOrEqual(110);

    fail = true;
    await failure(ledger.exchange([cmd(0x57)]));
    const rejectedAt = dev.repliedAt.at(-1)!;
    fail = false;
    await ledger.exchange([cmd(0x59)]);
    expect(dev.received.at(-1)!.at - rejectedAt).toBeGreaterThanOrEqual(110);
  });

  it('cancelling while waiting out the cooldown sends nothing', async () => {
    const host = new FakeHost();
    const dev = host.plug(echo);
    const ledger = new WebHidLedgerDevice({ host, timings: { ...FAST, cooldownMs: 500 } });
    await ledger.exchange([cmd(0x57)]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    expect((await failure(ledger.exchange([cmd(0x59)], { signal: ac.signal }))).failure).toBe(
      'cancelled',
    );
    expect(dev.received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// app detection + open-app
// ---------------------------------------------------------------------------

describe('currentApp / openZcashApp', () => {
  it('currentApp reads GET_APP_AND_VERSION and never opens anything', async () => {
    const host = new FakeHost();
    const dev = host.plug(() => appInfo('BOLOS', '1.4.0'));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect(await ledger.currentApp()).toEqual({ name: 'BOLOS', version: '1.4.0' });
    expect(dev.received.map(r => [...r.apdu])).toEqual([[0xb0, 0x01, 0, 0, 0]]);
  });

  it('returns at once when Zcash is already open', async () => {
    const host = new FakeHost();
    const dev = host.plug(() => appInfo('Zcash', '3.9.4'));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect(await ledger.openZcashApp()).toEqual({ name: 'Zcash', version: '3.9.4' });
    expect(dev.received).toHaveLength(1);
  });

  it('closes another app, opens Zcash across USB re-enumeration, and polls until it runs', async () => {
    const host = new FakeHost();
    const log: string[] = [];
    // 1. Bitcoin is open; CLOSE_APP makes the device drop off the bus
    host.plug(a => {
      if (a[1] === 0x01) {
        log.push('get:Bitcoin');
        return appInfo('Bitcoin', '2.1.0');
      }
      log.push('close');
      setTimeout(() => {
        // 2. dashboard comes back as a new HID device
        host.plug(b => {
          if (b[1] === 0xd8) {
            log.push(`open:${new TextDecoder().decode(b.subarray(5))}`);
            setTimeout(() => {
              // 3. Zcash, again a new device; first poll catches it mid-boot
              let zPolls = 0;
              host.plug(() => {
                log.push('get:Zcash');
                return zPolls++ === 0 ? sw(0x6601) : appInfo('Zcash', '3.9.4');
              });
            }, 40);
            return 'disconnect';
          }
          log.push('get:OLOS');
          return appInfo('OLOS\0', '1.0.0');
        });
      }, 40);
      return 'disconnect';
    });
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect(await ledger.openZcashApp()).toEqual({ name: 'Zcash', version: '3.9.4' });
    expect(log).toEqual([
      'get:Bitcoin',
      'close',
      'get:OLOS',
      'open:Zcash',
      'get:Zcash',
      'get:Zcash',
    ]);
  });

  it('fails fast on a terminal status (app not installed)', async () => {
    const host = new FakeHost();
    const dev = host.plug(a => (a[1] === 0x01 ? appInfo('BOLOS', '1.4.0') : sw(0x6807)));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    const err = await failure(ledger.openZcashApp());
    expect(err.failure).toBe('app_not_open');
    expect(err.statusWord).toBe(0x6807);
    expect(dev.received).toHaveLength(2);
  });

  it('gives up after the transition timeout with app_not_open', async () => {
    const host = new FakeHost();
    host.plug(a => (a[1] === 0x01 ? appInfo('BOLOS', '1.4.0') : sw(0x9000)));
    const ledger = new WebHidLedgerDevice({
      host,
      timings: { ...FAST, appTransitionTimeoutMs: 60 },
    });
    const err = await failure(ledger.openZcashApp());
    expect(err.failure).toBe('app_not_open');
    expect(err.message).toMatch(/BOLOS/);
  });

  it('honors AbortSignal while polling', async () => {
    const host = new FakeHost();
    const dev = host.plug(a => (a[1] === 0x01 ? appInfo('BOLOS', '1.4.0') : sw(0x9000)));
    const ledger = new WebHidLedgerDevice({
      host,
      timings: { ...FAST, appTransitionTimeoutMs: 10_000 },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect((await failure(ledger.openZcashApp({ signal: ac.signal }))).failure).toBe('cancelled');
    const sent = dev.received.length;
    await tick(50);
    expect(dev.received.length).toBe(sent);
  });

  it('reports locked from the dashboard', async () => {
    const host = new FakeHost();
    host.plug(() => sw(0x5515));
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect((await failure(ledger.openZcashApp())).failure).toBe('locked');
  });
});

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

describe('connection', () => {
  it('is not_connected without a permitted Ledger', async () => {
    const host = new FakeHost();
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect((await failure(ledger.currentApp())).failure).toBe('not_connected');
  });

  it('is not_connected when the device drops mid-exchange', async () => {
    const host = new FakeHost();
    host.plug(() => 'disconnect');
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    expect((await failure(ledger.exchange([cmd(0x57)]))).failure).toBe('not_connected');
  });

  it('ignores reports nobody asked for', async () => {
    const host = new FakeHost();
    const dev = host.plug(echo);
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    await ledger.exchange([cmd(0x52)]);
    dev.release(sw(0x9000, Uint8Array.from([0x99]))); // stray
    expect(await ledger.exchange([cmd(0x53)])).toEqual([Uint8Array.from([0x53])]);
  });

  it('refuses to run outside a WebHID page context', () => {
    // jsdom has no navigator.hid, standing in for the service worker / old browsers
    expect(() => assertLedgerPageContext()).toThrow(LedgerError);
    try {
      assertLedgerPageContext();
    } catch (e) {
      expect((e as LedgerError).failure).toBe('not_connected');
    }
  });

  it('refuses the toolbar popup even when WebHID exists', () => {
    const chromeBefore = (globalThis as { chrome?: object }).chrome;
    vi.stubGlobal('chrome', { ...chromeBefore, extension: { getViews: () => [window] } });
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator) as object, { hid: new FakeHost() }),
    );
    try {
      let err: unknown;
      try {
        assertLedgerPageContext();
      } catch (e) {
        err = e;
      }
      expect((err as LedgerError).failure).toBe('not_connected');
      expect((err as LedgerError).message).toMatch(/popup/);
      // a tab or side panel (not among the popup views) passes
      vi.stubGlobal('chrome', { ...chromeBefore, extension: { getViews: () => [] } });
      expect(assertLedgerPageContext()).toBeInstanceOf(FakeHost);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('chrome', chromeBefore);
    }
  });

  it('close() makes later calls not_connected', async () => {
    const host = new FakeHost();
    host.plug(echo);
    const ledger = new WebHidLedgerDevice({ host, timings: FAST });
    await ledger.close();
    expect((await failure(ledger.exchange([cmd(0x52)]))).failure).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

describe('version helpers', () => {
  it('compares strict x.y.z numerically', () => {
    expect(compareZcashAppVersion('3.9.10', '3.9.4')).toBe(1);
    expect(compareZcashAppVersion('3.9.4', '3.9.4')).toBe(0);
    expect(compareZcashAppVersion('3.10.0', '4.0.0')).toBe(-1);
    expect(compareZcashAppVersion('3.9.4-rc1', '3.9.4')).toBeNull();
    expect(zcashAppVersionAtLeast('3.9.3', MIN_ZCASH_APP_VERSION_FOR_SIGNING)).toBe(true);
    expect(zcashAppVersionAtLeast('3.9.3', MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS)).toBe(false);
    expect(zcashAppVersionAtLeast('3.9.4-rc1', MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS)).toBe(false);
  });

  it('requireZcashApp distinguishes app_not_open from app_too_old', () => {
    const kind = (f: () => void) => {
      try {
        f();
        return 'ok';
      } catch (e) {
        return (e as LedgerError).failure;
      }
    };
    expect(kind(() => requireZcashApp({ name: 'BOLOS', version: '9.9.9' }, '3.9.4'))).toBe(
      'app_not_open',
    );
    expect(kind(() => requireZcashApp({ name: 'Zcash', version: '3.9.3' }, '3.9.4'))).toBe(
      'app_too_old',
    );
    expect(kind(() => requireZcashApp({ name: 'Zcash', version: '3.9.4' }, '3.9.4'))).toBe('ok');
  });

  it('recognizes every dashboard name', () => {
    expect(['BOLOS', 'OLOS', 'OLOS\0'].every(isDashboardApp)).toBe(true);
    expect(isDashboardApp('Zcash')).toBe(false);
  });
});
