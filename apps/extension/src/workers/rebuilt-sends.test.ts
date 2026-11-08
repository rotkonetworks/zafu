import { describe, expect, it } from 'vitest';
import { scriptAddress } from '../ledger/address';
import { transparentInputs, transparentOutputs, v5TransparentParts } from './transparent-deposit';
import { rebuildSends, type TOuts } from './rebuilt-sends';

// mainnet 2026-11-08: the tex payment (e62da7a4...) whose record an older build pruned,
// spending the one coin its move (0efd9b9d...) put on the fresh address
const PAY_HEX =
  '050000800a27a726d90a1977000000007a2b36000161bfc6e2269ec5e32dae2c2e7dcc7b9bf270517b8ea6eeaac763d5139d9bfd0e000000006b483045022100ee0015035ce13615de4846563f84e91beecf71351efa029c439d2ded088fd233022046642db3ea050c5b7406f988c38e56f716a4b3f6297a6c34359f7b7ec15f384501210370b838cceeb8a229fa5151b9c5da627c27aab840423e43543f8c8e8afb635f74ffffffff0180778e06000000001976a91447d30f1396e5766a7986814191b1f17fbfd1603988ac000000';
const PAY = 'e62da7a4281993326214d49a26523288acda9c7d412110ae71b18d5d51e4cf34';
const MOVE = '0efd9b9d13d563c7aaeea68e7b5170f29b7bcc7d2e2cae2de3c59e26e2c6bf61';
const FRESH = '76a914' + '11'.repeat(20) + '88ac';

const move: TOuts = {
  txid: MOVE,
  height: 3_549_950,
  inputs: [],
  outputs: [{ value: 110_010_000n, script: FRESH, ours: true }],
};
const pay: TOuts = {
  txid: PAY,
  height: 3_549_956,
  inputs: transparentInputs(PAY_HEX),
  outputs: transparentOutputs(PAY_HEX).map(o => ({ ...o, ours: o.script === FRESH })),
};
const addr = (s: string) => scriptAddress(s, true);

describe('rebuildSends', () => {
  it('rebuilds the lost tex payment: what it paid, its fee, folded with its move', async () => {
    expect(pay.inputs).toEqual([{ txid: MOVE, vout: 0 }]);
    const [rec, ...rest] = await rebuildSends([move, pay], new Set([MOVE]), 'w', addr);
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      txid: PAY,
      amount: '110000000',
      fee: '10000',
      pool: 'transparent',
      kind: 'send',
      confirmedHeight: 3_549_956,
      moveTxid: MOVE,
    });
    // the exchange's tex is the P2PKH of this hash: its t1 twin is what the chain can name
    expect(rec!.recipient).toMatch(/^t1/);
  });

  it('leaves alone what it already knows, a self-transfer, and coins that are not all ours', async () => {
    expect(await rebuildSends([move, pay], new Set([MOVE, PAY]), 'w', addr)).toEqual([]);
    const self: TOuts = {
      ...pay,
      outputs: pay.outputs.map(o => ({ ...o, ours: true })),
    };
    expect(await rebuildSends([move, self], new Set([MOVE]), 'w', addr)).toEqual([]);
    expect(await rebuildSends([pay], new Set(), 'w', addr)).toEqual([]);
  });

  it('reads coins only from a v5 transaction, whose layout it knows', () => {
    expect(v5TransparentParts(PAY_HEX)?.inputs).toEqual([{ txid: MOVE, vout: 0 }]);
    expect(v5TransparentParts('06000080' + PAY_HEX.slice(8))).toBeUndefined();
  });
});
