import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi } from 'viem';
import { callLines, readCall, tokenAddress } from './calldata';

const SPENDER = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const TOKEN = '0x0165878A594ca255338adfa4d48449f69242Eb8F';
const token = { symbol: 'tUSDT', decimals: 18 };
const PENUMBRA =
  'penumbra1xq4xnyx8m2fz2xks5fnpye4z5a3ny2s3czq3r9vrumq4y2x3fpyxtmq9tld3ul4n0sgqnz8wdn8wxe60w9xjvf4hgwdk5dez9tfpnr7xv6qnrkpzthtqnxml07szp5pnt0vqm3w';
const msg = {
  denom: TOKEN,
  amount: 250n * 10n ** 18n,
  receiver: PENUMBRA,
  sourceClient: '08-wasm-0',
  destPort: 'transfer',
  timeoutTimestamp: 1_795_000_000n,
  memo: '',
};
const MSG =
  '(address denom,uint256 amount,string receiver,string sourceClient,string destPort,uint64 timeoutTimestamp,string memo)';
const eureka = parseAbi([
  `function sendTransfer(${MSG} msg_) returns (uint64)`,
  `function sendTransferWithPermit2(${MSG} msg_, ((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, bytes signature) returns (uint64)`,
]);
const brinance = parseAbi([
  'function sendTransfer(address token,uint256 amount,string receiver,string memo,uint64 timeoutTimestamp) payable returns (uint64)',
]);
/** a known eureka bridge, pinned to its route (evm/chains), and the flat brinance one */
const EUREKA = { address: SPENDER, client: '08-wasm-0', port: 'transfer' };
const BRINANCE = { address: SPENDER };

/** as a known bridge's call: ibc moves are read only from these */
const lines = (
  data: `0x${string}`,
  owner?: Parameters<typeof callLines>[2],
  bridge: Parameters<typeof readCall>[1] = EUREKA,
) => Object.fromEntries(callLines(readCall(data, bridge), token, owner).map(([k, v]) => [k, v]));

describe('reading what a transaction does', () => {
  it('reads an erc-20 approve', () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [SPENDER, 5n * 10n ** 18n],
    });
    expect(readCall(data)).toEqual({ kind: 'approve', spender: SPENDER, amount: 5n * 10n ** 18n });
    expect(lines(data)).toEqual({
      'what it does': `lets ${SPENDER} spend 5 tUSDT from this address`,
    });
  });

  it('says plainly when an approval has no limit', () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [SPENDER, maxUint256],
    });
    expect(lines(data)['what it does']).toBe(
      `lets ${SPENDER} spend any amount of tUSDT from this address`,
    );
  });

  it('reads an erc-20 transfer, in smallest units when the token did not say', () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [SPENDER, 7n],
    });
    expect(readCall(data)).toEqual({ kind: 'transfer', to: SPENDER, amount: 7n });
    expect(callLines(readCall(data))).toEqual([
      ['what it does', `sends 7 (smallest units of this token) to ${SPENDER}`],
    ]);
  });

  it('reads an eureka ics20 sendTransfer into penumbra', () => {
    const data = encodeFunctionData({ abi: eureka, functionName: 'sendTransfer', args: [msg] });
    expect(readCall(data, EUREKA)).toEqual({
      kind: 'ibc',
      token: TOKEN,
      amount: msg.amount,
      receiver: PENUMBRA,
      timeout: 1_795_000_000n,
      memo: '',
      sourceClient: '08-wasm-0',
      destPort: 'transfer',
    });
    expect(lines(data, 'one-time')).toEqual({
      'what it does': 'moves 250 tUSDT into penumbra',
      token: TOKEN,
      'source client': '08-wasm-0',
      'destination port': 'transfer',
      to: PENUMBRA,
      whose: 'a one-time address of yours',
      'back to you if not there by': '2026-11-18 11:06 utc',
    });
  });

  it('reads sendTransferWithPermit2 the same way', () => {
    const data = encodeFunctionData({
      abi: eureka,
      functionName: 'sendTransferWithPermit2',
      args: [
        { ...msg, memo: 'hi' },
        { permitted: { token: TOKEN, amount: msg.amount }, nonce: 1n, deadline: 2n },
        '0x1234',
      ],
    });
    expect(readCall(data, EUREKA)).toMatchObject({ kind: 'ibc', token: TOKEN, memo: 'hi' });
    expect(lines(data).memo).toBe('hi');
  });

  it('reads the brinance bridge sendTransfer, its timeout in nanoseconds', () => {
    const data = encodeFunctionData({
      abi: brinance,
      functionName: 'sendTransfer',
      args: [TOKEN, msg.amount, PENUMBRA, '', 1_795_000_000n * 10n ** 9n],
    });
    expect(readCall(data, BRINANCE)).toMatchObject({
      kind: 'ibc',
      token: TOKEN,
      timeout: 1_795_000_000n,
    });
  });

  it('warns when the penumbra receiver is not this wallet, or could not be checked', () => {
    const data = encodeFunctionData({ abi: eureka, functionName: 'sendTransfer', args: [msg] });
    expect(lines(data, 'not-yours').whose).toBe(
      "not an address of this wallet · if this is meant for you, please don't approve",
    );
    expect(lines(data).whose).toBe("zafu couldn't check whether this address is yours");
  });

  it('says only where an ibc move goes when the receiver is not penumbra', () => {
    const data = encodeFunctionData({
      abi: eureka,
      functionName: 'sendTransfer',
      args: [{ ...msg, receiver: 'cosmos1abc', timeoutTimestamp: 0n }],
    });
    expect(lines(data)).toEqual({
      'what it does': 'moves 250 tUSDT over ibc to another chain',
      token: TOKEN,
      'source client': '08-wasm-0',
      'destination port': 'transfer',
      to: 'cosmos1abc',
    });
  });

  it('reads an ibc move only from a known bridge; a look-alike is an unreadable call', () => {
    const data = encodeFunctionData({ abi: eureka, functionName: 'sendTransfer', args: [msg] });
    expect(readCall(data)).toMatchObject({ kind: 'call', selector: data.slice(0, 10) });
    expect(callLines(readCall(data), token, 'account').join(' ')).not.toContain('penumbra');
  });

  // audit F-2: the client and port pick the chain, not the receiver string
  it.each([
    ['another client', { sourceClient: 'attacker-client-7' }],
    ['another port', { destPort: 'evil' }],
  ])(
    'reads a known bridge on %s as off its route: a warning, no penumbra, no owner',
    (_, route) => {
      const data = encodeFunctionData({
        abi: eureka,
        functionName: 'sendTransfer',
        args: [{ ...msg, ...route }],
      });
      const view = readCall(data, EUREKA);
      expect(view).toMatchObject({ kind: 'off-route' });
      const all = callLines(view, token, 'account');
      const text = all.map(([, t]) => t).join(' ');
      expect(text).not.toContain('into penumbra');
      expect(text).not.toContain('yours');
      expect(all.map(([k]) => k)).not.toContain('whose');
      expect(all[0]).toEqual([
        'what it does',
        "sends 250 tUSDT over a route this bridge doesn't use for penumbra · it may never arrive, please don't approve unless you expected it",
        true,
      ]);
      const shown = Object.fromEntries(all.map(([k, v]) => [k, v]));
      expect(shown['source client']).toBe(route.sourceClient ?? '08-wasm-0');
      expect(shown['destination port']).toBe(route.destPort ?? 'transfer');
    },
  );

  it('reads a eureka call to the flat brinance bridge as off its route', () => {
    const data = encodeFunctionData({ abi: eureka, functionName: 'sendTransfer', args: [msg] });
    expect(readCall(data, BRINANCE)).toMatchObject({ kind: 'off-route' });
  });

  it('calls any approval from 2^96 up "any amount"', () => {
    const at = (amount: bigint) =>
      lines(
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, amount] }),
      )['what it does'];
    expect(at(2n ** 96n)).toContain('any amount of tUSDT');
    expect(at(2n ** 96n - 1n)).not.toContain('any amount');
  });

  it('says "far future" for a timeout no date can hold', () => {
    const data = encodeFunctionData({
      abi: eureka,
      functionName: 'sendTransfer',
      args: [{ ...msg, timeoutTimestamp: 2n ** 63n }],
    });
    expect(lines(data)['back to you if not there by']).toBe('far future');
  });

  it('names the token each call moves', () => {
    const approve = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [SPENDER, 1n],
    });
    const ibc = encodeFunctionData({ abi: eureka, functionName: 'sendTransfer', args: [msg] });
    expect(tokenAddress(readCall(approve), SPENDER)).toBe(SPENDER);
    expect(tokenAddress(readCall(ibc, EUREKA), SPENDER)).toBe(TOKEN);
    expect(tokenAddress(readCall('0x'), SPENDER)).toBeUndefined();
  });

  it('shows any other call by its selector and length, never guessed', () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transferFrom',
      args: [SPENDER, SPENDER, 1n],
    });
    expect(readCall(data)).toEqual({ kind: 'call', selector: '0x23b872dd', bytes: 100 });
    expect(readCall('0xdeadbeef00')).toEqual({ kind: 'call', selector: '0xdeadbeef', bytes: 5 });
  });

  it('has nothing to say about a plain value transfer', () => {
    expect(readCall(undefined)).toEqual({ kind: 'none' });
    expect(readCall('0x')).toEqual({ kind: 'none' });
    expect(callLines({ kind: 'none' })).toEqual([]);
  });
});
