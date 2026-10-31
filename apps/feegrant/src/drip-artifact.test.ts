import { describe, expect, it } from 'vitest';
import { toFunctionSelector, toEventSelector } from 'viem';
import { compileDrip } from '../scripts/build-drip';
import { DRIP_ABI, DRIP_BYTECODE } from './drip-artifact';

describe('drip artifact', () => {
  it('exposes drip(address) and Dripped(address,address,uint256)', () => {
    const fn = DRIP_ABI.find(i => i.type === 'function');
    const ev = DRIP_ABI.find(i => i.type === 'event');
    expect(toFunctionSelector(fn!)).toBe(toFunctionSelector('function drip(address)'));
    expect(toEventSelector(ev!)).toBe(
      toEventSelector('event Dripped(address indexed from, address indexed to, uint256 amount)'),
    );
    expect(DRIP_BYTECODE).toMatch(/^0x6080/);
  });

  it('recompiles from contracts/Drip.sol to the committed bytecode', () => {
    const { abi, bytecode } = compileDrip();
    expect(bytecode).toBe(DRIP_BYTECODE);
    expect(abi).toEqual(DRIP_ABI);
  }, 30_000);
});
