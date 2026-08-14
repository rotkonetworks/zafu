/**
 * Speculos harness - a real Ledger device, emulated, for `transparent.test.ts`.
 *
 * TEST-ONLY. Nothing in the extension imports this; it exists so the transparent
 * wire format is checked against a device parser instead of against our own
 * arithmetic. It talks to Speculos over its HTTP API (`POST /apdu`, `/events`,
 * `/button/*`) rather than the raw APDU socket, so it needs no node builtins and
 * runs under vitest's jsdom environment with plain `fetch`.
 *
 * It deliberately does NOT go through @ledgerhq/device-management-kit: DMK's
 * only transport here is WebHID, which needs a browser and a user gesture. So
 * this harness proves our ENCODERS against the device parser, byte for byte; it
 * does not exercise DMK's own APDU sequencing. That gap is stated in the test.
 *
 * BRINGING A DEVICE UP (about a minute, all in a scratch dir):
 *
 *   git clone https://github.com/LedgerHQ/app-zcash.git
 *   cd app-zcash && git checkout "nanos+_1.6.1_3.6.0_sdk_v26.3.0"
 *   docker run --rm -v "$PWD:/app" -w /app \
 *     ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest \
 *     bash -lc 'cargo ledger build nanosplus'
 *   docker run -d --name spec --network=host \
 *     -v "$PWD/target/nanosplus/release:/speculos/apps" \
 *     ghcr.io/ledgerhq/speculos:latest --model nanosp --display headless \
 *     --api-port 5000 --apdu-port 40000 --seed "<24 words>" /speculos/apps/zcash
 *
 * Then:  LEDGER_SPECULOS=1 pnpm exec vitest run src/ledger/transparent.test.ts
 *
 * With LEDGER_SPECULOS unset, or set but unreachable, the device suite SKIPS.
 * It must never pass without a device having answered.
 */

// The extension tsconfig carries no node types (it targets a browser). Reading
// one env var does not justify pulling them in.
declare const process: { env?: Record<string, string | undefined> } | undefined;

function env(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.[name];
}

export const ZCASH_CLA = 0xe0;
export const INS = {
  GET_WALLET_PUBLIC_KEY: 0x40,
  GET_TRUSTED_INPUT: 0x42,
  HASH_INPUT_START: 0x44,
  HASH_SIGN: 0x48,
  HASH_INPUT_FINALIZE_FULL: 0x4a,
  GET_FIRMWARE_VERSION: 0xc4,
} as const;

export interface ApduResponse {
  readonly data: Uint8Array;
  /** status word, e.g. 0x9000 */
  readonly sw: number;
}

const SW_OK = 0x9000;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class SpeculosDevice {
  constructor(private readonly api: string) {}

  /** Send a raw APDU and split off the status word. */
  async apdu(bytes: Uint8Array): Promise<ApduResponse> {
    if (env('LEDGER_SPECULOS_DEBUG')) {
      console.error(`> ${toHex(bytes)}`);
    }
    const res = await fetch(`${this.api}/apdu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: toHex(bytes) }),
    });
    if (!res.ok) {
      throw new Error(`speculos /apdu returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: string; error?: string };
    if (typeof body.data !== 'string') {
      throw new Error(`speculos /apdu: ${body.error ?? 'no data in response'}`);
    }
    if (env('LEDGER_SPECULOS_DEBUG')) {
      console.error(`< ${body.data}`);
    }
    const all = fromHex(body.data);
    if (all.length < 2) {
      throw new Error('speculos /apdu: response shorter than a status word');
    }
    return {
      data: all.subarray(0, all.length - 2),
      sw: (all[all.length - 2]! << 8) | all[all.length - 1]!,
    };
  }

  /** Send a CLA/INS/P1/P2 + data APDU (single frame, data <= 255 bytes). */
  send(
    ins: number,
    p1: number,
    p2: number,
    data: Uint8Array = new Uint8Array(),
  ): Promise<ApduResponse> {
    if (data.length > 255) {
      throw new Error(`apdu data ${data.length} > 255 bytes - chunk it`);
    }
    const frame = new Uint8Array(5 + data.length);
    frame.set([ZCASH_CLA, ins, p1, p2, data.length], 0);
    frame.set(data, 5);
    return this.apdu(frame);
  }

  /** Send, and throw on any status word other than 9000. */
  async sendOk(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
    what = 'apdu',
  ): Promise<Uint8Array> {
    const { data: out, sw } = await this.send(ins, p1, p2, data);
    if (sw !== SW_OK) {
      throw new Error(`${what}: device returned ${sw.toString(16).padStart(4, '0')}`);
    }
    return out;
  }

  /** The text currently on the device screen, flattened. */
  async screen(): Promise<string> {
    const res = await fetch(`${this.api}/events?currentscreenonly=true`);
    const body = (await res.json()) as { events?: { text?: string }[] };
    return (body.events ?? []).map(e => e.text ?? '').join(' ');
  }

  /**
   * Dismiss the modal status screen the app parks on after a signature
   * ("Transaction signed") and wait until it is back on the idle dashboard.
   *
   * Not cosmetic: while that screen is up the app stops servicing APDUs, so the
   * next flow's first command blocks forever. Only ever presses `both`, which
   * dismisses a status and re-centres the dashboard - never `right`, which
   * would walk into "Quit app" and take the device out from under the test.
   */
  async settle(attempts = 40): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if ((await this.screen()).toLowerCase().includes('app is ready')) {
        return;
      }
      await this.press('both');
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('speculos: device did not return to the dashboard');
  }

  async press(button: 'left' | 'right' | 'both'): Promise<void> {
    await fetch(`${this.api}/button/${button}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release' }),
    });
  }

  /**
   * Run `op` while walking the on-device review and approving it.
   *
   * Presses right through the review pages and both on the confirm page, and
   * stops the moment `op` settles - important, because pressing on past the
   * confirmation walks into the dashboard and quits the app, which breaks any
   * following APDU.
   */
  async approving<T>(op: () => Promise<T>): Promise<{ result: T; screens: string[] }> {
    const screens: string[] = [];
    let done = false;
    const walk = (async () => {
      // small head start so the device has drawn the first review page
      await new Promise(r => setTimeout(r, 200));
      while (!done) {
        const text = await this.screen();
        if (text && screens[screens.length - 1] !== text) {
          screens.push(text);
        }
        if (done) {
          break;
        }
        const low = text.toLowerCase();
        await this.press(
          low.includes('sign transaction') || low.includes('approve') ? 'both' : 'right',
        );
        await new Promise(r => setTimeout(r, 120));
      }
    })();

    try {
      const result = await op();
      return { result, screens };
    } finally {
      done = true;
      await walk;
    }
  }
}

/**
 * Connect to a Speculos instance, or return `null` if none is configured or
 * reachable. Callers must SKIP on `null` - never treat it as a pass.
 *
 * `LEDGER_SPECULOS`     enables the device suite; may be a base URL.
 * `LEDGER_SPECULOS_API` overrides the API base (default http://127.0.0.1:5000).
 */
export async function probeSpeculos(): Promise<SpeculosDevice | null> {
  const enabled = env('LEDGER_SPECULOS');
  if (!enabled) {
    return null;
  }
  const api =
    env('LEDGER_SPECULOS_API') ?? (enabled.startsWith('http') ? enabled : 'http://127.0.0.1:5000');
  const device = new SpeculosDevice(api);
  try {
    const { data, sw } = await device.send(INS.GET_FIRMWARE_VERSION, 0, 0);
    if (sw !== SW_OK || data.length < 5) {
      return null;
    }
    return device;
  } catch {
    return null;
  }
}

/** `major.minor.patch` from the GET_FIRMWARE_VERSION (0xC4) response. */
export function parseAppVersion(response: Uint8Array): string {
  // 0x38 0x30 major minor patch sdkMajor sdkMinor apiLevel
  if (response.length < 5) {
    throw new Error('short GET_FIRMWARE_VERSION response');
  }
  return `${response[2]}.${response[3]}.${response[4]}`;
}

/** Encode a BIP32 path the way the device expects it: count || u32 BE each. */
export function encodeBip32Path(path: string): Uint8Array {
  const parts = path.split('/').filter(p => p.length > 0);
  const out = new Uint8Array(1 + parts.length * 4);
  out[0] = parts.length;
  parts.forEach((p, i) => {
    const hardened = p.endsWith("'") || p.endsWith('h');
    const n = (Number.parseInt(p.replace(/['h]$/, ''), 10) >>> 0) + (hardened ? 0x80000000 : 0);
    const at = 1 + i * 4;
    out[at] = (n >>> 24) & 0xff;
    out[at + 1] = (n >>> 16) & 0xff;
    out[at + 2] = (n >>> 8) & 0xff;
    out[at + 3] = n & 0xff;
  });
  return out;
}

/** Send a payload over several APDUs: first frame P1=0x00, rest P1=0x80. */
export async function sendChunked(
  device: SpeculosDevice,
  ins: number,
  payload: Uint8Array,
  what: string,
): Promise<ApduResponse> {
  let last: ApduResponse | undefined;
  for (let at = 0; at < payload.length; at += 255) {
    const chunk = payload.subarray(at, Math.min(at + 255, payload.length));
    last = await device.send(ins, at === 0 ? 0x00 : 0x80, 0x00, chunk);
    if (last.sw !== SW_OK) {
      return last;
    }
  }
  if (!last) {
    throw new Error(`${what}: empty payload`);
  }
  return last;
}
