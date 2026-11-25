/**
 * The evm send path: a site's transaction completed from the node, signed by
 * the seed-derived dapp key, and broadcast. Uses anvil's public dev phrase and
 * key (never a real one). The broadcast test runs against a local anvil at
 * 127.0.0.1:8545 when one is up, and is skipped otherwise.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  hashMessage,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { withBaseAccount } from '../buy/base-key';
import { accountPath } from '../hyperliquid/accounts';
import { DAPP_EVM_PATH } from './chains';
import { EvmError, fillTx, rpcAt, signAndSend, withDappAccount, type Rpc } from './tx';

const ANVIL_PHRASE = 'test test test test test test test test test test test junk';
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SPENDER = '0x000000000000000000000000000000000000dEaD';

/** a node that answers from a table, and remembers what it was asked */
const stubRpc = (answers: Record<string, unknown>) => {
  const asked: [string, readonly unknown[]][] = [];
  const rpc: Rpc = (method, params) => {
    asked.push([method, params]);
    return Promise.resolve(answers[method]);
  };
  return { rpc, asked };
};

/** the dapp key as another wallet derives it: viem's own bip32, account 1' */
const DAPP_ADDRESS = mnemonicToAccount(ANVIL_PHRASE, { accountIndex: 1 }).address;

describe('the dapp key', () => {
  it("is the seed's m/44'/60'/1'/0/0, as another evm wallet derives it", async () => {
    expect(DAPP_EVM_PATH).toBe("m/44'/60'/1'/0/0");
    expect(await withDappAccount(ANVIL_PHRASE, a => Promise.resolve(a.address))).toBe(DAPP_ADDRESS);
  });

  it('is none of the keys zafu already uses: injective, the base burner, hyperliquid', async () => {
    const injectiveAndBase = await withBaseAccount(ANVIL_PHRASE, a => Promise.resolve(a.address));
    expect(injectiveAndBase).toBe(ANVIL_ADDRESS);
    expect(accountPath(0)).toBe("m/44'/60'/0'/0/0");
    // hyperliquid accounts are m/44'/60'/0'/0/n: all under account 0', never 1'
    expect(Array.from({ length: 50 }, (_, n) => accountPath(n))).not.toContain(DAPP_EVM_PATH);
    expect(DAPP_ADDRESS).not.toBe(ANVIL_ADDRESS);
  });

  it('signs a message that recovers to its address', async () => {
    const message = '0x68656c6c6f' as Hex;
    const signature = await withDappAccount(ANVIL_PHRASE, a =>
      a.signMessage({ message: { raw: message } }),
    );
    expect(await recoverAddress({ hash: hashMessage({ raw: message }), signature })).toBe(
      DAPP_ADDRESS,
    );
  });
});

describe('completing a transaction', () => {
  it('asks the node for nonce, gas and gas price when the site left them out', async () => {
    const { rpc, asked } = stubRpc({
      eth_getTransactionCount: '0x7',
      eth_estimateGas: '0xb411',
      eth_gasPrice: '0x3b9aca00',
    });
    const tx = await fillTx(rpc, 56, ANVIL_ADDRESS, { to: SPENDER, value: '0x10' });
    expect(tx).toEqual({
      chainId: 56,
      to: SPENDER,
      value: 16n,
      data: undefined,
      gas: 0xb411n,
      gasPrice: 1_000_000_000n,
      nonce: 7,
    });
    expect(asked.map(([m]) => m).sort()).toEqual([
      'eth_estimateGas',
      'eth_gasPrice',
      'eth_getTransactionCount',
    ]);
  });

  it('keeps what the site set, asking the node nothing', async () => {
    const { rpc, asked } = stubRpc({});
    const tx = await fillTx(rpc, 97, ANVIL_ADDRESS, {
      from: ANVIL_ADDRESS.toLowerCase(),
      to: SPENDER,
      gas: '0x5208',
      gasPrice: '0x1',
      nonce: '0x2',
    });
    expect([tx.gas, tx.gasPrice, tx.nonce, tx.value]).toEqual([21000n, 1n, 2, 0n]);
    expect(asked).toEqual([]);
  });

  it('refuses a transaction from an address zafu did not give the site', async () => {
    const { rpc } = stubRpc({});
    await expect(fillTx(rpc, 56, ANVIL_ADDRESS, { from: SPENDER })).rejects.toMatchObject({
      code: 4100,
    });
  });

  it("refuses a transaction that names another chain than the site's", async () => {
    const { rpc } = stubRpc({});
    const p = { to: SPENDER, gas: '0x1', gasPrice: '0x1', nonce: '0x0' };
    await expect(fillTx(rpc, 56, ANVIL_ADDRESS, { ...p, chainId: '0x61' })).rejects.toMatchObject({
      code: -32602,
    });
    expect((await fillTx(rpc, 56, ANVIL_ADDRESS, { ...p, chainId: '0x38' })).chainId).toBe(56);
    expect((await fillTx(rpc, 56, ANVIL_ADDRESS, { ...p, chainId: 56 })).chainId).toBe(56);
  });

  it('refuses data that is not hex', async () => {
    const { rpc } = stubRpc({});
    await expect(
      fillTx(rpc, 56, ANVIL_ADDRESS, { to: SPENDER, data: 'hello' }),
    ).rejects.toBeInstanceOf(EvmError);
  });

  it('broadcasts a legacy transaction signed for its chain by the key', async () => {
    const { rpc, asked } = stubRpc({ eth_sendRawTransaction: '0xhash' });
    const tx = await fillTx(stubRpc({}).rpc, 56, ANVIL_ADDRESS, {
      to: SPENDER,
      value: '0x1',
      gas: '0x5208',
      gasPrice: '0x3b9aca00',
      nonce: '0x0',
    });
    const hash = await signAndSend(rpc, privateKeyToAccount(ANVIL_KEY), tx);
    expect(hash).toBe('0xhash');
    const raw = asked[0]![1][0] as `0x${string}`;
    expect(parseTransaction(raw)).toMatchObject({
      type: 'legacy',
      chainId: 56,
      to: SPENDER.toLowerCase(),
    });
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(
      ANVIL_ADDRESS,
    );
  });
});

const ANVIL = 'http://127.0.0.1:8545';
const anvilUp = await rpcAt(ANVIL)('eth_chainId', []).then(
  id => id === '0x7a69',
  () => false,
);

describe.skipIf(!anvilUp)('on a local anvil', () => {
  it(
    "signs and broadcasts an erc-20 approve from the seed's dapp key",
    { timeout: 20_000 },
    async () => {
      const rpc = rpcAt(ANVIL);
      // the first mock token anvil's deployment holds
      const code = await rpc('eth_getCode', [
        '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
        'latest',
      ]);
      expect(code).not.toBe('0x');
      const tokenAddress = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
      const amount = BigInt(Date.now());
      // the dapp key holds nothing on a fresh anvil: give it gas (an anvil-only call)
      await rpc('anvil_setBalance', [DAPP_ADDRESS, '0xde0b6b3a7640000']);
      const tx = await fillTx(rpc, 31337, DAPP_ADDRESS, {
        to: tokenAddress,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [SPENDER, amount],
        }),
      });
      const hash = await withDappAccount(ANVIL_PHRASE, a => signAndSend(rpc, a, tx));
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

      // anvil may mine on an interval rather than at once
      let receipt: { status: string } | null = null;
      for (let i = 0; i < 60 && !receipt; i++) {
        receipt = (await rpc('eth_getTransactionReceipt', [hash])) as { status: string } | null;
        if (!receipt) {
          await new Promise(r => setTimeout(r, 250));
        }
      }
      expect(receipt?.status).toBe('0x1');
      const allowance = decodeFunctionResult({
        abi: erc20Abi,
        functionName: 'allowance',
        data: (await rpc('eth_call', [
          {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'allowance',
              args: [DAPP_ADDRESS, SPENDER],
            }),
          },
          'latest',
        ])) as Hex,
      });
      expect(allowance).toBe(amount);
    },
  );
});
