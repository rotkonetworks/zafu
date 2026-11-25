import { describe, expect, it } from 'vitest';
import { EVM_CHAINS, evmChain, hexChainId, isKnownBridge, parseChainId } from './chains';

describe('the evm chain allow-list', () => {
  it('offers bnb smart chain and its testnet', () => {
    expect(evmChain(56, false)?.name).toBe('bnb smart chain');
    expect(evmChain(97, false)?.name).toBe('bnb smart chain testnet');
  });

  it('offers the local dev chain only while beta features are on', () => {
    expect(evmChain(31337, false)).toBeUndefined();
    expect(evmChain(31337, true)?.rpc).toBe('http://127.0.0.1:8545');
  });

  it('knows no other chain', () => {
    expect(evmChain(1, true)).toBeUndefined();
    expect(evmChain(NaN, true)).toBeUndefined();
  });

  it('gives every remote chain an egress destination, and the local one none', () => {
    for (const c of EVM_CHAINS) {
      expect(!!c.destination).toBe(!c.rpc.startsWith('http://127.0.0.1'));
    }
  });

  it('reads and writes EIP-1193 chain ids', () => {
    expect(parseChainId('0x38')).toBe(56);
    expect(parseChainId('0x7A69')).toBe(31337);
    expect(parseChainId('56')).toBeNaN();
    expect(parseChainId(56)).toBeNaN();
    expect(hexChainId(97)).toBe('0x61');
  });
});

describe('known bridges', () => {
  it('knows the local BrinanceTransfer, in any case', () => {
    const local = evmChain(31337, true)!;
    expect(isKnownBridge(local, '0x9a676e781a523b5d0c0e43731313a708cb607508')).toBe(true);
    expect(isKnownBridge(local, '0x000000000000000000000000000000000000dEaD')).toBe(false);
    expect(isKnownBridge(local, undefined)).toBe(false);
  });

  it("knows chapel's eureka ics20, and none on mainnet yet", () => {
    expect(isKnownBridge(evmChain(97, false)!, '0xaaffe45f7c9352188783f0d4d945c672788545a3')).toBe(
      true,
    );
    // the router is not where sendTransfer goes
    expect(isKnownBridge(evmChain(97, false)!, '0x38A49D19e998ED7DFFA491e20D3E70d549EE4771')).toBe(
      false,
    );
    expect(evmChain(56, false)!.ibc).toEqual([]);
  });
});
