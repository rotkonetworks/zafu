import { describe, expect, it } from 'vitest';
import fixture from './unit.fixture.json';
import {
  guardiansSigned,
  unitDepositAddress,
  unitSettled,
  unitWithdrawAddress,
  unitZecEstimate,
  unitZecOperations,
} from './unit';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const serve = (body: unknown) => (async () => json(body)) as never;

const { deposit, withdraw } = fixture;
const base58Of = async () => deposit.base58;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('a real deposit address from unit', () => {
  it('passes: all three pinned guardians signed it', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), json(deposit.response))) as never;
    expect(await unitDepositAddress(deposit.account, base58Of, fetchFn)).toBe(
      deposit.response.address,
    );
    expect(urls).toEqual([
      `https://api.hyperunit.xyz/gen/zcash/hyperliquid/zec/${deposit.account}`,
    ]);
    expect(
      guardiansSigned(
        deposit.response.signatures,
        n =>
          `${n}:user-zcash-hyperliquid-0xeE119C2cc01F4b545020a0Df05CD1e63b657d8E5-${deposit.base58}`,
      ),
    ).toBe(3);
  });

  it('is refused for another account: the signatures name the destination', async () => {
    await expect(
      unitDepositAddress(
        '0x5e9ee1089755c3435139848e47e6635505d5a13a',
        base58Of,
        serve(deposit.response),
      ),
    ).rejects.toThrow(/did not sign/);
  });

  it('is refused when the address was swapped for another', async () => {
    // a different, well-formed tex address with the real signatures
    const swapped = { ...deposit.response, address: 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte' };
    await expect(
      unitDepositAddress(
        deposit.account,
        async () => 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC',
        serve(swapped),
      ),
    ).rejects.toThrow(/did not sign/);
    // or the same tex with a base58 twin that is not its own
    await expect(
      unitDepositAddress(
        deposit.account,
        async () => 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC',
        serve(deposit.response),
      ),
    ).rejects.toThrow(/did not sign/);
  });

  it('is refused with one signature, with tampered ones, and with none', async () => {
    const one = clone(deposit.response) as { signatures: Record<string, string> };
    delete one.signatures['hl-node'];
    delete one.signatures['field-node'];
    await expect(unitDepositAddress(deposit.account, base58Of, serve(one))).rejects.toThrow();

    const bent = clone(deposit.response) as { signatures: Record<string, string> };
    for (const n of ['hl-node', 'field-node']) {
      const s = bent.signatures[n]!;
      bent.signatures[n] = (s.startsWith('A') ? 'B' : 'A') + s.slice(1);
    }
    await expect(unitDepositAddress(deposit.account, base58Of, serve(bent))).rejects.toThrow();

    // one guardian's signature under every name is still one guardian
    const same = clone(deposit.response) as { signatures: Record<string, string> };
    same.signatures['hl-node'] = same.signatures['unit-node']!;
    same.signatures['field-node'] = same.signatures['unit-node']!;
    await expect(unitDepositAddress(deposit.account, base58Of, serve(same))).rejects.toThrow();

    await expect(
      unitDepositAddress(deposit.account, base58Of, serve({ address: deposit.response.address })),
    ).rejects.toThrow();
  });

  it('passes with two of three', async () => {
    const two = clone(deposit.response) as { signatures: Record<string, string> };
    delete two.signatures['field-node'];
    expect(await unitDepositAddress(deposit.account, base58Of, serve(two))).toBe(
      deposit.response.address,
    );
  });

  it('is refused when it is not a tex address at all', async () => {
    const t1 = { ...deposit.response, address: deposit.base58 };
    await expect(unitDepositAddress(deposit.account, base58Of, serve(t1))).rejects.toThrow();
  });
});

describe('a real withdrawal address from unit', () => {
  it('passes for the zcash address it was made for', async () => {
    expect(await unitWithdrawAddress(withdraw.zcashT, serve(withdraw.response))).toBe(
      withdraw.response.address,
    );
  });

  it('is refused for another zcash address, or with the address swapped', async () => {
    await expect(unitWithdrawAddress(deposit.base58, serve(withdraw.response))).rejects.toThrow(
      /did not sign/,
    );
    const swapped = {
      ...withdraw.response,
      address: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
    };
    await expect(unitWithdrawAddress(withdraw.zcashT, serve(swapped))).rejects.toThrow(
      /did not sign/,
    );
  });

  it('throws when unit turns the request down', async () => {
    const down = (async () => json({ error: 'invalid request' }, 400)) as never;
    await expect(unitWithdrawAddress(withdraw.zcashT, down)).rejects.toThrow('400');
  });
});

describe('unit estimates and operations', () => {
  it('reads what zec costs and takes right now', async () => {
    const body = {
      zcash: {
        depositFee: 568140,
        depositEta: '126m',
        withdrawalFee: 15000,
        withdrawalEta: '130m',
      },
    };
    expect(await unitZecEstimate(serve(body))).toEqual({
      depositFeeZat: 568_140n,
      depositEta: '126m',
      withdrawFeeZat: 15_000n,
      withdrawEta: '130m',
    });
    await expect(unitZecEstimate(serve({ bitcoin: {} }))).rejects.toThrow();
  });

  it('keeps the zec operations, each way, and drops the rest', async () => {
    const op = (o: object) => ({
      asset: 'zec',
      sourceAmount: '10000000',
      state: 'waitForSrcTxFinalization',
      opCreatedAt: '2026-11-16T00:00:00Z',
      ...o,
    });
    const ops = await unitZecOperations(
      deposit.account,
      serve({
        operations: [
          op({
            sourceChain: 'zcash',
            destinationChain: 'hyperliquid',
            sourceTxHash: 'ab:0',
            sourceTxConfirmations: 12,
          }),
          op({
            sourceChain: 'hyperliquid',
            destinationChain: 'zcash',
            sourceTxHash: '0x1:5',
            state: 'done',
          }),
          op({ sourceChain: 'bitcoin', destinationChain: 'hyperliquid', asset: 'btc' }),
          op({ sourceChain: 'zcash', destinationChain: 'hyperliquid', sourceAmount: 'lots' }),
        ],
      }),
    );
    expect(ops).toEqual([
      {
        sourceTx: 'ab:0',
        way: 'deposit',
        zat: 10_000_000n,
        state: 'waitForSrcTxFinalization',
        confirmations: 12,
        createdAt: '2026-11-16T00:00:00Z',
      },
      {
        sourceTx: '0x1:5',
        way: 'withdraw',
        zat: 10_000_000n,
        state: 'done',
        createdAt: '2026-11-16T00:00:00Z',
      },
    ]);
    expect(ops.map(unitSettled)).toEqual([false, true]);
    expect(await unitZecOperations(deposit.account, serve({ addresses: [] }))).toEqual([]);
  });
});
