/**
 * Speculos transport for the Ledger ZCASH app (3.9.x, Orchard + Ironwood).
 *
 * TEST-ONLY. Nothing in the extension imports this. It implements the
 * contract's `LedgerZcashDevice` over Speculos's HTTP API (`POST /apdu`,
 * `GET /events`, `POST /button/*`) so the SAME protocol code that drives a real
 * device over WebHID can be driven against the emulated Zcash app, byte for
 * byte. Bring an emulator up with `apps/extension/scripts/ledger-speculos.sh`.
 *
 * Where it deliberately differs from the WebHID transport:
 *
 *  - `openZcashApp()` never sends the BOLOS open-app APDU (E0 D8). Speculos
 *    boots straight into the app ELF and has no dashboard, so the running app
 *    would answer 0x6D00. It checks the running app instead and throws
 *    'app_not_open' when it is not Zcash.
 *  - It can walk the on-device review for the test (approve or reject) through
 *    the screen/button API, and waits for the post-review status screen to
 *    clear the way a person would, before the next operation.
 *  - It knows which commands block on a review (`awaitsReview`). The contract's
 *    `ApduCommand` carries no such flag, so a transport has to infer it from
 *    CLA/INS/P1/P2. That is protocol knowledge leaking into the transport; it
 *    is flagged in the cross-review.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0),
 * modified: status-word table and app-info decoder (rust/src/wallet/ledger/
 * apdu.rs, transport.rs), the 0x6901 review-busy retry, the loopback-only
 * Speculos URL rule, and the approval walker (rust/examples/
 * ledger_zcash_speculos_poc.rs `automate_approval`).
 */

import { SpeculosDevice } from '../speculos';
import {
  LedgerError,
  type ApduCommand,
  type LedgerDeviceApp,
  type LedgerFailure,
  type LedgerSigningPhase,
  type LedgerZcashDevice,
} from './contract';

export const ZCASH_CLA = 0xe0;
export const BOLOS_CLA = 0xb0;
export const INS_GET_APP_AND_VERSION = 0x01;
export const INS_GET_VK = 0x50;
export const INS_GET_SHIELD_ADDR = 0x51;
export const INS_PCZT_ORCHARD_ACTION = 0x56;
export const INS_PCZT_IRONWOOD_ACTION = 0x58;

export const SW_OK = 0x9000;
/** SDK 1.37+: an APDU arrived while a review was being drawn. Safe to replay. */
export const SW_REVIEW_BUSY = 0x6901;
const REVIEW_BUSY_MAX_ATTEMPTS = 3;

/** The minimal Speculos surface this transport needs. `SpeculosDevice` has it. */
export interface SpeculosDriver {
  apdu(bytes: Uint8Array): Promise<{ data: Uint8Array; sw: number }>;
  screen(): Promise<string>;
  press(button: 'left' | 'right' | 'both'): Promise<void>;
}

/** What the harness does when a command puts a review on screen. */
export type ReviewDecision = 'approve' | 'reject' | 'manual';

export interface SpeculosZcashDeviceOptions {
  /** Default 'approve'. 'manual' leaves the review to a person on the Speculos UI. */
  decision?: ReviewDecision;
  /** Screen text of the idle app, captured before any APDU. See `connect`. */
  idleScreen?: string;
  /** Upper bound on waiting for the post-review status screen to clear. Default 10000. */
  settleTimeoutMs?: number;
  /** Delay between 0x6901 retries. Default 200 (vizor). */
  reviewBusyRetryMs?: number;
  /** Screen poll interval for the review walker. Default 150 (vizor). */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** `[cla, ins, p1, p2, lc] || data`. Short APDUs only, as the Zcash app takes. */
export function serializeApdu(cmd: ApduCommand): Uint8Array {
  if (cmd.data.length > 255) {
    throw new LedgerError('protocol_error', `APDU payload ${cmd.data.length} > 255 bytes`);
  }
  for (const [name, v] of [
    ['cla', cmd.cla],
    ['ins', cmd.ins],
    ['p1', cmd.p1],
    ['p2', cmd.p2],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new LedgerError('protocol_error', `APDU ${name} out of range: ${v}`);
    }
  }
  const out = new Uint8Array(5 + cmd.data.length);
  out.set([cmd.cla, cmd.ins, cmd.p1, cmd.p2, cmd.data.length], 0);
  out.set(cmd.data, 5);
  return out;
}

/**
 * Decode the BOLOS GET_APP_AND_VERSION (B0 01) answer:
 * format(=1) || len || name || len || version [|| flagsLen || flags].
 */
export function parseAppAndVersion(data: Uint8Array): LedgerDeviceApp {
  let at = 0;
  const byte = (field: string): number => {
    const b = data[at];
    if (b === undefined) {
      throw new LedgerError('protocol_error', `app-info response is missing ${field}`);
    }
    at += 1;
    return b;
  };
  const str = (field: string): string => {
    const len = byte(`${field} length`);
    if (at + len > data.length) {
      throw new LedgerError('protocol_error', `app-info response truncated ${field}`);
    }
    const s = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(at, at + len));
    at += len;
    return s;
  };
  const format = byte('format');
  if (format !== 1) {
    throw new LedgerError('protocol_error', `unsupported app-info format ${format}`);
  }
  const name = str('app name');
  const version = str('app version');
  if (at < data.length) {
    const flagsLen = byte('flags length');
    if (at + flagsLen !== data.length) {
      throw new LedgerError('protocol_error', 'app-info response has malformed flags');
    }
  }
  return { name, version };
}

/**
 * Status word -> contract failure kind. The kinds must stay distinct: the UI
 * tells the user what to DO for each (vizor ledger_error_codes.dart).
 */
export function statusWordFailure(sw: number): LedgerFailure {
  switch (sw) {
    // the Zcash app aliases 0x6982 to SecurityStatusNotSatisfied and NothingReceived
    case 0x5515:
    case 0x6982:
    case 0x5303:
    case 0x63c0:
    case 0x5502:
      return 'locked';
    case 0x5501:
    case 0x6985:
      return 'rejected';
    case 0x6601: // switching apps
    case SW_REVIEW_BUSY: // only after the bounded retry gave up
      return 'busy';
    case 0x6807: // app not installed
    case 0x6d00: // running app does not know the INS
    case 0x6e00: // running app does not know the CLA (dashboard / other app)
    case 0x6e01:
    case 0x6511:
      return 'app_not_open';
    case 0x6a84: // out of memory for this transaction
      return 'unsupported_transaction';
    case 0x6986: // change output belongs to another account (APDU.md)
      return 'change_to_other_account';
    default:
      // 0x6a80 0x6b00 0x6700 0x6f0x 0x6faa 0xb007 and anything unknown
      return 'protocol_error';
  }
}

/** Human text for a status word, for diagnostics only (never user copy). */
export function statusWordText(sw: number): string {
  const known: Record<number, string> = {
    0x5515: 'device is locked',
    0x6982: 'device is locked',
    0x5303: 'device is locked',
    0x63c0: 'wrong PIN entered',
    0x5501: 'rejected on the device',
    0x6985: 'rejected on the device, or the PCZT was not finalized',
    0x5502: 'PIN is not set',
    0x6601: 'device is switching apps',
    0x6700: 'wrong command length',
    0x6807: 'Zcash app is not installed',
    0x6901: 'device was still drawing a review',
    0x6986: 'change output does not belong to the spending account',
    0x6a80: 'app rejected the PCZT data or key path',
    0x6a84: 'app ran out of memory for this transaction',
    0x6b00: 'wrong P1/P2',
    0x6d00: 'running app does not support this command',
    0x6e00: 'running app does not support this command class',
    0x6f00: 'app reported a technical problem',
    0x6f01: 'app could not parse the transaction version',
    0x6f02: 'app could not parse the transaction',
    0x6f03: 'random number generator failed',
    0x6faa: 'app halted; close and reopen it',
    0xb007: 'app is in the wrong state; close and reopen it',
  };
  const hex = sw.toString(16).padStart(4, '0');
  return `ledger_status_${hex}: ${known[sw] ?? 'unrecognised status'}`;
}

/** Semver-ish compare of `major.minor.patch`; non-numeric parts sort as 0. */
export function compareAppVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Does this command block until the user reviews it on the device?
 * UFVK export (50/P1 00), address display (51/P1 01), and the packet that
 * finishes the PCZT (56 or 58 with P2 01 on the last packet, P1 01).
 */
export function awaitsReview(cmd: ApduCommand): boolean {
  if (cmd.cla !== ZCASH_CLA) {
    return false;
  }
  if (cmd.ins === INS_GET_VK) {
    return cmd.p1 === 0x00;
  }
  if (cmd.ins === INS_GET_SHIELD_ADDR) {
    return cmd.p1 === 0x01;
  }
  if (cmd.ins === INS_PCZT_ORCHARD_ACTION || cmd.ins === INS_PCZT_IRONWOOD_ACTION) {
    // a single-packet command is sent with P1 0x00, so accept both
    return cmd.p2 === 0x01 && (cmd.p1 === 0x01 || cmd.p1 === 0x00);
  }
  return false;
}

/**
 * Only a loopback IP origin with an explicit port (vizor: the emulator holds a
 * seed; its API must never be reached over the LAN or through a hostname).
 */
export function parseSpeculosUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SPECULOS_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new Error('SPECULOS_URL must use plain http');
  }
  if (url.username || url.password) {
    throw new Error('SPECULOS_URL must not carry credentials');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('SPECULOS_URL must be an origin only, e.g. http://127.0.0.1:5000');
  }
  const host = url.hostname;
  const loopback = /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
  if (!loopback) {
    throw new Error('SPECULOS_URL must use a loopback IP address, not a hostname');
  }
  if (!url.port) {
    throw new Error('SPECULOS_URL must include an explicit port');
  }
  return `${url.protocol}//${url.host}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LedgerError('cancelled', 'operation cancelled by the host');
  }
}

/**
 * Walks one on-device review. Presses nothing until review text is on screen,
 * so it can never walk the idle app into "Quit". Returns once `stop()` is
 * called or it has pressed the final button.
 */
class ReviewWalker {
  private done = false;
  private readonly run: Promise<boolean>;
  readonly screens: string[] = [];

  constructor(
    private readonly driver: SpeculosDriver,
    private readonly decision: 'approve' | 'reject',
    private readonly pollMs: number,
  ) {
    this.run = this.walk();
  }

  private async walk(): Promise<boolean> {
    let started = false;
    let pressedFinal = false;
    // bounded: a review that never resolves is a test failure, not a hang
    for (let i = 0; i < 2000 && !this.done; i++) {
      let text: string;
      try {
        text = await this.driver.screen();
      } catch {
        await sleep(this.pollMs);
        continue;
      }
      if (text && this.screens[this.screens.length - 1] !== text) {
        this.screens.push(text);
      }
      const low = text.toLowerCase();
      // vizor's gate, exactly: status screens ("Address verified", "...
      // cancelled") must NOT count, or a press on them walks into "Quit app"
      if (/review|export|viewing key/.test(low)) {
        started = true;
      }
      if (started && !this.done) {
        const isApprove = /approve|accept|confirm|sign transaction/.test(low);
        const isReject = /reject|cancel/.test(low);
        const target = this.decision === 'approve' ? isApprove : isReject;
        if (target) {
          // A press that lands mid-redraw is sometimes dropped by the emulator,
          // so keep polling and re-press only while the same page is still up.
          await this.driver.press('both');
          pressedFinal = true;
        } else if (pressedFinal) {
          // the review is over (status or idle screen): never press again
          return true;
        } else {
          await this.driver.press('right');
        }
      }
      await sleep(pressedFinal ? Math.max(this.pollMs, 400) : this.pollMs);
    }
    return pressedFinal;
  }

  async stop(): Promise<boolean> {
    this.done = true;
    return this.run;
  }
}

export class SpeculosZcashDevice implements LedgerZcashDevice {
  private inFlight = false;
  private readonly decision: ReviewDecision;
  private readonly settleTimeoutMs: number;
  private readonly reviewBusyRetryMs: number;
  private readonly pollMs: number;
  /** Screens seen during the last walked review, for assertions. */
  lastReviewScreens: string[] = [];

  constructor(
    private readonly driver: SpeculosDriver,
    private readonly options: SpeculosZcashDeviceOptions = {},
  ) {
    this.decision = options.decision ?? 'approve';
    this.settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
    this.reviewBusyRetryMs = options.reviewBusyRetryMs ?? 200;
    this.pollMs = options.pollMs ?? 150;
  }

  /** Connect to a running Speculos. Captures the idle screen before any APDU. */
  static async connect(
    rawUrl: string,
    options: Omit<SpeculosZcashDeviceOptions, 'idleScreen'> = {},
  ): Promise<SpeculosZcashDevice> {
    const driver = new SpeculosDevice(parseSpeculosUrl(rawUrl));
    const idleScreen = await driver.screen();
    return new SpeculosZcashDevice(driver, { ...options, idleScreen });
  }

  /** Change what the harness does at the next review. */
  withDecision(decision: ReviewDecision): SpeculosZcashDevice {
    return new SpeculosZcashDevice(this.driver, { ...this.options, decision });
  }

  async currentApp(): Promise<LedgerDeviceApp> {
    const data = await this.sendOne({
      cla: BOLOS_CLA,
      ins: INS_GET_APP_AND_VERSION,
      p1: 0,
      p2: 0,
      data: new Uint8Array(),
    });
    return parseAppAndVersion(data);
  }

  async openZcashApp(opts?: { signal?: AbortSignal }): Promise<LedgerDeviceApp> {
    throwIfAborted(opts?.signal);
    const app = await this.currentApp();
    if (app.name !== 'Zcash') {
      // Speculos has no dashboard to open an app from.
      throw new LedgerError('app_not_open', `Speculos is running "${app.name}", not Zcash`);
    }
    return app;
  }

  async exchange(
    plan: ApduCommand[],
    opts?: { signal?: AbortSignal; onPhase?: (p: LedgerSigningPhase) => void },
  ): Promise<Uint8Array[]> {
    if (this.inFlight) {
      throw new LedgerError('busy', 'another Ledger operation is running');
    }
    this.inFlight = true;
    let reviewed = false;
    try {
      const responses: Uint8Array[] = [];
      for (let i = 0; i < plan.length; i++) {
        throwIfAborted(opts?.signal);
        const cmd = plan[i]!;
        opts?.onPhase?.({ phase: 'sending', sent: i, total: plan.length });
        if (awaitsReview(cmd)) {
          reviewed = true;
          // before the exchange: its response only comes after the review
          opts?.onPhase?.({ phase: 'review' });
          responses.push(await this.sendReviewed(cmd));
        } else {
          responses.push(await this.sendOne(cmd));
        }
      }
      opts?.onPhase?.({ phase: 'done' });
      return responses;
    } finally {
      try {
        // also after a rejection: the "cancelled" status screen blocks APDUs too
        if (reviewed) {
          await this.settle();
        }
      } finally {
        this.inFlight = false;
      }
    }
  }

  async close(): Promise<void> {
    // HTTP is connectionless; nothing to release.
  }

  private async sendReviewed(cmd: ApduCommand): Promise<Uint8Array> {
    if (this.decision === 'manual') {
      return this.sendOne(cmd);
    }
    // a previous review's status screen may still be up; the app would not
    // service this APDU and the walker would read the stale screen
    await this.settle();
    const walker = new ReviewWalker(this.driver, this.decision, this.pollMs);
    try {
      return await this.sendOne(cmd);
    } finally {
      await walker.stop();
      this.lastReviewScreens = walker.screens;
    }
  }

  /** One APDU; 0x6901 is replayed (bounded), any other non-9000 is a LedgerError. */
  private async sendOne(cmd: ApduCommand): Promise<Uint8Array> {
    const bytes = serializeApdu(cmd);
    for (let attempt = 1; ; attempt++) {
      let res: { data: Uint8Array; sw: number };
      try {
        res = await this.driver.apdu(bytes);
      } catch (e) {
        throw new LedgerError(
          'not_connected',
          `Speculos unreachable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (res.sw === SW_REVIEW_BUSY && attempt < REVIEW_BUSY_MAX_ATTEMPTS) {
        await sleep(this.reviewBusyRetryMs);
        continue;
      }
      if (res.sw !== SW_OK) {
        throw new LedgerError(statusWordFailure(res.sw), statusWordText(res.sw), res.sw);
      }
      return res.data;
    }
  }

  /**
   * Wait for the post-review status screen ("key exported", "transaction
   * signed") to clear. While it is up the app does not service APDUs, so the
   * next operation's first command would hang. Never presses a button.
   */
  private async settle(): Promise<void> {
    const deadline = Date.now() + this.settleTimeoutMs;
    const idle = this.options.idleScreen;
    while (Date.now() < deadline) {
      if (idle !== undefined) {
        try {
          if ((await this.driver.screen()) === idle) {
            return;
          }
        } catch {
          // keep waiting
        }
      }
      await sleep(this.pollMs);
    }
  }
}
