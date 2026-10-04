/**
 * Fakes for the Ledger Zcash app contract: a protocol that "signs" by tagging
 * the PCZT, a device that records every exchange, an in-memory key-value area
 * and a reversible sealer. Test-only.
 */

import { vi, type Mock } from 'vitest';
import {
  LedgerError,
  LEDGER_ZCASH_LIMITS,
  type ApduCommand,
  type LedgerDeviceApp,
  type LedgerSigningPhase,
  type LedgerZcashDevice,
  type LedgerZcashProtocol,
} from './contract';
import type { LedgerOperationContext, LedgerOperationDeps } from './operation';
import {
  createLedgerOperationStore,
  type KeyValueArea,
  type LedgerOperationStore,
  type Sealer,
} from './operations-store';
import type { LedgerTransparentPath } from './signer';

/** First PCZT byte = number of transparent inputs (fake encoding). */
export const fakePczt = (transparentInputs = 1): string =>
  transparentInputs.toString(16).padStart(2, '0') + 'c0ffee';

export const fakeProtocol = (): LedgerZcashProtocol & {
  validatePczt: Mock<[Uint8Array], void>;
} => {
  const cmd = (ins: number, p2 = 0): ApduCommand => ({
    cla: 0x85,
    ins,
    p1: 0,
    p2,
    data: new Uint8Array([ins]),
  });
  return {
    ufvkPlan: () => [],
    ufvkRemainingBytes: () => 0,
    stampDerivations: pczt => pczt,
    parseUfvk: () => {
      throw new Error('unused');
    },
    validatePczt: vi.fn<[Uint8Array], void>((pczt: Uint8Array) => {
      if ((pczt[0] ?? 0) > LEDGER_ZCASH_LIMITS.maxTransparentInputs) {
        throw new LedgerError('unsupported_transaction', 'too many transparent inputs');
      }
    }),
    pcztSigningPlan: () => [cmd(0x56), cmd(0x56), cmd(0x56, 1)],
    finalizePcztSigning: (pczt, responses) => {
      if (responses.length !== 3) {
        throw new LedgerError('protocol_error', 'bad responses');
      }
      const out = new Uint8Array(pczt.length + 1);
      out.set(pczt);
      out[pczt.length] = 0x5a; // "signed"
      return out;
    },
  };
};

export interface FakeDevice extends LedgerZcashDevice {
  exchanges: number;
  closed: boolean;
  app: LedgerDeviceApp;
  /** next exchange outcome */
  behaviour: 'approve' | 'reject' | 'hang';
  openZcashApp: Mock<[opts?: { signal?: AbortSignal }], Promise<LedgerDeviceApp>>;
  currentApp: Mock<[], Promise<LedgerDeviceApp>>;
}

export const fakeDevice = (): FakeDevice => {
  const dev: FakeDevice = {
    exchanges: 0,
    closed: false,
    app: { name: 'Zcash', version: '3.9.4' },
    behaviour: 'approve',
    currentApp: vi.fn<[], Promise<LedgerDeviceApp>>(async () => dev.app),
    openZcashApp: vi.fn<[opts?: { signal?: AbortSignal }], Promise<LedgerDeviceApp>>(async () => {
      dev.app = { name: 'Zcash', version: '3.9.4' };
      return dev.app;
    }),
    exchange: async (
      plan: ApduCommand[],
      opts?: { signal?: AbortSignal; onPhase?: (p: LedgerSigningPhase) => void },
    ) => {
      dev.exchanges++;
      plan.forEach((_, i) =>
        opts?.onPhase?.({ phase: 'sending', sent: i + 1, total: plan.length }),
      );
      opts?.onPhase?.({ phase: 'review' });
      if (dev.behaviour === 'reject') {
        throw new LedgerError('rejected', 'rejected on device', 0x6986);
      }
      if (dev.behaviour === 'hang') {
        await new Promise<void>((_, reject) => {
          const fail = () => reject(new LedgerError('cancelled', 'cancelled'));
          if (opts?.signal?.aborted) {
            fail();
          }
          opts?.signal?.addEventListener('abort', fail);
        });
      }
      return plan.map(() => new Uint8Array([0x90]));
    },
    close: async () => {
      dev.closed = true;
    },
  };
  return dev;
};

export const memoryArea = (): KeyValueArea & {
  data: Map<string, unknown>;
  failNextSets: number;
} => {
  const area = {
    data: new Map<string, unknown>(),
    failNextSets: 0,
    get: async (k: string) => structuredClone(area.data.get(k)),
    set: async (k: string, v: unknown) => {
      if (area.failNextSets > 0) {
        area.failNextSets--;
        throw new Error('storage quota exceeded');
      }
      area.data.set(k, structuredClone(v));
    },
  };
  return area;
};

/** Reversible "encryption" keyed by `key`; unseal fails on a different key. */
export const fakeSealer = (key = 'k1'): Sealer => ({
  seal: async plain => `${key}:${btoa(plain.split('').reverse().join(''))}`,
  unseal: async sealed => {
    const [k, body] = sealed.split(':');
    if (k !== key || body === undefined) {
      throw new Error('wrong key');
    }
    return atob(body).split('').reverse().join('');
  },
});

export const CTX: LedgerOperationContext = { walletId: 'w1', network: 'main' };

export interface Harness {
  deps: LedgerOperationDeps;
  device: FakeDevice;
  protocol: ReturnType<typeof fakeProtocol>;
  store: LedgerOperationStore;
  area: ReturnType<typeof memoryArea>;
  broadcast: Mock<[string, string, string?], Promise<{ txid: string }>>;
  extractTx: Mock<[string], Promise<{ txHex: string; txid: string }>>;
  stampDerivations: Mock<
    [Uint8Array, { transparentPaths: readonly LedgerTransparentPath[] }],
    Uint8Array
  >;
  current: { ok: boolean };
  tracked: { opId: string; status: string; step?: string }[];
}

export const harness = (): Harness => {
  const device = fakeDevice();
  const protocol = fakeProtocol();
  const area = memoryArea();
  const store = createLedgerOperationStore({ area, sealer: fakeSealer() });
  const current = { ok: true };
  const tracked: Harness['tracked'] = [];
  let n = 0;
  const extractTx = vi.fn<[string], Promise<{ txHex: string; txid: string }>>(
    async signedPcztHex => ({
      txHex: `tx${signedPcztHex}`,
      txid: `txid-${signedPcztHex}`,
    }),
  );
  const broadcast = vi.fn<[string, string, string?], Promise<{ txid: string }>>(
    async (_w, txHex) => ({
      txid: `txid-${txHex.slice(2)}`,
    }),
  );
  const stampDerivations = vi.fn<
    [Uint8Array, { transparentPaths: readonly LedgerTransparentPath[] }],
    Uint8Array
  >(pczt => {
    const out = new Uint8Array(pczt.length + 1);
    out.set(pczt);
    out[pczt.length] = 0xd1; // "derivations stamped"
    return out;
  });
  const deps: LedgerOperationDeps = {
    protocol,
    device,
    stampDerivations,
    store,
    extractTx,
    broadcast,
    isCurrent: () => current.ok,
    newOperationId: () => `op${++n}`,
    track: (opId, _label, u) => tracked.push({ opId, status: u.status, step: u.step }),
  };
  return {
    deps,
    device,
    protocol,
    store,
    area,
    broadcast,
    extractTx,
    stampDerivations,
    current,
    tracked,
  };
};
