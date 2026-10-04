/**
 * Ledger Zcash-app TRANSPORT over WebHID - implements `LedgerZcashDevice`
 * from ./contract.ts.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0),
 * modified: rust/src/wallet/ledger/transport.rs (HID framing, app-info
 * decoding, review-busy retry), rust/src/wallet/ledger/mod.rs (open-app flow,
 * dashboard names, app transition polling, SIGNING_STATUS_COOLDOWN),
 * rust/src/wallet/ledger/apdu.rs + lib/src/features/ledger/ledger_error_codes.dart
 * (status word classification), lib/src/features/ledger/ledger_capability.dart
 * (strict version compare).
 *
 * CONTEXT: WebHID only exists in a document. It works in the side panel and in
 * an extension tab (page.html). It does NOT work in the MV3 service worker (no
 * navigator.hid), and the toolbar popup is unusable (the device chooser and any
 * focus change on the Ledger tear the popup down mid-exchange). Every entry
 * point that touches navigator.hid goes through `assertLedgerPageContext()`.
 *
 * This module only moves bytes and interprets status words. It never parses a
 * signature or a UFVK - that is the PROTOCOL half (./contract.ts).
 */

import type {
  ApduCommand,
  LedgerDeviceApp,
  LedgerFailure,
  LedgerSigningPhase,
  LedgerZcashDevice,
} from './contract';
import { LedgerError } from './contract';
import { isPopup } from '../../utils/popup-detection';

// ---------------------------------------------------------------------------
// Minimal WebHID surface. lib.dom has no WebHID types and the extension does
// not pull in @types/w3c-web-hid, so only what we use is declared, locally.
// ---------------------------------------------------------------------------

export interface HidInputReportEventLike {
  readonly device?: unknown;
  readonly reportId: number;
  readonly data: DataView;
}

export interface HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  readonly collections?: readonly { usagePage?: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: 'inputreport', listener: (e: HidInputReportEventLike) => void): void;
  removeEventListener(type: 'inputreport', listener: (e: HidInputReportEventLike) => void): void;
}

export interface HidConnectionEventLike {
  readonly device: HidDeviceLike;
}

/** `navigator.hid`, narrowed. */
export interface HidHostLike {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: {
    filters: { vendorId?: number; usagePage?: number }[];
  }): Promise<HidDeviceLike[]>;
  addEventListener(type: 'disconnect', listener: (e: HidConnectionEventLike) => void): void;
  removeEventListener(type: 'disconnect', listener: (e: HidConnectionEventLike) => void): void;
}

// ---------------------------------------------------------------------------
// Constants (vizor transport.rs / mod.rs)
// ---------------------------------------------------------------------------

export const LEDGER_VENDOR_ID = 0x2c97;
/** The APDU interface; excludes the FIDO/U2F interface (0xf1d0). */
export const LEDGER_USAGE_PAGE = 0xffa0;
const LEDGER_CHANNEL = 0x0101;
const LEDGER_TAG = 0x05;
/** WebHID sends the report id separately, so each report is 64 bytes. */
export const HID_PACKET_SIZE = 64;

const ZCASH_CLA = 0xe0;
const BOLOS_CLA = 0xb0;
const INS_GET_APP_AND_VERSION = 0x01;
const INS_OPEN_APP = 0xd8;
const INS_CLOSE_APP = 0xa7;

export const ZCASH_APP_NAME = 'Zcash';
export const DASHBOARD_APP_NAMES: readonly string[] = ['BOLOS', 'OLOS', 'OLOS\0'];

const SW_OK = 0x9000;
const SW_REVIEW_BUSY = 0x6901;
const REVIEW_BUSY_MAX_ATTEMPTS = 3;
const REVIEW_BUSY_RETRY_MS = 200;

export const DEFAULT_TIMINGS = {
  /** vizor SIGNING_STATUS_COOLDOWN: the app's post-signing status screen. */
  cooldownMs: 4_000,
  /** vizor SIGNING_STATUS_POLL_INTERVAL */
  cooldownPollMs: 100,
  /** vizor APP_TRANSITION_TIMEOUT */
  appTransitionTimeoutMs: 10_000,
  /** vizor APP_TRANSITION_POLL_INTERVAL */
  appTransitionPollMs: 200,
  /**
   * A response outstanding this long means the device is waiting for the
   * user. `ApduCommand` carries no "finishes review" flag (and p2 is reused as
   * an action index by the sign APDUs), so the transport infers the review
   * screen from latency instead of guessing from instruction codes.
   */
  reviewHintMs: 500,
} as const;

export type LedgerTimings = { -readonly [K in keyof typeof DEFAULT_TIMINGS]: number };

// ---------------------------------------------------------------------------
// Status words
// ---------------------------------------------------------------------------

interface StatusWordInfo {
  readonly failure: LedgerFailure;
  readonly message: string;
}

/**
 * Every status word vizor classifies (ledger_error_codes.dart
 * `ledgerFailureKindForStatusWord`, texts from apdu.rs `status_word_text`),
 * folded into the contract's LedgerFailure kinds. Anything else is
 * 'protocol_error' with the raw code attached.
 */
export const STATUS_WORDS: ReadonlyMap<number, StatusWordInfo> = new Map<number, StatusWordInfo>([
  // userRejected
  [
    0x6985,
    { failure: 'rejected', message: 'Rejected on the Ledger (or the PCZT was not finalized)' },
  ],
  [0x5501, { failure: 'rejected', message: 'Rejected on the Ledger' }],
  // deviceLocked (the Zcash app aliases 0x6982 to NothingReceived too)
  [0x5515, { failure: 'locked', message: 'Ledger is locked - unlock it and open the Zcash app' }],
  [0x6982, { failure: 'locked', message: 'Ledger is locked - unlock it and open the Zcash app' }],
  [0x5303, { failure: 'locked', message: 'Ledger is locked - unlock it and open the Zcash app' }],
  [0x63c0, { failure: 'locked', message: 'A wrong PIN was entered - unlock your Ledger' }],
  // pinNotSet
  [0x5502, { failure: 'locked', message: 'This Ledger has no PIN set - finish setting it up' }],
  // wrongApp
  [
    0x6e00,
    {
      failure: 'app_not_open',
      message: 'Another app or the dashboard is open - open the Zcash app',
    },
  ],
  [
    0x6d00,
    {
      failure: 'app_not_open',
      message: 'The running Ledger app does not support this command - open the Zcash app',
    },
  ],
  // appNotInstalled
  [0x6807, { failure: 'app_not_open', message: 'The Zcash app is not installed on this Ledger' }],
  // appWrongState / halted
  [
    0xb007,
    {
      failure: 'app_not_open',
      message: 'The Zcash app is in the wrong state - close and reopen it',
    },
  ],
  [0x6faa, { failure: 'app_not_open', message: 'The Zcash app halted - close and reopen it' }],
  // deviceBusy
  [0x6601, { failure: 'busy', message: 'Ledger is busy switching apps - retry shortly' }],
  [
    0x6901,
    { failure: 'busy', message: 'Ledger display is busy starting a review - retry shortly' },
  ],
  // capacityExceeded / host request rejected by the app
  [
    0x6a84,
    {
      failure: 'unsupported_transaction',
      message: 'Ledger ran out of memory for this transaction - try a smaller one',
    },
  ],
  [
    0x6a80,
    {
      failure: 'unsupported_transaction',
      message: 'Ledger rejected the transaction data or key path',
    },
  ],
  // APDU.md: "change output belongs to another account", not a generic state error
  [
    0x6986,
    {
      failure: 'change_to_other_account',
      message: 'the change output does not belong to this account',
    },
  ],
  [
    0x6f01,
    { failure: 'protocol_error', message: 'Zcash app could not parse the transaction version' },
  ],
  [0x6f02, { failure: 'protocol_error', message: 'Zcash app could not parse the transaction' }],
  [0x6b00, { failure: 'protocol_error', message: 'Zcash app rejected the command parameters' }],
  [0x6700, { failure: 'protocol_error', message: 'Zcash app rejected the command length' }],
  // deviceInternalError
  [0x5223, { failure: 'protocol_error', message: 'Ledger returned an internal error' }],
  [0x6f00, { failure: 'protocol_error', message: 'Zcash app reported a technical problem' }],
  [0x6f03, { failure: 'protocol_error', message: 'Ledger random number generator failed' }],
]);

const hex4 = (sw: number) => sw.toString(16).padStart(4, '0');

/** Map a non-0x9000 status word to a LedgerError. */
export function statusWordError(sw: number): LedgerError {
  const info = STATUS_WORDS.get(sw);
  return info
    ? new LedgerError(info.failure, `${info.message} (0x${hex4(sw)})`, sw)
    : new LedgerError('protocol_error', `Ledger returned status 0x${hex4(sw)}`, sw);
}

/**
 * During an app transition these end the wait at once; everything else
 * (0x6601, 0x6901, 0xb007, a vanished device while it re-enumerates) keeps
 * polling. vizor mod.rs `is_terminal_app_transition_error`.
 */
const TERMINAL_TRANSITION_SWS = new Set([
  0x5515, 0x6982, 0x5303, 0x5502, 0x6807, 0x5501, 0x6985, 0x6a80, 0x6e00, 0x6d00,
]);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

type Semver = readonly [number, number, number];

/** Strict `major.minor.patch`; anything else (pre-release tags too) is null. */
export function parseZcashAppVersion(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1, or null when either side is not a strict x.y.z version. */
export function compareZcashAppVersion(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseZcashAppVersion(a);
  const pb = parseZcashAppVersion(b);
  if (!pa || !pb) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) {
      return pa[i]! > pb[i]! ? 1 : -1;
    }
  }
  return 0;
}

/**
 * `version >= min`. An unparsable version is too old (vizor `_atLeast`), which
 * is deliberately stricter than ../capabilities.ts `versionAtLeast`: a
 * "3.9.4-rc1" must not pass a 3.9.4 gate for signing.
 */
export function zcashAppVersionAtLeast(version: string, min: string): boolean {
  const c = compareZcashAppVersion(version, min);
  return c !== null && c >= 0;
}

/**
 * Throw unless the Zcash app is open at `min` or newer - pass one of the
 * contract's MIN_ZCASH_APP_VERSION_* constants.
 */
export function requireZcashApp(app: LedgerDeviceApp, min: string): void {
  if (app.name !== ZCASH_APP_NAME) {
    throw new LedgerError(
      'app_not_open',
      `Open the Zcash app on your Ledger (running: ${app.name})`,
    );
  }
  if (!zcashAppVersionAtLeast(app.version, min)) {
    throw new LedgerError(
      'app_too_old',
      `Update the Ledger Zcash app to ${min} or newer (installed: ${app.version})`,
    );
  }
}

export function isDashboardApp(name: string): boolean {
  return DASHBOARD_APP_NAMES.includes(name);
}

// ---------------------------------------------------------------------------
// APDU + HID framing
// ---------------------------------------------------------------------------

/** `cla ins p1 p2 Lc data` - Lc is always present (vizor build_command). */
export function serializeApdu(cmd: ApduCommand): Uint8Array {
  for (const [k, v] of [
    ['cla', cmd.cla],
    ['ins', cmd.ins],
    ['p1', cmd.p1],
    ['p2', cmd.p2],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new LedgerError('protocol_error', `APDU ${k} is not a byte: ${v}`);
    }
  }
  if (cmd.data.length > 255) {
    throw new LedgerError('protocol_error', `APDU payload exceeds 255 bytes: ${cmd.data.length}`);
  }
  const out = new Uint8Array(5 + cmd.data.length);
  out.set([cmd.cla, cmd.ins, cmd.p1, cmd.p2, cmd.data.length]);
  out.set(cmd.data, 5);
  return out;
}

/** Split an APDU into 64-byte HID reports: `channel tag seq | len(first only) apdu`. */
export function frameApdu(apdu: Uint8Array, channel = LEDGER_CHANNEL): Uint8Array[] {
  const stream = new Uint8Array(apdu.length + 2);
  stream[0] = apdu.length >> 8;
  stream[1] = apdu.length & 0xff;
  stream.set(apdu, 2);
  const chunk = HID_PACKET_SIZE - 5;
  const packets: Uint8Array[] = [];
  for (let seq = 0, off = 0; off < stream.length; seq++, off += chunk) {
    if (seq > 0xffff) {
      throw new LedgerError('protocol_error', 'APDU needs too many HID packets');
    }
    const p = new Uint8Array(HID_PACKET_SIZE);
    p[0] = channel >> 8;
    p[1] = channel & 0xff;
    p[2] = LEDGER_TAG;
    p[3] = seq >> 8;
    p[4] = seq & 0xff;
    p.set(stream.subarray(off, off + chunk), 5);
    packets.push(p);
  }
  return packets;
}

/** Incremental reassembly of one framed response (vizor read_apdu). */
export class HidResponseAssembler {
  private expectedLen: number | undefined;
  private seq = 0;
  private buf: number[] = [];

  constructor(private readonly channel = LEDGER_CHANNEL) {}

  /** Feed one report; returns the full response (data + SW) once complete. */
  push(packet: Uint8Array): Uint8Array | undefined {
    if (packet.length < 5 || (this.seq === 0 && packet.length < 7)) {
      throw new LedgerError('protocol_error', 'Ledger HID response had an incomplete header');
    }
    if (((packet[0]! << 8) | packet[1]!) !== this.channel) {
      throw new LedgerError('protocol_error', 'Ledger HID response used an unexpected channel');
    }
    if (packet[2] !== LEDGER_TAG) {
      throw new LedgerError('protocol_error', 'Ledger HID response used an unexpected tag');
    }
    if (((packet[3]! << 8) | packet[4]!) !== this.seq) {
      throw new LedgerError(
        'protocol_error',
        'Ledger HID response packets arrived out of sequence',
      );
    }
    let start = 5;
    if (this.seq === 0) {
      this.expectedLen = (packet[5]! << 8) | packet[6]!;
      start = 7;
    }
    const expected = this.expectedLen!;
    const take = Math.min(expected - this.buf.length, packet.length - start);
    for (let i = 0; i < take; i++) {
      this.buf.push(packet[start + i]!);
    }
    if (this.buf.length === expected) {
      return Uint8Array.from(this.buf);
    }
    if (take <= 0) {
      throw new LedgerError('protocol_error', 'Ledger HID response packet contained no payload');
    }
    this.seq++;
    return undefined;
  }
}

/** Split `data || sw`. */
export function splitStatusWord(response: Uint8Array): { data: Uint8Array; sw: number } {
  if (response.length < 2) {
    throw new LedgerError(
      'protocol_error',
      'Ledger response was too short to contain a status word',
    );
  }
  const n = response.length;
  return { data: response.slice(0, n - 2), sw: (response[n - 2]! << 8) | response[n - 1]! };
}

/** GET_APP_AND_VERSION: `01 | len name | len version | [len flags]`. */
export function decodeAppAndVersion(data: Uint8Array): LedgerDeviceApp {
  let at = 0;
  const byte = (field: string) => {
    if (at >= data.length) {
      throw new LedgerError('protocol_error', `Ledger app-info response is missing ${field}`);
    }
    return data[at++]!;
  };
  const str = (field: string) => {
    const len = byte(`${field} length`);
    if (at + len > data.length) {
      throw new LedgerError('protocol_error', `Ledger app-info response truncated ${field}`);
    }
    const s = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(at, at + len));
    at += len;
    return s;
  };
  const format = byte('format');
  if (format !== 1) {
    throw new LedgerError(
      'protocol_error',
      `Ledger returned unsupported app-info format ${format}`,
    );
  }
  const name = str('app name');
  const version = str('app version');
  if (at < data.length) {
    const flags = byte('flags length');
    if (at + flags !== data.length) {
      throw new LedgerError('protocol_error', 'Ledger app-info response has malformed flags');
    }
  }
  return { name, version };
}

// ---------------------------------------------------------------------------
// Page context + device selection
// ---------------------------------------------------------------------------

/**
 * Throws 'not_connected' unless this code runs where WebHID works: a document
 * (side panel or tab) that is not the toolbar popup, in a browser with WebHID.
 */
export function assertLedgerPageContext(): HidHostLike {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new LedgerError(
      'not_connected',
      'Ledger needs a page (side panel or tab); the service worker cannot use WebHID',
    );
  }
  if (isPopup()) {
    throw new LedgerError(
      'not_connected',
      'Connect the Ledger from the side panel or a tab; the popup closes during the exchange',
    );
  }
  const hid = (navigator as unknown as { hid?: HidHostLike }).hid;
  if (!hid) {
    throw new LedgerError('not_connected', 'This browser does not support WebHID');
  }
  return hid;
}

function isLedgerApduInterface(d: HidDeviceLike): boolean {
  if (d.vendorId !== LEDGER_VENDOR_ID) {
    return false;
  }
  // Collections are absent on some fakes/older Chromium; do not reject then.
  return !d.collections?.length || d.collections.some(c => c.usagePage === LEDGER_USAGE_PAGE);
}

/**
 * Show the WebHID chooser (MUST run inside a click handler in the side panel or
 * a tab). Granting once lets later `getDevices()` find the Ledger without a
 * gesture, including after the USB re-enumeration an app switch causes.
 */
export async function requestLedgerHidPermission(host?: HidHostLike): Promise<void> {
  const hid = host ?? assertLedgerPageContext();
  let picked: HidDeviceLike[];
  try {
    picked = await hid.requestDevice({
      filters: [{ vendorId: LEDGER_VENDOR_ID, usagePage: LEDGER_USAGE_PAGE }],
    });
  } catch (e) {
    throw new LedgerError('not_connected', `WebHID request failed: ${String(e)}`);
  }
  if (!picked.some(isLedgerApduInterface)) {
    throw new LedgerError('not_connected', 'No Ledger was selected');
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface WebHidLedgerOptions {
  /** Defaults to `navigator.hid` after `assertLedgerPageContext()`. */
  host?: HidHostLike;
  timings?: Partial<LedgerTimings>;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CANCELLED_MESSAGE =
  'Cancelled here. If the Ledger still shows a prompt, answer or reject it on the device.';

function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new LedgerError('cancelled', CANCELLED_MESSAGE));
  }
  if (!signal) {
    return sleep(ms);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new LedgerError('cancelled', CANCELLED_MESSAGE));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

interface PendingRead {
  assembler: HidResponseAssembler;
  resolve: (r: Uint8Array) => void;
  reject: (e: LedgerError) => void;
}

/**
 * One Ledger over WebHID. One operation at a time per instance: any call while
 * another runs - or while a cancelled request's response is still outstanding
 * on the device - throws 'busy'. Use one instance per page.
 */
export class WebHidLedgerDevice implements LedgerZcashDevice {
  private readonly host: HidHostLike;
  private readonly t: LedgerTimings;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private device: HidDeviceLike | undefined;
  private pending: PendingRead | undefined;
  private operating = false;
  /** Set while a cancelled request's response is still owed by the device. */
  private draining: Promise<void> | undefined;
  /** Earliest time the next command may reach the device (post-signing screen). */
  private readyAt = 0;
  private closed = false;

  constructor(opts: WebHidLedgerOptions = {}) {
    this.host = opts.host ?? assertLedgerPageContext();
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.host.addEventListener('disconnect', this.onDisconnect);
  }

  // -- public API ----------------------------------------------------------

  currentApp(): Promise<LedgerDeviceApp> {
    return this.operation(async () => {
      await this.waitCooldown();
      return this.readApp();
    });
  }

  openZcashApp(opts: { signal?: AbortSignal } = {}): Promise<LedgerDeviceApp> {
    const { signal } = opts;
    return this.operation(async () => {
      await this.waitCooldown(signal);
      const current = await this.readApp(signal);
      if (current.name === ZCASH_APP_NAME) {
        return current;
      }
      if (!isDashboardApp(current.name)) {
        this.checkAbort(signal);
        await this.sendAllowingDisconnect(
          { cla: BOLOS_CLA, ins: INS_CLOSE_APP, p1: 0, p2: 0, data: new Uint8Array() },
          signal,
        );
        await this.waitForApp(isDashboardApp, 'the Ledger dashboard', signal);
      }
      this.checkAbort(signal);
      await this.sendAllowingDisconnect(
        {
          cla: ZCASH_CLA,
          ins: INS_OPEN_APP,
          p1: 0,
          p2: 0,
          data: new TextEncoder().encode(ZCASH_APP_NAME),
        },
        signal,
      );
      return this.waitForApp(n => n === ZCASH_APP_NAME, 'the Zcash app', signal);
    });
  }

  exchange(
    plan: ApduCommand[],
    opts: { signal?: AbortSignal; onPhase?: (p: LedgerSigningPhase) => void } = {},
  ): Promise<Uint8Array[]> {
    const { signal, onPhase } = opts;
    const emit = (p: LedgerSigningPhase) => {
      try {
        onPhase?.(p);
      } catch {
        // a UI callback must never break the device exchange
      }
    };
    return this.operation(async () => {
      // Serialize up front: a malformed plan fails before any byte is sent.
      const apdus = plan.map(serializeApdu);
      emit({ phase: 'connecting' });
      this.checkAbort(signal);
      await this.waitCooldown(signal);
      await this.acquire();

      const responses: Uint8Array[] = [];
      let sentAny = false;
      try {
        for (let i = 0; i < apdus.length; i++) {
          this.checkAbort(signal);
          emit({ phase: 'sending', sent: i, total: apdus.length });
          sentAny = true;
          const data = await this.transmit(apdus[i]!, signal, () => emit({ phase: 'review' }));
          responses.push(data);
        }
      } finally {
        // vizor arms the cooldown on every exit of a signing operation
        // (success, failure, cancel). The transport cannot tell a signing
        // plan from any other, so any plan that reached the device arms it.
        if (sentAny) {
          this.armCooldown();
        }
      }
      emit({ phase: 'sending', sent: apdus.length, total: apdus.length });
      emit({ phase: 'done' });
      return responses;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.host.removeEventListener('disconnect', this.onDisconnect);
    this.failPending(new LedgerError('not_connected', 'Ledger transport closed'));
    const d = this.device;
    this.device = undefined;
    if (d) {
      d.removeEventListener('inputreport', this.onInputReport);
      if (d.opened) {
        await d.close().catch(() => undefined);
      }
    }
  }

  // -- operation slot, cooldown, abort ------------------------------------

  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new LedgerError('not_connected', 'Ledger transport closed');
    }
    if (this.operating) {
      throw new LedgerError('busy', 'Another Ledger operation is in progress');
    }
    if (this.draining) {
      throw new LedgerError(
        'busy',
        'The Ledger is still waiting for an answer to a cancelled request - answer or reject it on the device',
      );
    }
    this.operating = true;
    try {
      return await fn();
    } finally {
      this.operating = false;
    }
  }

  private checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new LedgerError('cancelled', CANCELLED_MESSAGE);
    }
  }

  private armCooldown(): void {
    this.readyAt = this.now() + this.t.cooldownMs;
  }

  private async waitCooldown(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.checkAbort(signal);
      const remaining = this.readyAt - this.now();
      if (remaining <= 0) {
        return;
      }
      await abortableSleep(this.sleep, Math.min(remaining, this.t.cooldownPollMs), signal);
    }
  }

  // -- device --------------------------------------------------------------

  private readonly onDisconnect = (e: HidConnectionEventLike) => {
    if (e.device === this.device) {
      this.device.removeEventListener('inputreport', this.onInputReport);
      this.device = undefined;
      this.failPending(new LedgerError('not_connected', 'Ledger disconnected'));
    }
  };

  private readonly onInputReport = (e: HidInputReportEventLike) => {
    const p = this.pending;
    if (!p) {
      return; // nobody asked; a stray report is never a later command's answer
    }
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    try {
      const full = p.assembler.push(bytes);
      if (full) {
        this.pending = undefined;
        p.resolve(full);
      }
    } catch (err) {
      this.pending = undefined;
      p.reject(err instanceof LedgerError ? err : new LedgerError('protocol_error', String(err)));
    }
  };

  private failPending(err: LedgerError): void {
    const p = this.pending;
    this.pending = undefined;
    p?.reject(err);
  }

  /** Current device, re-found via getDevices() after an app switch re-enumerates USB. */
  private async acquire(): Promise<HidDeviceLike> {
    if (this.device?.opened) {
      return this.device;
    }
    let d: HidDeviceLike | undefined;
    try {
      d = (await this.host.getDevices()).find(isLedgerApduInterface);
    } catch (e) {
      throw new LedgerError('not_connected', `WebHID getDevices failed: ${String(e)}`);
    }
    if (!d) {
      throw new LedgerError(
        'not_connected',
        'No Ledger found - connect and unlock it, and grant access from the side panel or a tab',
      );
    }
    if (!d.opened) {
      try {
        await d.open();
      } catch (e) {
        throw new LedgerError(
          'not_connected',
          `Could not open the Ledger (is another app or tab using it?): ${String(e)}`,
        );
      }
    }
    if (this.device && this.device !== d) {
      this.device.removeEventListener('inputreport', this.onInputReport);
    }
    if (this.device !== d) {
      d.addEventListener('inputreport', this.onInputReport);
    }
    this.device = d;
    return d;
  }

  /** Write one APDU; the response is wrapped so awaiting the write does not await the answer. */
  private async write(apdu: Uint8Array): Promise<{ response: Promise<Uint8Array> }> {
    const d = await this.acquire();
    if (this.pending) {
      throw new LedgerError('busy', 'A Ledger response is still outstanding');
    }
    const response = new Promise<Uint8Array>((resolve, reject) => {
      this.pending = { assembler: new HidResponseAssembler(), resolve, reject };
    });
    // A request that never completes writing has no response to wait for.
    response.catch(() => undefined);
    try {
      for (const packet of frameApdu(apdu)) {
        await d.sendReport(0, packet);
      }
    } catch (e) {
      this.failPending(new LedgerError('not_connected', `Write to Ledger failed: ${String(e)}`));
      this.device = undefined;
      d.removeEventListener('inputreport', this.onInputReport);
      throw new LedgerError('not_connected', `Write to Ledger failed: ${String(e)}`);
    }
    return { response };
  }

  /**
   * Send one APDU and return its data; non-0x9000 raises. Retries 0x6901
   * (vizor retry_review_busy: SDK 1.37 can answer it before the app sees the
   * APDU, so a replay is safe).
   */
  private async transmit(
    apdu: Uint8Array,
    signal?: AbortSignal,
    onSlow?: () => void,
  ): Promise<Uint8Array> {
    for (let attempt = 1; ; attempt++) {
      const { response } = await this.write(apdu);
      const full = await this.awaitResponse(response, signal, onSlow);
      const { data, sw } = splitStatusWord(full);
      if (sw === SW_OK) {
        return data;
      }
      if (sw === SW_REVIEW_BUSY && attempt < REVIEW_BUSY_MAX_ATTEMPTS) {
        await abortableSleep(this.sleep, REVIEW_BUSY_RETRY_MS, signal);
        continue;
      }
      throw statusWordError(sw);
    }
  }

  /**
   * Wait for a written request's response. On abort the caller gets
   * 'cancelled' at once, but the response is still owed: the instance stays
   * busy until it arrives (or the device goes away), so it can never be read
   * as the answer to a later command.
   */
  private awaitResponse(
    response: Promise<Uint8Array>,
    signal?: AbortSignal,
    onSlow?: () => void,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const slow = onSlow ? setTimeout(onSlow, this.t.reviewHintMs) : undefined;
      const finish = () => {
        settled = true;
        if (slow !== undefined) {
          clearTimeout(slow);
        }
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) {
          return;
        }
        finish();
        this.draining = response.then(
          () => undefined,
          () => undefined,
        );
        void this.draining.then(() => {
          this.draining = undefined;
          this.armCooldown();
        });
        reject(new LedgerError('cancelled', CANCELLED_MESSAGE));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      response.then(
        r => {
          if (!settled) {
            finish();
            resolve(r);
          }
        },
        (e: unknown) => {
          if (!settled) {
            finish();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      );
    });
  }

  private async readApp(signal?: AbortSignal): Promise<LedgerDeviceApp> {
    const data = await this.transmit(
      serializeApdu({
        cla: BOLOS_CLA,
        ins: INS_GET_APP_AND_VERSION,
        p1: 0,
        p2: 0,
        data: new Uint8Array(),
      }),
      signal,
    );
    return decodeAppAndVersion(data);
  }

  /**
   * App transitions may detach HID before the status word reaches the host.
   * Once the request is fully written, a lost connection is an indeterminate
   * transition; the caller polls the running app next (vizor
   * exchange_allowing_disconnect). A status word, if one arrives, still counts
   * (0x6807 not installed, 0x5501 rejected, ...).
   */
  private async sendAllowingDisconnect(cmd: ApduCommand, signal?: AbortSignal): Promise<void> {
    const { response } = await this.write(serializeApdu(cmd));
    let full: Uint8Array;
    try {
      full = await this.awaitResponse(response, signal);
    } catch (e) {
      if (e instanceof LedgerError && e.failure === 'not_connected') {
        return;
      }
      throw e;
    }
    const { sw } = splitStatusWord(full);
    if (sw !== SW_OK) {
      throw statusWordError(sw);
    }
  }

  private async waitForApp(
    matches: (name: string) => boolean,
    expected: string,
    signal?: AbortSignal,
  ): Promise<LedgerDeviceApp> {
    const deadline = this.now() + this.t.appTransitionTimeoutMs;
    for (;;) {
      this.checkAbort(signal);
      let observation: string;
      try {
        const app = await this.readApp(signal);
        if (matches(app.name)) {
          return app;
        }
        observation = `the device reported ${app.name} ${app.version}`;
      } catch (e) {
        if (!(e instanceof LedgerError) || e.failure === 'cancelled') {
          throw e;
        }
        if (e.statusWord !== undefined && TERMINAL_TRANSITION_SWS.has(e.statusWord)) {
          throw e;
        }
        observation = e.message;
      }
      if (this.now() >= deadline) {
        throw new LedgerError(
          'app_not_open',
          `Ledger did not reach ${expected} after switching apps: ${observation}`,
        );
      }
      await abortableSleep(this.sleep, this.t.appTransitionPollMs, signal);
    }
  }
}

/** Page-context factory: asserts the context, then binds to navigator.hid. */
export function createWebHidLedgerDevice(
  opts: Omit<WebHidLedgerOptions, 'host'> = {},
): WebHidLedgerDevice {
  return new WebHidLedgerDevice({ ...opts, host: assertLedgerPageContext() });
}
