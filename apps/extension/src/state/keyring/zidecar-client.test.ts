import { afterEach, describe, expect, test, vi } from 'vitest';
import { ZidecarClient } from './zidecar-client';

// fixtures: hand-built protobuf, the shape zidecar sends

const varint = (n: number | bigint): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};
const vField = (field: number, n: number | bigint) => [...varint(field * 8), ...varint(n)];
const lField = (field: number, data: Uint8Array | number[] | string) => {
  const b =
    typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data as number[]);
  return [...varint(field * 8 + 2), ...varint(b.length), ...b];
};
const msg = (...parts: number[][]) => Uint8Array.from(parts.flat());
const frame = (payload: Uint8Array, flags = 0) => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
};
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const fill = (n: number, b: number) => Array<number>(n).fill(b);
const hex = (b: number[]) => b.map(x => x.toString(16).padStart(2, '0')).join('');
const trailer = frame(new TextEncoder().encode('grpc-status: 0'), 0x80);

/** a copy owns its whole buffer; a view shares the response's */
const isCopy = (u: Uint8Array) => u.byteOffset === 0 && u.buffer.byteLength === u.length;

const serve = (body: Uint8Array) => {
  const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(body)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
const client = () => new ZidecarClient('https://zidecar.example/');

const action = (b: number) =>
  msg(
    lField(1, fill(32, b)),
    lField(2, fill(32, b + 1)),
    lField(3, fill(52, b + 2)),
    lField(4, fill(32, b + 3)),
    lField(5, fill(32, b + 4)),
  );
const decodedAction = (b: number) => ({
  cmx: Uint8Array.from(fill(32, b)),
  ephemeralKey: Uint8Array.from(fill(32, b + 1)),
  ciphertext: Uint8Array.from(fill(52, b + 2)),
  nullifier: Uint8Array.from(fill(32, b + 3)),
  txid: Uint8Array.from(fill(32, b + 4)),
});

describe('ZidecarClient decoding', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('GetTip: height=1, hash=2 (a copy)', async () => {
    serve(frame(msg(vField(1, 3_000_000), lField(2, fill(32, 7)))));
    const tip = await client().getTip();
    expect(tip).toEqual({ height: 3_000_000, hash: Uint8Array.from(fill(32, 7)) });
    expect(isCopy(tip.hash)).toBe(true);
  });

  test('GetCompactBlocks: height=1, hash=2, actions=3, actionsRoot=4, ironwood=5', async () => {
    const block1 = msg(
      vField(1, 100),
      lField(2, fill(32, 0xee)),
      lField(3, [...action(10)]),
      lField(3, [...action(20)]),
      lField(4, fill(32, 0xaa)),
      lField(5, [...action(30)]),
    );
    const block2 = msg(vField(1, 101), lField(2, fill(32, 0xef)));
    serve(concat(frame(block1), frame(block2), trailer));
    const blocks = await client().getCompactBlocks(100, 101);
    expect(blocks).toEqual([
      {
        height: 100,
        hash: Uint8Array.from(fill(32, 0xee)),
        actions: [decodedAction(10), decodedAction(20)],
        actionsRoot: Uint8Array.from(fill(32, 0xaa)),
        ironwoodActions: [decodedAction(30)],
      },
      { height: 101, hash: Uint8Array.from(fill(32, 0xef)), actions: [] },
    ]);
    expect(isCopy(blocks[0]!.actionsRoot!)).toBe(true);
    expect(isCopy(blocks[0]!.hash)).toBe(false);
    expect(isCopy(blocks[0]!.actions[0]!.cmx)).toBe(false);
  });

  test('GetMempoolStream decodes the same blocks', async () => {
    serve(concat(frame(msg(lField(2, fill(32, 1)), lField(3, [...action(5)]))), trailer));
    await expect(client().getMempoolStream()).resolves.toEqual([
      { height: 0, hash: Uint8Array.from(fill(32, 1)), actions: [decodedAction(5)] },
    ]);
  });

  test('GetBlockTransactions: height=1, hash=2, txs=3 RawTransaction', async () => {
    serve(
      frame(
        msg(
          vField(1, 2_000_000),
          lField(2, fill(32, 3)),
          lField(3, [...msg(lField(1, [9, 9]), vField(2, 2_000_000))]),
          lField(3, [...msg(lField(1, [8]))]),
        ),
      ),
    );
    const got = await client().getBlockTransactions(2_000_000);
    expect(got).toEqual({
      height: 2_000_000,
      hash: Uint8Array.from(fill(32, 3)),
      txs: [
        { data: Uint8Array.from([9, 9]), height: 2_000_000 },
        { data: Uint8Array.from([8]), height: 0 },
      ],
    });
    expect(isCopy(got.hash)).toBe(true);
    expect(isCopy(got.txs[0]!.data)).toBe(true);
  });

  test('GetTransaction: RawTransaction { data=1 (a copy); height=2 }', async () => {
    serve(frame(msg(lField(1, [1, 2, 3, 4]), vField(2, 2_500_000))));
    const got = await client().getTransaction(new Uint8Array(32));
    expect(got).toEqual({ data: Uint8Array.from([1, 2, 3, 4]), height: 2_500_000 });
    expect(isCopy(got.data)).toBe(true);
  });

  test('GetAddressUtxos: 64-bit valueZat kept exactly', async () => {
    const big = 2n ** 60n + 12345n;
    const reply = (value: bigint, idx: number) =>
      msg(
        lField(1, 't1abc'),
        lField(2, fill(32, idx)),
        vField(3, idx),
        lField(4, [0x76, 0xa9]),
        vField(5, value),
        vField(6, 2_900_000 + idx),
      );
    serve(frame(msg(lField(1, [...reply(big, 1)]), vField(2, 7), lField(1, [...reply(5000n, 2)]))));
    await expect(client().getAddressUtxos('t1abc')).resolves.toEqual([
      {
        address: 't1abc',
        txid: Uint8Array.from(fill(32, 1)),
        outputIndex: 1,
        script: Uint8Array.from([0x76, 0xa9]),
        valueZat: big,
        height: 2_900_001,
      },
      {
        address: 't1abc',
        txid: Uint8Array.from(fill(32, 2)),
        outputIndex: 2,
        script: Uint8Array.from([0x76, 0xa9]),
        valueZat: 5000n,
        height: 2_900_002,
      },
    ]);
  });

  test('GetTaddressTxids: TxidList { txids=1 repeated }', async () => {
    serve(frame(msg(lField(1, fill(32, 1)), vField(2, 5), lField(1, fill(32, 2)))));
    await expect(client().getTaddressTxids('t1abc')).resolves.toEqual([
      Uint8Array.from(fill(32, 1)),
      Uint8Array.from(fill(32, 2)),
    ]);
  });

  test('GetTreeState: height=1, time=3, orchard=5, ironwood=6', async () => {
    serve(
      frame(
        msg(
          vField(1, 2_800_000),
          lField(2, fill(32, 1)),
          vField(3, 1_700_000_000),
          lField(4, 'sapling'),
          lField(5, '01ab'),
        ),
      ),
    );
    await expect(client().getTreeState(2_800_000)).resolves.toEqual({
      height: 2_800_000,
      orchardTree: '01ab',
      time: 1_700_000_000,
    });
    serve(frame(msg(vField(1, 5), lField(5, 'aa'), lField(6, 'bb'), vField(3, 9))));
    await expect(client().getTreeState(5)).resolves.toEqual({
      height: 5,
      orchardTree: 'aa',
      ironwoodTree: 'bb',
      time: 9,
    });
  });

  test('GetBlock: the first time=5', async () => {
    serve(
      frame(
        msg(
          vField(1, 10),
          lField(2, fill(32, 1)),
          vField(5, 1_650_000_000),
          vField(5, 1_650_000_001),
        ),
      ),
    );
    await expect(client().getBlockTime(10)).resolves.toBe(1_650_000_000);
    serve(frame(msg(vField(1, 10))));
    await expect(client().getBlockTime(10)).resolves.toBe(0);
  });

  test('SendTransaction: SendResponse { txid=1 (a copy); errorCode=2; errorMessage=3 }', async () => {
    serve(frame(msg(lField(1, fill(32, 4)), vField(2, 18), lField(3, 'bad-txns'))));
    const got = await client().sendTransaction(Uint8Array.from([1]));
    expect(got).toEqual({
      txid: Uint8Array.from(fill(32, 4)),
      errorCode: 18,
      errorMessage: 'bad-txns',
    });
    expect(isCopy(got.txid)).toBe(true);
  });

  test('SignAnchor: signature=1, verifierKey=2 (hex), available=3', async () => {
    serve(frame(msg(lField(1, fill(64, 0xab)), lField(2, fill(32, 0x01)), vField(3, 1))));
    await expect(client().signAnchor(new Uint8Array(32), 100, true)).resolves.toEqual({
      available: true,
      signatureHex: hex(fill(64, 0xab)),
      verifierKeyHex: hex(fill(32, 0x01)),
    });
    serve(frame(new Uint8Array(0)));
    await expect(client().signAnchor(new Uint8Array(32), 100, true)).resolves.toEqual({
      available: false,
      signatureHex: '',
      verifierKeyHex: '',
    });
  });

  test('GetProRing: ringKeys=1 (hex), commitment=2 (a copy), epoch=3, context=4, ringSize=5', async () => {
    serve(
      frame(
        msg(
          lField(1, fill(32, 1)),
          lField(1, fill(32, 2)),
          lField(2, fill(144, 3)),
          lField(3, '2026-10-08'),
          lField(4, 'zafu-pro:nonce'),
          vField(5, 2),
        ),
      ),
    );
    const ring = await client().getProRing();
    expect(ring).toEqual({
      ringKeys: [hex(fill(32, 1)), hex(fill(32, 2))],
      commitment: Uint8Array.from(fill(144, 3)),
      epoch: '2026-10-08',
      context: 'zafu-pro:nonce',
      ringSize: 2,
    });
    expect(isCopy(ring.commitment)).toBe(true);
  });

  test('GetLicense: zid=1, plan=2, expires=3, signature=4 (hex), totalPaidZat=5', async () => {
    serve(
      frame(
        msg(
          lField(1, 'zid1'),
          lField(2, 'pro'),
          vField(3, 1_800_000_000),
          lField(4, fill(64, 0xcd)),
          vField(5, 100_000_000),
        ),
      ),
    );
    await expect(client().checkLicense('zid1')).resolves.toEqual({
      zid: 'zid1',
      plan: 'pro',
      expires: 1_800_000_000,
      signature: hex(fill(64, 0xcd)),
      totalPaidZat: 100_000_000,
    });
    serve(frame(new Uint8Array(0)));
    await expect(client().checkLicense('zid1')).resolves.toEqual({
      zid: '',
      plan: 'free',
      expires: 0,
      signature: '',
      totalPaidZat: 0,
    });
  });
});
