import { describe, expect, test, vi } from 'vitest';
import {
  LedgerError,
  type ApduCommand,
  type LedgerAccountExport,
  type LedgerDeviceApp,
  type LedgerFailure,
  type LedgerZcashDevice,
} from './contract';
import {
  appAllowsNewAccounts,
  exportLedgerZcashAccount,
  ledgerDeviceLabel,
  parseLedgerAccountIndex,
  saveLedgerZcashAccount,
  toLedgerZcashImport,
  writeBirthdayIfEarlier,
  type BirthdayStore,
  type ExportLedgerAccountDeps,
  type LedgerZcashAccount,
} from './import-account';
import { createLedgerZcashProtocol, toApduPlan } from './protocol';
import { ledgerGuidance } from './guidance';

const UFVK = 'uview1fakefakefakefakefakefakefakefakefake';
const FP = new Uint8Array(32).fill(0xab);
const FIRST: ApduCommand = { cla: 0x85, ins: 0x0b, p1: 0, p2: 0, data: new Uint8Array([1]) };
const CONT: ApduCommand = { cla: 0x85, ins: 0x0b, p1: 1, p2: 0, data: new Uint8Array() };
const PLAN: ApduCommand[] = [FIRST, CONT];

interface FakeDeviceOpts {
  app?: LedgerDeviceApp;
  openedApp?: LedgerDeviceApp;
  currentAppError?: LedgerError;
  openError?: LedgerError;
  exchangeError?: LedgerError;
}

function fakeDevice(opts: FakeDeviceOpts = {}) {
  let chunk = 0;
  const device = {
    currentApp: vi.fn(async () => {
      if (opts.currentAppError) {
        throw opts.currentAppError;
      }
      return opts.app ?? { name: 'Zcash', version: '3.9.4' };
    }),
    openZcashApp: vi.fn(async () => {
      if (opts.openError) {
        throw opts.openError;
      }
      return opts.openedApp ?? { name: 'Zcash', version: '3.9.4' };
    }),
    exchange: vi.fn(
      async (_plan: ApduCommand[], o?: Parameters<LedgerZcashDevice['exchange']>[1]) => {
        o?.onPhase?.({ phase: 'review' });
        if (opts.exchangeError) {
          throw opts.exchangeError;
        }
        return [new Uint8Array([++chunk])];
      },
    ),
    close: vi.fn(async () => undefined),
  } satisfies LedgerZcashDevice;
  return device;
}

/** the device owes the UFVK in `chunks` responses (first + chunks-1 continuations) */
function fakeProtocol(
  exported?: Partial<LedgerAccountExport>,
  parseError?: LedgerError,
  chunks = 3,
) {
  return {
    ufvkPlan: vi.fn((_i: number) => PLAN),
    ufvkRemainingBytes: vi.fn((r: Uint8Array[]) => Math.max(0, chunks - r.length) * 100),
    parseUfvk: vi.fn((_r: Uint8Array[], _n: 'main' | 'test', accountIndex: number) => {
      if (parseError) {
        throw parseError;
      }
      return { ufvk: UFVK, seedFingerprint: FP, accountIndex, ...exported };
    }),
  };
}

function deps(
  device: LedgerZcashDevice,
  protocol: ReturnType<typeof fakeProtocol>,
): ExportLedgerAccountDeps {
  return { device, protocol, network: 'main', productName: 'Nano S Plus' };
}

async function failureOf(p: Promise<unknown>): Promise<LedgerFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).failure;
  }
  throw new Error('expected a LedgerError');
}

describe('exportLedgerZcashAccount', () => {
  test('success: exports the chosen account and reports steps in order', async () => {
    const device = fakeDevice();
    const protocol = fakeProtocol();
    const steps: string[] = [];
    const account = await exportLedgerZcashAccount(deps(device, protocol), {
      accountIndex: 3,
      onStep: s => steps.push(s.step),
    });
    expect(account).toEqual({
      ufvk: UFVK,
      seedFingerprintHex: 'ab'.repeat(32),
      accountIndex: 3,
      appVersion: '3.9.4',
      deviceLabel: 'Ledger Nano S Plus',
    });
    expect(protocol.ufvkPlan).toHaveBeenCalledWith(3);
    // first, then continuation until nothing is owed
    expect(device.exchange.mock.calls.map(c => c[0])).toEqual([[FIRST], [CONT], [CONT]]);
    expect(protocol.parseUfvk).toHaveBeenCalledWith(
      [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
      'main',
      3,
    );
    expect(device.openZcashApp).not.toHaveBeenCalled();
    expect(steps).toEqual(['checking_app', 'confirm_on_device', 'device', 'device', 'device']);
  });

  test('on the dashboard: asks the device to open the zcash app first', async () => {
    const device = fakeDevice({ app: { name: 'BOLOS', version: '1.0.0' } });
    const account = await exportLedgerZcashAccount(deps(device, fakeProtocol()), {
      accountIndex: 0,
    });
    expect(device.openZcashApp).toHaveBeenCalledOnce();
    expect(account.accountIndex).toBe(0);
  });

  test.each(['3.9.3', '3.8.9', '2.0.0', 'garbage', ''])(
    'app %s is too old: refused before any viewing key is requested',
    async version => {
      const device = fakeDevice({ app: { name: 'Zcash', version } });
      const protocol = fakeProtocol();
      expect(
        await failureOf(exportLedgerZcashAccount(deps(device, protocol), { accountIndex: 0 })),
      ).toBe('app_too_old');
      expect(protocol.ufvkPlan).not.toHaveBeenCalled();
      expect(device.exchange).not.toHaveBeenCalled();
    },
  );

  test('newer app versions are accepted', () => {
    expect(appAllowsNewAccounts('3.9.4')).toBe(true);
    expect(appAllowsNewAccounts('3.10.0')).toBe(true);
    expect(appAllowsNewAccounts('4.0.0')).toBe(true);
  });

  const deviceFailures: [string, FakeDeviceOpts, LedgerFailure][] = [
    [
      'no device / permission',
      { currentAppError: new LedgerError('not_connected') },
      'not_connected',
    ],
    ['locked', { currentAppError: new LedgerError('locked', undefined, 0x5515) }, 'locked'],
    ['busy', { currentAppError: new LedgerError('busy') }, 'busy'],
    [
      'zcash app not installed / not opened',
      { app: { name: 'BOLOS', version: '1' }, openError: new LedgerError('app_not_open') },
      'app_not_open',
    ],
    [
      'user declines opening the app',
      { app: { name: 'BOLOS', version: '1' }, openError: new LedgerError('rejected') },
      'rejected',
    ],
    [
      'rejected export on device',
      { exchangeError: new LedgerError('rejected', undefined, 0x6985) },
      'rejected',
    ],
    ['cancelled', { exchangeError: new LedgerError('cancelled') }, 'cancelled'],
    ['malformed response', { exchangeError: new LedgerError('protocol_error') }, 'protocol_error'],
  ];

  test.each(deviceFailures)('%s: surfaces as its own failure kind', async (_n, opts, failure) => {
    const device = fakeDevice(opts);
    expect(
      await failureOf(exportLedgerZcashAccount(deps(device, fakeProtocol()), { accountIndex: 0 })),
    ).toBe(failure);
  });

  test('another app still open after openZcashApp: app_not_open', async () => {
    const device = fakeDevice({
      app: { name: 'Bitcoin', version: '2.1.0' },
      openedApp: { name: 'Bitcoin', version: '2.1.0' },
    });
    expect(
      await failureOf(exportLedgerZcashAccount(deps(device, fakeProtocol()), { accountIndex: 0 })),
    ).toBe('app_not_open');
  });

  test('parse failure, wrong account, wrong network: protocol_error', async () => {
    const run = (p: ReturnType<typeof fakeProtocol>) =>
      failureOf(exportLedgerZcashAccount(deps(fakeDevice(), p), { accountIndex: 1 }));
    expect(await run(fakeProtocol(undefined, new LedgerError('protocol_error')))).toBe(
      'protocol_error',
    );
    expect(await run(fakeProtocol({ accountIndex: 2 }))).toBe('protocol_error');
    expect(await run(fakeProtocol({ ufvk: 'uviewtest1abc' }))).toBe('protocol_error');
    expect(await run(fakeProtocol({ seedFingerprint: new Uint8Array(4) }))).toBe('protocol_error');
  });

  test('single-response UFVK: no continuation sent', async () => {
    const device = fakeDevice();
    await exportLedgerZcashAccount(deps(device, fakeProtocol(undefined, undefined, 1)), {
      accountIndex: 0,
    });
    expect(device.exchange).toHaveBeenCalledTimes(1);
  });

  test('continuation loop that makes no progress, or never ends: protocol_error', async () => {
    const stuck = fakeProtocol();
    stuck.ufvkRemainingBytes.mockReturnValue(50);
    expect(
      await failureOf(exportLedgerZcashAccount(deps(fakeDevice(), stuck), { accountIndex: 0 })),
    ).toBe('protocol_error');

    let owed = 10_000;
    const endless = fakeProtocol();
    endless.ufvkRemainingBytes.mockImplementation(() => (owed -= 1));
    const device = fakeDevice();
    expect(
      await failureOf(exportLedgerZcashAccount(deps(device, endless), { accountIndex: 0 })),
    ).toBe('protocol_error');
    expect(device.exchange.mock.calls.length).toBeLessThanOrEqual(65);
  });

  test('testnet import is refused before touching the device', async () => {
    const device = fakeDevice();
    expect(
      await failureOf(
        exportLedgerZcashAccount(
          { device, protocol: fakeProtocol(), network: 'test' },
          { accountIndex: 0 },
        ),
      ),
    ).toBe('unsupported_transaction');
    expect(device.currentApp).not.toHaveBeenCalled();
  });

  test('abort after the device answered: cancelled, nothing returned', async () => {
    const abort = new AbortController();
    const device = fakeDevice();
    device.exchange.mockImplementationOnce(async () => {
      abort.abort();
      return [new Uint8Array([0x90])];
    });
    expect(
      await failureOf(
        exportLedgerZcashAccount(deps(device, fakeProtocol()), {
          accountIndex: 0,
          signal: abort.signal,
        }),
      ),
    ).toBe('cancelled');
  });

  test('account index outside 0..100 is refused before touching the device', async () => {
    const device = fakeDevice();
    await expect(
      exportLedgerZcashAccount(deps(device, fakeProtocol()), { accountIndex: 101 }),
    ).rejects.toThrow(RangeError);
    expect(device.currentApp).not.toHaveBeenCalled();
    expect(parseLedgerAccountIndex('0')).toBe(0);
    expect(parseLedgerAccountIndex(' 100 ')).toBe(100);
    expect(parseLedgerAccountIndex('101')).toBeNull();
    expect(parseLedgerAccountIndex('-1')).toBeNull();
    expect(parseLedgerAccountIndex('1.5')).toBeNull();
    expect(parseLedgerAccountIndex('')).toBeNull();
  });
});

describe('failure guidance', () => {
  const all: LedgerFailure[] = [
    'not_connected',
    'locked',
    'app_not_open',
    'app_too_old',
    'rejected',
    'busy',
    'unsupported_transaction',
    'cancelled',
    'protocol_error',
  ];

  test('every failure has its own next step', () => {
    const actions = all.map(f => ledgerGuidance(new LedgerError(f)).action);
    expect(new Set(actions).size).toBe(all.length);
    expect(ledgerGuidance(new LedgerError('locked')).action).toMatch(/unlock/);
    expect(ledgerGuidance(new LedgerError('app_not_open')).action).toMatch(/open the zcash app/);
    expect(ledgerGuidance(new LedgerError('app_too_old')).action).toMatch(/3\.9\.4/);
    expect(ledgerGuidance(new LedgerError('rejected')).action).toMatch(/nothing was sent/);
    for (const f of all) {
      expect(ledgerGuidance(new LedgerError(f)).action).not.toContain('\u2014');
    }
  });

  test('non-ledger throws map sensibly', () => {
    const picker = new DOMException('No device selected.', 'NotFoundError');
    expect(ledgerGuidance(picker).failure).toBe('not_connected');
    expect(ledgerGuidance(new Error('boom'))).toMatchObject({ action: 'boom', retryable: true });
    expect(ledgerGuidance(new LedgerError('busy')).failure).toBe('busy');
  });
});

describe('protocol wrapper', () => {
  test('missing wasm exports throw protocol_error, not a TypeError', () => {
    const p = createLedgerZcashProtocol({});
    expect(() => p.ufvkPlan(0)).toThrow('wasm build lacks ledger exports');
    try {
      p.parseUfvk([], 'main', 0);
    } catch (e) {
      expect((e as LedgerError).failure).toBe('protocol_error');
    }
  });

  test('normalises plans and exports from the wasm', () => {
    const p = createLedgerZcashProtocol({
      ledger_ufvk_plan: () =>
        JSON.stringify([
          { cla: 133, ins: 11, p1: 0, p2: 0, data: [1, 2] },
          { cla: 133, ins: 11, p1: 1, p2: 0, data: [] },
        ]),
      ledger_ufvk_remaining_bytes: r => (r.length < 2 ? 42 : 0),
      ledger_parse_ufvk: (_r, _n, account_index) => ({
        ufvk: UFVK,
        seed_fingerprint: 'cd'.repeat(32),
        account_index,
      }),
    });
    expect(p.ufvkPlan(0)).toEqual([
      { cla: 133, ins: 11, p1: 0, p2: 0, data: new Uint8Array([1, 2]) },
      { cla: 133, ins: 11, p1: 1, p2: 0, data: new Uint8Array() },
    ]);
    expect(p.ufvkRemainingBytes([new Uint8Array()])).toBe(42);
    expect(p.ufvkRemainingBytes([new Uint8Array(), new Uint8Array()])).toBe(0);
    const out = p.parseUfvk([], 'main', 5);
    expect(out.accountIndex).toBe(5);
    expect(out.seedFingerprint).toEqual(new Uint8Array(32).fill(0xcd));
  });

  test('wasm throws keep a failure-kind prefix, else protocol_error', () => {
    const p = createLedgerZcashProtocol({
      ledger_ufvk_plan: () => {
        throw new Error('unsupported_transaction: too many actions');
      },
      ledger_parse_ufvk: () => {
        throw new Error('bad tag');
      },
    });
    expect(() => p.ufvkPlan(0)).toThrow(LedgerError);
    try {
      p.ufvkPlan(0);
    } catch (e) {
      expect((e as LedgerError).failure).toBe('unsupported_transaction');
    }
    try {
      p.parseUfvk([], 'main', 0);
    } catch (e) {
      expect((e as LedgerError).failure).toBe('protocol_error');
    }
    expect(() => toApduPlan([])).toThrow(LedgerError);
    expect(() => toApduPlan([{ cla: 300, ins: 0, p1: 0, p2: 0, data: [] }])).toThrow(LedgerError);
  });
});

describe('saving the account', () => {
  const account: LedgerZcashAccount = {
    ufvk: UFVK,
    seedFingerprintHex: 'ab'.repeat(32),
    accountIndex: 2,
    appVersion: '3.9.4',
    deviceLabel: 'Ledger Nano X',
  };

  function memStore(initial: Record<string, unknown> = {}): BirthdayStore & {
    data: Record<string, unknown>;
  } {
    const data = { ...initial };
    return {
      data,
      get: async key => (key in data ? { [key]: data[key] } : {}),
      set: async items => {
        Object.assign(data, items);
      },
    };
  }

  test('maps to a shielded ledger import', () => {
    expect(toLedgerZcashImport(account, { address: 'u1addr', mainnet: true })).toEqual({
      address: 'u1addr',
      ufvk: UFVK,
      accountIndex: 2,
      deviceId: `ledger-zcash-${'ab'.repeat(32)}`,
      mainnet: true,
      custody: 'ledger-zcash',
      seedFingerprint: 'ab'.repeat(32),
      appVersion: '3.9.4',
      deviceLabel: 'Ledger Nano X',
    });
  });

  test('adds the wallet, labels it, and writes the birthday', async () => {
    const addLedger = vi.fn(async () => 'vault-1');
    const store = memStore();
    const id = await saveLedgerZcashAccount(
      {
        addLedger,
        deriveAddress: async () => 'u1addr',
        birthdayStore: store,
        minBirthdayHeight: 100,
      },
      { account, label: ' ', mainnet: true, birthdayHeight: 50 },
    );
    expect(id).toBe('vault-1');
    expect(addLedger).toHaveBeenCalledWith(
      expect.objectContaining({ custody: 'ledger-zcash', address: 'u1addr' }),
      'ledger nano x #2',
    );
    expect(store.data['zcashBirthday_vault-1']).toBe(100);
  });

  test('birthday only ever lowers', async () => {
    const store = memStore({ zcashBirthday_v: 2000 });
    await writeBirthdayIfEarlier(store, 'v', 3000, 100);
    expect(store.data['zcashBirthday_v']).toBe(2000);
    await writeBirthdayIfEarlier(store, 'v', 1500, 100);
    expect(store.data['zcashBirthday_v']).toBe(1500);
  });

  test('device labels', () => {
    expect(ledgerDeviceLabel('Nano X')).toBe('Ledger Nano X');
    expect(ledgerDeviceLabel('Ledger Flex')).toBe('Ledger Flex');
    expect(ledgerDeviceLabel(undefined)).toBe('Ledger');
    expect(ledgerDeviceLabel('something else')).toBe('Ledger');
  });
});
