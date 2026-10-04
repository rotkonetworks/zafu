import { describe, expect, it } from 'vitest';
import { Any } from '@bufbuild/protobuf';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  ActionView,
  TransactionPerspective,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import {
  AssetId,
  Denom,
  Metadata,
  ValueView,
} from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Address, AddressView } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { NoteView } from '@penumbra-zone/protobuf/penumbra/core/component/shielded_pool/v1/shielded_pool_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { MsgRecvPacket, MsgTimeout } from '@penumbra-zone/protobuf/ibc/core/channel/v1/tx_pb';
import { MsgUpdateClient } from '@penumbra-zone/protobuf/ibc/core/client/v1/tx_pb';
import { Packet } from '@penumbra-zone/protobuf/ibc/core/channel/v1/channel_pb';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { bech32mIdentityKey, identityKeyFromBech32m } from '@penumbra-zone/bech32m/penumbravalid';
import { IdentityKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { positionIdFromBech32 } from '@penumbra-zone/bech32m/plpid';
import {
  describePenumbraHistory,
  describePenumbraTx,
  formatUnits,
  penumbraRefs,
  shortAmount,
  type PenumbraEntry,
} from './penumbra-describe';

// ── fixtures, shaped like the view service's TransactionInfo ──

const registry = new ChainRegistryClient().bundled.get('penumbra-1');
const reg = (denom: string) => registry.getMetadata(new Denom({ denom }));
const UM = reg('upenumbra');
const USDC_INJ = reg('transfer/channel-18/erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a');
const USDC_NOBLE = reg('transfer/channel-2/uusdc');
const INJ = reg('transfer/channel-18/inj');

const PLPID = 'plpid1uly5l23j5m770lfgle5galq74pdk677eranfvw4fctsccl5hfplsm8qajr';
const PATHROCK = 'penumbravalid1gq4j0hh6grl6d7apwg8z5qj97q7uhkeq0tp9qr66xe03cyrjkyrskp7s6v';

let seed = 1;
const bytes = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 33 + 7) % 251));
const local = (base: string, display: string, exponent: number, symbol = '') =>
  new Metadata({
    base,
    display,
    symbol,
    denomUnits: [{ denom: base, exponent: 0 }, ...(exponent ? [{ denom: display, exponent }] : [])],
    penumbraAssetId: new AssetId({ inner: bytes(32) }),
  });
const LP_OPENED = local(`lpnft_opened_${PLPID}`, `lpnft_opened_${PLPID}`, 0);
const LP_CLOSED = local(`lpnft_closed_${PLPID}`, `lpnft_closed_${PLPID}`, 0);
const UNBONDING = local(
  `uunbonding_start_at_12850022_${PATHROCK}`,
  `unbonding_start_at_12850022_${PATHROCK}`,
  6,
);
const ODD_P = local('p', 'p', 0);

const amount = (x: bigint) => new Amount({ lo: x & ((1n << 64n) - 1n), hi: x >> 64n });
const units = (s: string, exp: number) => {
  const [i, f = ''] = s.split('.');
  return BigInt(i! + f.padEnd(exp, '0'));
};
const vv = (meta: Metadata, x: bigint) =>
  new ValueView({
    valueView: { case: 'knownAssetId', value: { amount: amount(x), metadata: meta } },
  });

const ours = new Address({ inner: bytes(80) });
const theirs = new Address({ inner: bytes(80) });
const OURS = bech32mAddress(ours);
const THEIRS = bech32mAddress(theirs);
const mine = (account = 0) =>
  new AddressView({
    addressView: { case: 'decoded', value: { address: ours, index: { account } } },
  });
const other = () =>
  new AddressView({ addressView: { case: 'opaque', value: { address: theirs } } });

const note = (meta: Metadata, x: bigint, address = mine()) =>
  new NoteView({ value: vv(meta, x), address });
const spend = (n: NoteView) =>
  new ActionView({
    actionView: { case: 'spend', value: { spendView: { case: 'visible', value: { note: n } } } },
  });
const opaqueSpend = () =>
  new ActionView({
    actionView: { case: 'spend', value: { spendView: { case: 'opaque', value: {} } } },
  });
const output = (n: NoteView) =>
  new ActionView({
    actionView: { case: 'output', value: { outputView: { case: 'visible', value: { note: n } } } },
  });
const act = (a: ActionView['actionView']) => new ActionView({ actionView: a });
const relay = (msg: MsgRecvPacket | MsgTimeout | MsgUpdateClient) =>
  act({ case: 'ibcRelayAction', value: { rawAction: Any.pack(msg) } });
const packet = (p: Partial<Packet>, data: object) =>
  new Packet({
    sourcePort: 'transfer',
    destinationPort: 'transfer',
    ...p,
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

const FEE = units('0.0004', 6);
const txId = (n: number) => new Uint8Array(32).fill(n);
const hexId = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const tx = (
  n: number,
  actions: ActionView[],
  extra: { fee?: bigint; addressViews?: AddressView[] } = {},
) =>
  new TransactionInfo({
    id: { inner: txId(n) },
    height: BigInt(1000 + n),
    view: {
      bodyView: {
        actionViews: actions,
        transactionParameters: { fee: { amount: amount(extra.fee ?? FEE) } },
      },
    },
    perspective: new TransactionPerspective({ addressViews: extra.addressViews ?? [] }),
  });

/** what a row reads: title, the lead amount, the quiet detail */
const row = (e: PenumbraEntry) =>
  [
    e.title,
    e.amounts
      .map(a => `${{ in: '+', out: '−', neutral: '' }[a.direction]}${a.amount} ${a.asset.display}`)
      .join(' '),
    e.detail?.display,
    e.counterparty?.display,
  ]
    .filter(Boolean)
    .join(' · ');

// ── the founder's list, one transaction each ──

const lpOpenUsdc = tx(1, [
  spend(note(USDC_INJ, units('20', 6))),
  output(note(USDC_INJ, units('7.961727', 6))),
  spend(note(UM, units('1', 6))),
  output(note(UM, units('1', 6) - FEE)),
  act({ case: 'positionOpen', value: {} }),
  output(note(LP_OPENED, 1n)),
]);
const lpClose = tx(2, [
  spend(note(LP_OPENED, 1n)),
  act({ case: 'positionClose', value: { positionId: positionIdFromBech32(PLPID) } }),
  output(note(LP_CLOSED, 1n)),
  spend(note(UM, units('1', 6))),
  output(note(UM, units('1', 6) - FEE)),
]);
const strangersRelay = tx(3, [
  relay(new MsgUpdateClient({ clientId: '07-tendermint-0' })),
  relay(
    new MsgRecvPacket({
      packet: packet(
        { sourceChannel: 'channel-4', destinationChannel: 'channel-2' },
        { denom: 'uusdc', amount: '1000', sender: 'noble1x', receiver: THEIRS },
      ),
    }),
  ),
  relay(
    new MsgRecvPacket({
      packet: packet(
        { sourceChannel: 'channel-4', destinationChannel: 'channel-2' },
        { denom: 'uusdc', amount: '2000', sender: 'noble1y', receiver: 'penumbra1someoneelse' },
      ),
    }),
  ),
]);
const unstakeClaim = tx(4, [
  spend(note(UNBONDING, units('105.932984', 6))),
  act({
    case: 'undelegateClaim',
    value: {
      body: {
        validatorIdentity: identityKeyFromBech32m(PATHROCK),
        unbondingStartHeight: 12850022n,
      },
    },
  }),
  output(note(UM, units('105.932984', 6) - FEE)),
]);
const lpOpenUm = tx(5, [
  spend(note(UM, units('600', 6))),
  output(note(UM, units('600', 6) - units('530.339468', 6) - FEE)),
  act({ case: 'positionOpen', value: {} }),
  output(note(LP_OPENED, 1n)),
]);
const swap = tx(6, [
  spend(note(USDC_INJ, units('10', 6))),
  output(note(USDC_INJ, units('2', 6))),
  act({
    case: 'swap',
    value: {
      swapView: {
        case: 'visible',
        value: {
          swapPlaintext: {
            tradingPair: { asset1: UM.penumbraAssetId, asset2: USDC_INJ.penumbraAssetId },
            delta1I: amount(0n),
            delta2I: amount(units('8', 6)),
          },
          asset1Metadata: UM,
          asset2Metadata: USDC_INJ,
          claimTx: { inner: txId(7) },
        },
      },
    },
  }),
]);
const swapClaim = tx(
  7,
  [
    act({
      case: 'swapClaim',
      value: {
        swapClaimView: {
          case: 'visible',
          value: {
            output1: note(UM, units('30.5', 6)),
            output2: note(USDC_INJ, 0n),
            swapTx: { inner: txId(6) },
          },
        },
      },
    }),
  ],
  { fee: 0n },
);
const receiveInj = tx(8, [opaqueSpend(), output(note(INJ, units('3.33', 18)))]);
const receiveP = tx(9, [opaqueSpend(), output(note(ODD_P, 1n))]);

const FOUNDER = [
  lpOpenUsdc,
  lpClose,
  strangersRelay,
  unstakeClaim,
  lpOpenUm,
  swap,
  swapClaim,
  receiveInj,
  receiveP,
];

// ── more shapes ──

const stake = tx(10, [
  spend(note(UM, units('50', 6))),
  act({
    case: 'delegate',
    value: {
      validatorIdentity: identityKeyFromBech32m(PATHROCK),
      unbondedAmount: amount(units('49', 6)),
    },
  }),
]);
const unknownValidator = new IdentityKey({ ik: bytes(32) });
const UNKNOWN_VALID = bech32mIdentityKey(unknownValidator);
const unstake = tx(11, [
  act({
    case: 'undelegate',
    value: {
      validatorIdentity: identityKeyFromBech32m(PATHROCK),
      unbondedAmount: amount(units('105.932984', 6)),
    },
  }),
]);
const send = tx(12, [
  spend(note(UM, units('100', 6))),
  output(note(UM, units('25', 6), other())),
  output(note(UM, units('75', 6) - FEE)),
]);
const withdrawToNoble = tx(13, [
  spend(note(USDC_NOBLE, units('12', 6))),
  output(note(USDC_NOBLE, units('2', 6))),
  act({
    case: 'ics20Withdrawal',
    value: {
      amount: amount(units('10', 6)),
      denom: { denom: 'transfer/channel-2/uusdc' },
      destinationChainAddress: 'noble1qz2w3e4r5t6y7u8x9e0pqa2s3d4f5g6h7j8k9l0',
      sourceChannel: 'channel-2',
    },
  }),
  spend(note(UM, units('1', 6))),
  output(note(UM, units('1', 6) - FEE)),
]);
const depositFromNoble = tx(
  14,
  [
    relay(new MsgUpdateClient({ clientId: '07-tendermint-0' })),
    relay(
      new MsgRecvPacket({
        packet: packet(
          { sourceChannel: 'channel-4', destinationChannel: 'channel-2' },
          { denom: 'uusdc', amount: '5000000', sender: 'noble1someone', receiver: 'penumbra1abc' },
        ),
      }),
    ),
    relay(
      new MsgRecvPacket({
        packet: packet(
          { sourceChannel: 'channel-4', destinationChannel: 'channel-2' },
          {
            denom: 'uusdc',
            amount: '7250000',
            sender: 'noble1sender000000000000000',
            receiver: OURS,
          },
        ),
      }),
    ),
  ],
  { addressViews: [mine()] },
);
const refundFromNoble = tx(15, [
  relay(
    new MsgTimeout({
      packet: packet(
        { sourceChannel: 'channel-2', destinationChannel: 'channel-4' },
        {
          denom: 'transfer/channel-2/uusdc',
          amount: '10000000',
          sender: OURS,
          receiver: 'noble1qz2w3e4r5t6y7u8x9e0pqa2s3d4f5g6h7j8k9l0',
        },
      ),
    }),
  ),
]);
const closeAndWithdrawTwo = tx(16, [
  act({ case: 'positionClose', value: { positionId: positionIdFromBech32(PLPID) } }),
  act({ case: 'positionWithdraw', value: { positionId: { inner: bytes(32) } } }),
  output(note(USDC_INJ, units('12.5', 6))),
  output(note(UM, units('3', 6))),
]);
const unstakeUnknown = tx(17, [
  act({
    case: 'undelegate',
    value: {
      validatorIdentity: unknownValidator,
      unbondedAmount: amount(units('1', 6)),
    },
  }),
]);

const CASES: [string, TransactionInfo, string][] = [
  [
    'lp open with usdc reserves',
    lpOpenUsdc,
    'liquidity position opened · −12.04 USDC · position uly5l2…qajr',
  ],
  [
    'lp close, the -1 nft is no amount',
    lpClose,
    'liquidity position closed · position uly5l2…qajr',
  ],
  [
    'unstake claim, in UM, named validator',
    unstakeClaim,
    'unstake claim · +105.93 UM · PathrockNetwork',
  ],
  [
    'lp open with UM reserves',
    lpOpenUm,
    'liquidity position opened · −530.34 UM · position uly5l2…qajr',
  ],
  ['receive over injective', receiveInj, 'received · +3.33 INJ · via injective finance'],
  ['receive of an asset nobody names', receiveP, 'received · +1 unknown asset · p'],
  ['stake, in UM, named validator', stake, 'stake · −49 UM · PathrockNetwork'],
  ['unstake moves no money yet', unstake, 'unstake · 105.93 UM · PathrockNetwork'],
  [
    'unstake from a validator we cannot name',
    unstakeUnknown,
    `unstake · 1 UM · ${UNKNOWN_VALID.slice(14, 20)}…${UNKNOWN_VALID.slice(-4)}`,
  ],
  [
    'send, fee left out, recipient short',
    send,
    `sent · −25 UM · ${THEIRS.slice(0, 13)}…${THEIRS.slice(-4)}`,
  ],
  ['withdraw to noble', withdrawToNoble, 'sent to noble · −10 USDC · via noble · noble1qz2w…k9l0'],
  [
    'deposit picks our packet out of the batch',
    depositFromNoble,
    'received from noble · +7.25 USDC · via noble · noble1send…0000',
  ],
  [
    'timeout refund',
    refundFromNoble,
    'returned from noble · +10 USDC · via noble · noble1qz2w…k9l0',
  ],
  [
    'one row per transaction, two positions',
    closeAndWithdrawTwo,
    'liquidity position withdrawn · +12.5 USDC +3 UM · 2 positions',
  ],
];

describe('describePenumbraTx', () => {
  it.each(CASES)('%s', (_, info, expected) => {
    expect(row(describePenumbraTx(info))).toBe(expected);
  });

  it('keeps the fee apart', () => {
    const e = describePenumbraTx(send);
    expect(e.fee).toMatchObject({ exact: '0.0004', asset: { display: 'UM' } });
    expect(describePenumbraTx(receiveInj).fee).toBeUndefined();
  });

  it('hides relayer traffic with nothing for this wallet', () => {
    expect(describePenumbraTx(strangersRelay).hidden).toBe(true);
  });

  it('keeps every raw id one copy away', () => {
    const e = describePenumbraTx(lpOpenUsdc);
    expect(e.detail?.raw).toBe(PLPID);
    expect(e.amounts[0]!.asset.raw).toBe(USDC_INJ.base);
    expect(penumbraRefs(e).map(r => r.raw)).toEqual([PLPID, USDC_INJ.base]);
    expect(describePenumbraTx(unstakeClaim).detail?.raw).toBe(PATHROCK);
    expect(penumbraRefs(describePenumbraTx(send), THEIRS).some(r => r.raw === THEIRS)).toBe(false);
  });

  it('carries the account a deposit landed in', () => {
    expect([...describePenumbraTx(depositFromNoble).accountIndices]).toEqual([0]);
  });
});

describe('describePenumbraHistory', () => {
  const list = describePenumbraHistory(FOUNDER);

  it('reads the founder list calmly', () => {
    expect(list.map(row)).toEqual([
      'received · +1 unknown asset · p',
      'received · +3.33 INJ · via injective finance',
      'swap · −8 USDC +30.5 UM · USDC → UM',
      'liquidity position opened · −530.34 UM · position uly5l2…qajr',
      'unstake claim · +105.93 UM · PathrockNetwork',
      'liquidity position closed · position uly5l2…qajr',
      'liquidity position opened · −12.04 USDC · position uly5l2…qajr',
    ]);
  });

  it('folds the claim into its swap', () => {
    const s = list.find(e => e.kind === 'swap')!;
    expect(s.id).toBe(hexId(6));
    expect(s.claimTxId).toBe(hexId(7));
    expect(list.some(e => e.id === hexId(7))).toBe(false);
  });

  it('keeps a claim whose swap is not in the list', () => {
    expect(describePenumbraHistory([swapClaim]).map(row)).toEqual(['swap · +30.5 UM · → UM']);
  });

  const everything = describePenumbraHistory([
    ...FOUNDER,
    stake,
    unstake,
    send,
    withdrawToNoble,
    depositFromNoble,
    refundFromNoble,
    closeAndWithdrawTwo,
    unstakeUnknown,
  ]);
  const displays = everything.flatMap(e => [
    e.title,
    e.detail?.display ?? '',
    e.counterparty?.display ?? '',
    ...e.amounts.flatMap(a => [a.amount, a.asset.display]),
  ]);

  it('never shows a display longer than 32 characters', () => {
    expect(displays.filter(d => d.length > 32)).toEqual([]);
  });

  it('never shows a base denom or a raw id', () => {
    expect(
      displays.filter(d =>
        /transfer\/|lpnft_|unbonding_|delegation_|penumbravalid1|plpid1/.test(d),
      ),
    ).toEqual([]);
  });
});

describe('amounts', () => {
  it.each([
    [12038273n, 6, '12.04', '12.038273'],
    [105932984n, 6, '105.93', '105.932984'],
    [400n, 6, '0.0004', '0.0004'],
    [1n, 18, '<0.000001', '0.000000000000000001'],
    [1n, 0, '1', '1'],
    [3330000000000000000n, 18, '3.33', '3.33'],
  ])('%s at 10^-%s reads %s', (base, exp, short, exact) => {
    expect(shortAmount(base, exp)).toBe(short);
    expect(formatUnits(base, exp)).toBe(exact);
  });
});
