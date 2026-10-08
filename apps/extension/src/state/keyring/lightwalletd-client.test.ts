import { afterEach, describe, expect, test, vi } from 'vitest';
import { LightwalletdClient } from './lightwalletd-client';

// fixtures: hand-built protobuf, the shape a lightwalletd sends

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

const serve = (body: Uint8Array) => {
  const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(body)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
const client = () => new LightwalletdClient('https://lwd.example/');

describe('LightwalletdClient decoding', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('GetLatestBlock: BlockID { height=1; hash=2 }', async () => {
    serve(frame(msg(vField(1, 3_000_000), lField(2, fill(32, 7)))));
    await expect(client().getTip()).resolves.toEqual({
      height: 3_000_000,
      hash: Uint8Array.from(fill(32, 7)),
    });
  });

  test('GetTreeState: height=2, time=4, orchardTree=6, ironwoodTree=7', async () => {
    serve(
      frame(
        msg(
          lField(1, 'main'),
          vField(2, 2_800_000),
          lField(3, fill(32, 1)),
          vField(4, 1_700_000_000),
          lField(5, 'sapling'),
          lField(6, '01ab'),
        ),
      ),
    );
    await expect(client().getTreeState(2_800_000)).resolves.toEqual({
      height: 2_800_000,
      orchardTree: '01ab',
      time: 1_700_000_000,
    });
    serve(frame(msg(vField(2, 5), lField(6, 'aa'), lField(7, 'bb'), vField(4, 9))));
    await expect(client().getTreeState(5)).resolves.toEqual({
      height: 5,
      orchardTree: 'aa',
      ironwoodTree: 'bb',
      time: 9,
    });
  });

  test('GetBlockRange: blocks, txs and actions; txid to display order', async () => {
    const txid = Array.from({ length: 32 }, (_, i) => i);
    const action = (b: number) =>
      msg(
        lField(1, fill(32, b)),
        lField(2, fill(32, b + 1)),
        lField(3, fill(32, b + 2)),
        lField(4, fill(52, b + 3)),
      );
    const tx = msg(
      vField(1, 0),
      lField(2, txid),
      lField(6, [...action(10)]),
      lField(6, [...action(20)]),
      lField(9, [...action(30)]),
    );
    const block1 = msg(
      vField(1, 1),
      vField(2, 100),
      lField(3, fill(32, 0xee)),
      vField(5, 77),
      lField(7, [...tx]),
    );
    const block2 = msg(vField(2, 101), lField(3, fill(32, 0xef)));
    serve(
      concat(frame(block1), frame(block2), frame(new TextEncoder().encode('grpc-status: 0'), 0x80)),
    );
    const blocks = await client().getCompactBlocks(100, 101);
    const display = Uint8Array.from(txid).reverse();
    const a = (b: number) => ({
      nullifier: Uint8Array.from(fill(32, b)),
      cmx: Uint8Array.from(fill(32, b + 1)),
      ephemeralKey: Uint8Array.from(fill(32, b + 2)),
      ciphertext: Uint8Array.from(fill(52, b + 3)),
      txid: display,
    });
    expect(blocks).toEqual([
      {
        height: 100,
        hash: Uint8Array.from(fill(32, 0xee)),
        actions: [a(10), a(20)],
        ironwoodActions: [a(30)],
      },
      { height: 101, hash: Uint8Array.from(fill(32, 0xef)), actions: [] },
    ]);
  });

  test('GetAddressUtxos: 64-bit valueZat kept exactly', async () => {
    const big = 2n ** 60n + 12345n;
    const reply = (value: bigint, idx: number) =>
      msg(
        lField(1, fill(32, idx)),
        vField(2, idx),
        lField(3, [0x76, 0xa9]),
        vField(4, value),
        vField(5, 2_900_000 + idx),
        lField(6, 't1abc'),
      );
    serve(frame(msg(lField(1, [...reply(big, 1)]), lField(1, [...reply(5000n, 2)]))));
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

  test('GetTransaction: RawTransaction { data=1; height=2 }', async () => {
    serve(frame(msg(lField(1, [1, 2, 3, 4]), vField(2, 2_500_000))));
    await expect(client().getTransaction(new Uint8Array(32))).resolves.toEqual({
      data: Uint8Array.from([1, 2, 3, 4]),
      height: 2_500_000,
    });
  });

  test('GetBlock: time=5', async () => {
    serve(frame(msg(vField(2, 10), lField(3, fill(32, 1)), vField(5, 1_650_000_000))));
    await expect(client().getBlockTime(10)).resolves.toBe(1_650_000_000);
  });

  test('SendTransaction: SendResponse { errorCode=1; errorMessage=2 }', async () => {
    serve(frame(msg(vField(1, 18), lField(2, 'bad-txns'))));
    await expect(client().sendTransaction(Uint8Array.from([1]))).resolves.toEqual({
      txid: new Uint8Array(0),
      errorCode: 18,
      errorMessage: 'bad-txns',
    });
  });

  test('unknown fixed-width fields are skipped', async () => {
    serve(frame(msg([0x19, ...fill(8, 0xff)], [0x25, ...fill(4, 0xff)], vField(1, 42))));
    await expect(client().getTip()).resolves.toEqual({ height: 42, hash: new Uint8Array(0) });
  });
});
