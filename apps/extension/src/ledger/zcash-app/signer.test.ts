import { describe, expect, it, vi } from 'vitest';
import { LedgerError } from './contract';
import { fakeDevice, fakeProtocol } from './fakes.test-util';
import { defaultMemoHashSupported, signPcztOnLedger, toLedgerError } from './signer';

const stamp = vi.fn((p: Uint8Array) => {
  const out = new Uint8Array(p.length + 1);
  out.set(p);
  out[p.length] = 0xd1;
  return out;
});

const PATH = {
  inputIndex: 0,
  scope: 0 as const,
  addressIndex: 3,
  pubkey: new Uint8Array(33).fill(2),
};

describe('signPcztOnLedger', () => {
  it('stamps derivations before validation, planning and finalisation', async () => {
    const protocol = fakeProtocol();
    const plan = vi.spyOn(protocol, 'pcztSigningPlan');
    const device = fakeDevice();
    const signed = await signPcztOnLedger(
      { protocol, device, stampDerivations: stamp },
      new Uint8Array([1, 2]),
      { transparentPaths: [PATH] },
    );
    expect(stamp).toHaveBeenCalledWith(new Uint8Array([1, 2]), {
      transparentPaths: [PATH],
    });
    expect(protocol.validatePczt).toHaveBeenCalledWith(new Uint8Array([1, 2, 0xd1]));
    expect(plan.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 0xd1]));
    // app 3.9.4 hashes memos
    expect(plan.mock.calls[0]?.[1]).toEqual({ memoHashSupported: true });
    expect(signed).toEqual(new Uint8Array([1, 2, 0xd1, 0x5a]));
  });

  it('streams full memos to apps older than 3.9.4', async () => {
    const protocol = fakeProtocol();
    const plan = vi.spyOn(protocol, 'pcztSigningPlan');
    const device = fakeDevice();
    device.app = { name: 'Zcash', version: '3.9.3' };
    await signPcztOnLedger({ protocol, device, stampDerivations: stamp }, new Uint8Array([1]));
    expect(plan.mock.calls[0]?.[1]).toEqual({ memoHashSupported: false });
    expect(defaultMemoHashSupported('')).toBe(false);
  });

  it('maps prefixed wasm errors onto LedgerError kinds, before the device', async () => {
    const protocol = fakeProtocol();
    protocol.validatePczt.mockImplementationOnce(() => {
      throw new Error('unsupported_transaction: legacy orchard into ironwood');
    });
    const device = fakeDevice();
    await expect(
      signPcztOnLedger({ protocol, device, stampDerivations: stamp }, new Uint8Array([1])),
    ).rejects.toMatchObject({ failure: 'unsupported_transaction' });
    expect(device.currentApp).not.toHaveBeenCalled();

    expect(toLedgerError(new Error('app_too_old: need 3.9.3')).failure).toBe('app_too_old');
    expect(
      toLedgerError(new Error('protocol_error: ledger_signature_mismatch: action 2')).failure,
    ).toBe('protocol_error');
    expect(toLedgerError('garbage').failure).toBe('protocol_error');
    const kept = new LedgerError('rejected');
    expect(toLedgerError(kept)).toBe(kept);
  });

  it('a signature mismatch at finalisation is a protocol error, not a signed PCZT', async () => {
    const protocol = fakeProtocol();
    vi.spyOn(protocol, 'finalizePcztSigning').mockImplementation(() => {
      throw new Error('protocol_error: ledger_signature_mismatch: orchard action 0');
    });
    await expect(
      signPcztOnLedger(
        { protocol, device: fakeDevice(), stampDerivations: stamp },
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ failure: 'protocol_error' });
  });
});
