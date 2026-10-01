/**
 * Ledger Zcash app (3.9.4+) against Speculos, through the contract's
 * `LedgerZcashDevice` (./speculos-device.ts).
 *
 * SKIPPED unless SPECULOS_URL is set. When it IS set the emulator must answer:
 * an unreachable URL fails the suite rather than skipping it, so a green run
 * always means a device answered.
 *
 *   apps/extension/scripts/ledger-speculos.sh build
 *   apps/extension/scripts/ledger-speculos.sh test
 *
 * or, against an emulator you started yourself (default Speculos seed):
 *
 *   SPECULOS_URL=http://127.0.0.1:5000 pnpm exec vitest run src/ledger/zcash-app/speculos.e2e.test.ts
 *
 * SPECULOS_SEED overrides the mnemonic used for the software cross-check; set
 * it to `unknown` to skip that check when the emulator runs a custom seed.
 *
 * What runs where:
 *  - app detection, open-app, UFVK export (accounts 0 and 1), rejection and
 *    busy handling: always, against the device, with a harness-local reference
 *    UFVK plan (vizor apdu.rs `ufvk_commands`), so it does not depend on the
 *    protocol wasm.
 *  - the same export through the real PROTOCOL wrapper (./protocol.ts): only
 *    once that module exists on this branch.
 *  - PCZT signing round trip: only once the vendored wasm has `ledger_*`
 *    exports, ./protocol.ts exists, and a fixture PCZT is supplied.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0),
 * modified: the UFVK APDU layout and chunk reassembly rules.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LedgerError,
  MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS,
  type ApduCommand,
  type LedgerSigningPhase,
  type LedgerZcashProtocol,
} from './contract';
import { SpeculosZcashDevice, compareAppVersions } from './speculos-device';
import { createLedgerZcashProtocol, type LedgerWasmExports } from './protocol';

declare const process: { env?: Record<string, string | undefined> } | undefined;
const env = (name: string) => (typeof process === 'undefined' ? undefined : process.env?.[name]);

const SPECULOS_URL = env('SPECULOS_URL');
/** Speculos's built-in default seed (used when started without --seed). */
const SPECULOS_DEFAULT_SEED =
  'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin';
const SEED = env('SPECULOS_SEED') ?? SPECULOS_DEFAULT_SEED;

// ---------------------------------------------------------------------------
// reference UFVK plan (independent of the protocol wasm)

function path(parts: number[]): number[] {
  const out = [parts.length];
  for (const p of parts) {
    out.push((p >>> 24) & 0xff, (p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff);
  }
  return out;
}

const H = 0x80000000;

/** GET_VK first packet: orchard m/32'/133'/a' || transparent m/44'/133'/a'. */
function ufvkFirst(account: number): ApduCommand {
  const a = (H | account) >>> 0;
  return {
    cla: 0xe0,
    ins: 0x50,
    p1: 0x00,
    p2: 0x00,
    data: Uint8Array.from([...path([H | 32, H | 133, a]), ...path([H | 44, H | 133, a])]),
  };
}
const UFVK_CONTINUE: ApduCommand = {
  cla: 0xe0,
  ins: 0x50,
  p1: 0x80,
  p2: 0x00,
  data: new Uint8Array(),
};

/**
 * Export with the continuation count taken from the declared length, never a
 * fixed count: the app does not answer a continuation past the end (observed
 * on 3.9.4 in Speculos), so a surplus one desyncs the transport.
 */
async function exportUfvk(dev: SpeculosZcashDevice, account: number): Promise<string> {
  const [first] = await dev.exchange([ufvkFirst(account)]);
  const chunks = [first!];
  const declared = 2 + ((first![0]! << 8) | first![1]!);
  expect(declared).toBeLessThan(8 * 1024);
  let have = first!.length;
  while (have < declared) {
    const [next] = await dev.exchange([UFVK_CONTINUE]);
    expect(next!.length).toBeGreaterThan(0);
    chunks.push(next!);
    have += next!.length;
  }
  expect(have).toBe(declared);
  const all = new Uint8Array(have);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all.subarray(2));
}

// ---------------------------------------------------------------------------
// optional pieces built on other branches

type Wasm = typeof import('@repo/zcash-wasm');

async function loadWasm(): Promise<Wasm> {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as {
    readFileSync(p: string): Uint8Array;
  };
  const wasm = await import('@repo/zcash-wasm');
  const url = new URL('../../../../../packages/zcash-wasm/zafu_wasm_bg.wasm', import.meta.url);
  // vite serves out-of-root files under /@fs/<abs path>
  wasm.initSync({ module: fs.readFileSync(url.pathname.replace(/^\/@fs/, '')) });
  return wasm;
}

/** The real protocol wrapper over the vendored wasm (null if the wasm lacks the exports). */
function loadProtocol(w: Wasm | null): LedgerZcashProtocol | null {
  if (typeof (w as { ledger_ufvk_plan?: unknown } | null)?.ledger_ufvk_plan !== 'function') {
    return null;
  }
  return createLedgerZcashProtocol(w as unknown as LedgerWasmExports);
}

// ---------------------------------------------------------------------------

describe.skipIf(!SPECULOS_URL)('Ledger Zcash app on Speculos', () => {
  let dev: SpeculosZcashDevice;
  let wasm: Wasm | null = null;
  let protocol: LedgerZcashProtocol | null = null;
  const ufvks = new Map<number, string>();

  beforeAll(async () => {
    // Throws (fails the suite) when SPECULOS_URL is set but unreachable.
    dev = await SpeculosZcashDevice.connect(SPECULOS_URL!);
    await dev.currentApp();
    try {
      wasm = await loadWasm();
    } catch {
      wasm = null;
    }
    protocol = loadProtocol(wasm);
  }, 30_000);

  afterAll(async () => {
    await dev?.close();
  });

  it('detects the running Zcash app and a version new accounts accept', async () => {
    const app = await dev.currentApp();
    expect(app.name).toBe('Zcash');
    expect(app.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      compareAppVersions(app.version, MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS),
    ).toBeGreaterThanOrEqual(0);
    await expect(dev.openZcashApp()).resolves.toEqual(app);
  });

  it('exports the UFVK for account 0 after on-device approval', async () => {
    const phases: LedgerSigningPhase['phase'][] = [];
    const [first] = await dev.exchange([ufvkFirst(0)], { onPhase: p => phases.push(p.phase) });
    // review is announced BEFORE the response that only arrives after approval
    expect(phases).toEqual(['sending', 'review', 'done']);
    expect(dev.lastReviewScreens.join(' ').toLowerCase()).toContain('viewing key');
    expect(dev.lastReviewScreens.join(' ')).toContain('#0');
    // drain the pending response so the app is left idle
    const declared = 2 + ((first![0]! << 8) | first![1]!);
    let have = first!.length;
    const chunks = [first!];
    while (have < declared) {
      const [next] = await dev.exchange([UFVK_CONTINUE]);
      chunks.push(next!);
      have += next!.length;
    }
    const ufvk = new TextDecoder().decode(
      Uint8Array.from(chunks.flatMap(c => Array.from(c))).subarray(2),
    );
    expect(ufvk).toMatch(/^uview1[02-9ac-hj-np-z]+$/);
    ufvks.set(0, ufvk);
  }, 60_000);

  it('is deterministic per account and distinct across accounts 0 and 1', async () => {
    const again = await exportUfvk(dev, 0);
    expect(again).toBe(ufvks.get(0));
    const one = await exportUfvk(dev, 1);
    expect(one).toMatch(/^uview1/);
    expect(one).not.toBe(again);
    ufvks.set(1, one);
  }, 90_000);

  it('matches the software derivation of the same seed (orchard FVK + transparent key)', async ctx => {
    if (!wasm || SEED === 'unknown' || !ufvks.has(0) || !ufvks.has(1)) {
      ctx.skip();
      return;
    }
    const w = wasm;
    for (const account of [0, 1]) {
      const ufvk = ufvks.get(account)!;
      expect(w.validate_ufvk(ufvk)).toBe(true);

      // Orchard: device UFVK vs ZIP-32 m/32'/133'/0' from the mnemonic. The
      // vendored wasm derives the Orchard FVK for account 0 only
      // (export_fvk_qr_hex ignores its account argument), so account 1 is
      // checked through its transparent key below and by being distinct here.
      const keys = new w.WalletKeys(SEED);
      const deviceFvk = w.WatchOnlyWallet.from_ufvk(ufvk).export_fvk_hex();
      if (account === 0) {
        expect(deviceFvk).toBe(keys.get_fvk_hex());
      } else {
        expect(deviceFvk).not.toBe(keys.get_fvk_hex());
      }
      keys.free();

      // Transparent: device UFVK vs BIP44 m/44'/133'/account'/0/0
      const priv = w.derive_transparent_privkey(SEED, account, 0);
      const softPub = bytesToHex(secp256k1.getPublicKey(priv, true));
      expect(w.transparent_pubkey_from_ufvk(ufvk, 0)).toBe(softPub);
    }
  });

  it('reports a device rejection as a distinct "rejected" failure and stays usable', async () => {
    const rejecting = dev.withDecision('reject');
    const err = await rejecting.exchange([ufvkFirst(0)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).failure).toBe('rejected');
    expect((err as LedgerError).statusWord).toBe(0x6985);
    // the harness waited out the "cancelled" status screen
    await expect(dev.currentApp()).resolves.toMatchObject({ name: 'Zcash' });
  }, 60_000);

  it('refuses a second operation while one is in flight ("busy")', async () => {
    const first = dev.exchange([ufvkFirst(0)]);
    const second = await dev.exchange([ufvkFirst(0)]).catch((e: unknown) => e);
    expect((second as LedgerError).failure).toBe('busy');
    const [head] = await first;
    // drain
    let have = head!.length;
    const declared = 2 + ((head![0]! << 8) | head![1]!);
    while (have < declared) {
      const [next] = await dev.exchange([UFVK_CONTINUE]);
      have += next!.length;
    }
  }, 60_000);

  it('stops before sending when the host cancels ("cancelled")', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await dev.exchange([ufvkFirst(0)], { signal: ctl.signal }).catch((e: unknown) => e);
    expect((err as LedgerError).failure).toBe('cancelled');
    await expect(dev.currentApp()).resolves.toMatchObject({ name: 'Zcash' });
  });

  it('exports the same UFVK through the protocol wrapper (feat/ledger-zcash-app)', async ctx => {
    if (!protocol) {
      // ./protocol.ts is not on this branch yet
      ctx.skip();
      return;
    }
    for (const account of [0, 1]) {
      const plan = protocol.ufvkPlan(account);
      expect(plan[0]).toEqual(ufvkFirst(account));
      // zcli's wasm adds ledger_ufvk_remaining_bytes (not in the contract yet):
      // send the continuation only while bytes are owed. Without it, fall back
      // to the contract's fixed plan.
      const remaining = (
        protocol as unknown as { ufvkRemainingBytes?: (r: Uint8Array[]) => number }
      ).ufvkRemainingBytes;
      let responses: Uint8Array[];
      if (remaining) {
        responses = await dev.exchange([plan[0]!]);
        while (remaining(responses) > 0) {
          responses.push(...(await dev.exchange([plan[1]!])));
        }
      } else {
        responses = await dev.exchange(plan);
      }
      const exported = protocol.parseUfvk(responses, 'main', account);
      expect(exported.ufvk).toBe(ufvks.get(account));
      expect(exported.accountIndex).toBe(account);
      expect(exported.seedFingerprint).toHaveLength(32);
    }
  }, 90_000);

  it('signs a PCZT round trip through the protocol wrapper', async ctx => {
    const fixture = env('LEDGER_SPECULOS_PCZT');
    const ledgerExports = wasm ? Object.keys(wasm).filter(n => n.startsWith('ledger_')) : [];
    if (ledgerExports.length === 0 || !protocol || !fixture) {
      // Needs: `ledger_*` exports in packages/zcash-wasm/zafu_wasm.d.ts (none in
      // the vendored build - describe_pczt_for_ledger is a description, not an
      // APDU plan), ./protocol.ts, and LEDGER_SPECULOS_PCZT=<hex file> holding a
      // PCZT that spends from the emulator seed's account 0.
      ctx.skip();
      return;
    }
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as {
      readFileSync(p: string, enc: 'utf8'): string;
    };
    const hex = fs.readFileSync(fixture, 'utf8').trim();
    const pczt = Uint8Array.from(hex.match(/../g)!.map(b => Number.parseInt(b, 16)));

    protocol.validatePczt(pczt);
    const plan = protocol.pcztSigningPlan(pczt, { memoHashSupported: true });
    const phases: string[] = [];
    const responses = await dev.exchange(plan, { onPhase: p => phases.push(p.phase) });
    expect(phases).toContain('review');
    expect(responses).toHaveLength(plan.length);
    const signed = protocol.finalizePcztSigning(pczt, responses);
    expect(signed.length).toBeGreaterThan(pczt.length);
  }, 180_000);
});
