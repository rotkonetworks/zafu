/**
 * A Penumbra transaction, as one calm history row.
 *
 * Pure: reads only what the view service already returned (the transaction
 * view, its perspective) and the registry bundled into the extension. No
 * request is made. Every id-like value comes out as `{ display, raw }`: the row
 * shows `display` (short, human, never a base denom), hover and the detail
 * screen's copy button use `raw`.
 */

import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import type { ActionView } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import type {
  AssetId,
  Metadata,
  ValueView,
} from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import type { AddressView } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import type { NoteView } from '@penumbra-zone/protobuf/penumbra/core/component/shielded_pool/v1/shielded_pool_pb';
import type { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Denom } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { ChainRegistryClient, type Registry } from '@penumbrafi/registry';
import { penumbraRegistry } from '../penumbra/asset-registry';
import { unpackIbcRelay } from '@penumbra-zone/perspective/action-view/ibc';
import { MsgRecvPacket } from '@penumbra-zone/protobuf/ibc/core/channel/v1/tx_pb';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { bech32CompatAddress } from '@penumbra-zone/bech32m/penumbracompat1';
import { bech32mIdentityKey } from '@penumbra-zone/bech32m/penumbravalid';
import { bech32mPositionId } from '@penumbra-zone/bech32m/plpid';
import { bech32mAssetId } from '@penumbra-zone/bech32m/passet';

export interface PenumbraRef {
  /** what the value is, for the detail screen: "position", "validator", "to" */
  label: string;
  /** short and human, at most 32 characters */
  display: string;
  /** the full value, for hover and copy */
  raw: string;
}

export interface PenumbraAmount {
  direction: 'in' | 'out' | 'neutral';
  /** rounded for a row: "12.04" */
  amount: string;
  /** every digit: "12.038273" */
  exact: string;
  /** display = symbol ("USDC"), raw = base denom */
  asset: PenumbraRef;
}

export type PenumbraKind =
  | 'send'
  | 'receive'
  | 'internal'
  | 'deposit'
  | 'withdraw'
  | 'refund'
  | 'swap'
  | 'liquidity'
  | 'stake'
  | 'unstake'
  | 'unstake-claim'
  | 'vote'
  | 'unknown';

export interface PenumbraEntry {
  id: string;
  height: number;
  kind: PenumbraKind;
  title: string;
  /** what moved for this wallet, fee excluded; the first one leads the row */
  amounts: PenumbraAmount[];
  counterparty?: PenumbraRef;
  /** one quiet line: position, validator, the chain an asset came over */
  detail?: PenumbraRef;
  fee?: PenumbraAmount;
  memo?: string;
  accountIndices: Set<number>;
  /** nothing in it for this wallet (someone else's relayer traffic) */
  hidden: boolean;
  /** swap <-> claim pairing, hex tx ids */
  swapTxId?: string;
  claimTxId?: string;
}

// ── registry ──

interface Lookup {
  registry?: Registry;
  validatorNames: Map<string, string>;
  /** metadata the view service already knew, by asset id (base64) */
  local: Map<string, Metadata>;
  mine: Set<string>;
}

let staking: AssetId | undefined;
const stakingAssetId = () =>
  (staking ??= new ChainRegistryClient().bundled.globals().stakingAssetId);

let bundled: { registry?: Registry; validatorNames: Map<string, string> } | undefined;
/**
 * The registry zafu currently trusts (live if stored, else bundled - see
 * ../penumbra/asset-registry), with its validator names cached alongside;
 * recomputed only when the trusted registry itself changes (the live one
 * loads once, at boot).
 */
const bundledRegistry = () => {
  let registry: Registry | undefined;
  try {
    registry = penumbraRegistry();
  } catch {
    // another chain id (a testnet): local metadata only
  }
  if (!bundled || bundled.registry !== registry) {
    const validatorNames = new Map<string, string>();
    for (const m of registry?.getAllAssets() ?? []) {
      const v = /delegation_(penumbravalid1[0-9a-z]+)$/.exec(m.display);
      const name = /^delUM\((.+)\)$/.exec(m.symbol)?.[1];
      if (v && name) {
        validatorNames.set(v[1]!, name);
      }
    }
    bundled = { registry, validatorNames };
  }
  return bundled;
};

// ── small pure helpers ──

const MAX = 32;
const clip = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hex = (b?: Uint8Array) =>
  b ? Array.from(b, x => x.toString(16).padStart(2, '0')).join('') : '';
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const big = (a?: Amount) => (a ? (a.hi << 64n) + a.lo : 0n);
const abs = (n: bigint) => (n < 0n ? -n : n);

/** the bech32 data part, first 6 + last 4: "plpid1uly5l2…qajr" -> "uly5l2…qajr" */
export const shortId = (id: string) => {
  const data = id.slice(id.lastIndexOf('1') + 1);
  return data.length > 12 ? `${data.slice(0, 6)}…${data.slice(-4)}` : data;
};
const shortAddress = (a: string) => {
  const hrp = a.slice(0, a.lastIndexOf('1') + 1);
  return a.length > 20 ? `${hrp}${a.slice(hrp.length, hrp.length + 4)}…${a.slice(-4)}` : a;
};

export const formatUnits = (base: bigint, exponent: number): string => {
  const s = abs(base)
    .toString()
    .padStart(exponent + 1, '0');
  const int = s.slice(0, s.length - exponent) || '0';
  const frac = exponent ? s.slice(-exponent).replace(/0+$/, '') : '';
  return frac ? `${int}.${frac}` : int;
};

/** two decimals from 1 up, six below; never rounds a real amount to zero */
export const shortAmount = (base: bigint, exponent: number): string => {
  const a = abs(base);
  const keep = a >= 10n ** BigInt(exponent) ? 2 : 6;
  if (exponent <= keep) {
    return formatUnits(a, exponent);
  }
  const step = 10n ** BigInt(exponent - keep);
  const rounded = ((a + step / 2n) / step) * step;
  return rounded === 0n ? `<${formatUnits(step, exponent)}` : formatUnits(rounded, exponent);
};

// ── assets ──

interface Asset {
  /** base denom, or the asset id when nothing names it */
  raw: string;
  symbol: string;
  exponent: number;
  /** a receipt, not money: lp position nfts, auction nfts, vote receipts */
  nft?: { label: string; display: string; raw: string; state?: string };
  /** a staking token (delegation / unbonding) of this validator */
  validator?: string;
  /** the chain an ibc asset came over */
  via?: string;
  unknown?: boolean;
}

/** receipt and staking-token denoms, matched on base or display */
const SPECIAL: [RegExp, (m: RegExpExecArray, l: Lookup) => Partial<Asset>][] = [
  [
    /^lpnft_([a-z]+)(?:_\d+)?_(plpid1[0-9a-z]+)$/,
    m => ({ nft: { label: 'position', display: shortId(m[2]!), raw: m[2]!, state: m[1] } }),
  ],
  [
    /^auctionnft_\d+_(pauctid1[0-9a-z]+)$/,
    m => ({ nft: { label: 'auction', display: shortId(m[1]!), raw: m[1]! } }),
  ],
  [
    /^u?voted_on_(\d+)$/,
    m => ({ nft: { label: 'proposal', display: `proposal #${m[1]}`, raw: m[1]! } }),
  ],
  [
    /^[um]?unbonding_start_at_\d+_(penumbravalid1[0-9a-z]+)$/,
    m => ({ symbol: 'unbonding UM', validator: m[1] }),
  ],
  [/^[um]?delegation_(penumbravalid1[0-9a-z]+)$/, m => ({ symbol: 'delUM', validator: m[1] })],
];

const resolveAsset = (l: Lookup, assetId?: AssetId, viewMeta?: Metadata): Asset => {
  const key = assetId?.inner.length ? b64(assetId.inner) : undefined;
  const reg = assetId?.inner.length ? l.registry?.tryGetMetadata(assetId) : undefined;
  const meta = reg ?? viewMeta ?? (key ? l.local.get(key) : undefined);
  if (!meta) {
    const raw = assetId?.inner.length ? bech32mAssetId(assetId) : 'unknown';
    return { raw, symbol: 'unknown asset', exponent: 0, unknown: true };
  }
  const exponent =
    meta.denomUnits.find(u => u.denom === meta.display)?.exponent ??
    Math.max(0, ...meta.denomUnits.map(u => u.exponent));
  const asset: Asset = { raw: meta.base, symbol: meta.symbol, exponent };
  for (const [re, f] of SPECIAL) {
    const m = re.exec(meta.base) ?? re.exec(meta.display);
    if (m) {
      return { ...asset, symbol: asset.symbol || 'unknown asset', ...f(m, l) };
    }
  }
  const channel = /^transfer\/(channel-\d+)\//.exec(meta.base)?.[1];
  const chain = channel ? l.registry?.ibcConnections.find(c => c.channelId === channel) : undefined;
  if (chain) {
    asset.via = chain.displayName.toLowerCase().replace(/\s*\(legacy\)$/, '');
    // "USDC.inj" over injective is plain "USDC" there; the chain goes in `via`
    asset.symbol = asset.symbol.replace(new RegExp(`\\.${chain.addressPrefix}$`, 'i'), '');
  }
  if (!asset.symbol) {
    // no symbol anywhere: the last path segment, if it reads like a ticker
    const tail = meta.display.split('/').pop() ?? '';
    asset.symbol = /^[A-Za-z][A-Za-z0-9.]{1,11}$/.test(tail) ? tail : 'unknown asset';
    asset.unknown = asset.symbol === 'unknown asset';
  }
  return asset;
};

const assetOfDenom = (l: Lookup, denom: string): Asset => {
  const meta =
    l.registry?.tryGetMetadata(new Denom({ denom })) ??
    [...l.local.values()].find(m => m.base === denom);
  return meta?.penumbraAssetId
    ? resolveAsset(l, meta.penumbraAssetId, meta)
    : { raw: denom, symbol: 'unknown asset', exponent: 0, unknown: true };
};

const valueParts = (l: Lookup, v?: ValueView): { asset: Asset; amount: bigint } | undefined => {
  if (v?.valueView.case === 'knownAssetId') {
    const { metadata, amount } = v.valueView.value;
    return { asset: resolveAsset(l, metadata?.penumbraAssetId, metadata), amount: big(amount) };
  }
  if (v?.valueView.case === 'unknownAssetId') {
    const { assetId, amount } = v.valueView.value;
    return { asset: resolveAsset(l, assetId), amount: big(amount) };
  }
  return undefined;
};

const toAmount = (
  asset: Asset,
  amount: bigint,
  direction: PenumbraAmount['direction'],
): PenumbraAmount => ({
  direction,
  amount: shortAmount(amount, asset.exponent),
  exact: formatUnits(amount, asset.exponent),
  asset: { label: 'asset', display: clip(asset.symbol, 16), raw: asset.raw },
});

// ── addresses ──

const addressStrings = (av?: AddressView): string[] => {
  const a = av?.addressView.value?.address;
  if (!a?.inner.length) {
    return [];
  }
  try {
    return [bech32mAddress(a), bech32CompatAddress(a)];
  } catch {
    return [];
  }
};
const isMine = (av?: AddressView) => av?.addressView.case === 'decoded';

/** penumbra account indices this transaction touched */
export function penumbraAccountIndices(info: TransactionInfo): Set<number> {
  const out = new Set<number>();
  const add = (av?: AddressView) => {
    if (av?.addressView.case === 'decoded' && av.addressView.value.index) {
      out.add(av.addressView.value.index.account);
    }
  };
  for (const n of visibleNotes(info.view?.bodyView?.actionViews ?? [])) {
    add(n.note.address);
  }
  return out;
}

/** every note we can see, with whether it left (spend) or arrived */
function* visibleNotes(actions: ActionView[]): Generator<{ note: NoteView; sign: 1n | -1n }> {
  for (const { actionView: av } of actions) {
    if (av.case === 'spend' && av.value.spendView.case === 'visible') {
      const note = av.value.spendView.value.note;
      if (note) {
        yield { note, sign: -1n };
      }
    } else if (av.case === 'output' && av.value.outputView.case === 'visible') {
      const note = av.value.outputView.value.note;
      if (note) {
        yield { note, sign: 1n };
      }
    } else if (av.case === 'swapClaim' && av.value.swapClaimView.case === 'visible') {
      const { output1, output2 } = av.value.swapClaimView.value;
      for (const note of [output1, output2]) {
        if (note) {
          yield { note, sign: 1n };
        }
      }
    }
  }
}

// ── the transaction ──

/** the action that names the row, most telling first */
const DOMINANT: [ActionView['actionView']['case'], PenumbraKind][] = [
  ['swap', 'swap'],
  ['swapClaim', 'swap'],
  ['delegate', 'stake'],
  ['undelegate', 'unstake'],
  ['undelegateClaim', 'unstake-claim'],
  ['ics20Withdrawal', 'withdraw'],
  ['ibcRelayAction', 'deposit'],
  ['positionWithdraw', 'liquidity'],
  ['positionRewardClaim', 'liquidity'],
  ['positionClose', 'liquidity'],
  ['positionOpen', 'liquidity'],
  ['positionOpenView', 'liquidity'],
  ['delegatorVote', 'vote'],
];

const LP_TITLE: Record<string, string> = {
  positionOpen: 'liquidity position opened',
  positionOpenView: 'liquidity position opened',
  positionClose: 'liquidity position closed',
  positionWithdraw: 'liquidity position withdrawn',
  positionRewardClaim: 'liquidity reward claimed',
};

const TITLE: Record<PenumbraKind, string> = {
  send: 'sent',
  receive: 'received',
  internal: 'moved between accounts',
  deposit: 'received',
  withdraw: 'sent',
  refund: 'returned',
  swap: 'swap',
  liquidity: 'liquidity position',
  stake: 'stake',
  unstake: 'unstake',
  'unstake-claim': 'unstake claim',
  vote: 'voted',
  unknown: 'transaction',
};

const validatorRef = (l: Lookup, id: string): PenumbraRef => ({
  label: 'validator',
  display: clip(l.validatorNames.get(id) ?? shortId(id)),
  raw: id,
});

const ibcPackets = (actions: ActionView[]) =>
  actions.flatMap(({ actionView: av }) => {
    if (av.case !== 'ibcRelayAction') {
      return [];
    }
    try {
      const r = unpackIbcRelay(av.value);
      return r?.packet && r.tokenData ? [{ ...r, packet: r.packet, tokenData: r.tokenData }] : [];
    } catch {
      return [];
    }
  });

/** an acknowledgement that carries an error refunds the sender */
const ackFailed = (bytes?: Uint8Array) => {
  try {
    return !!bytes && 'error' in (JSON.parse(new TextDecoder().decode(bytes)) as object);
  } catch {
    return false;
  }
};

export function describePenumbraTx(
  info: TransactionInfo,
  reg: Pick<Lookup, 'registry' | 'validatorNames'> = bundledRegistry(),
): PenumbraEntry {
  const actions = info.view?.bodyView?.actionViews ?? [];
  const l: Lookup = { ...reg, local: new Map(), mine: new Set() };
  const seen = new Map<string, Asset>();
  const amt = (asset: Asset, n: bigint, direction: PenumbraAmount['direction']) => {
    seen.set(asset.raw, asset);
    return toAmount(asset, n, direction);
  };
  for (const m of info.perspective?.denoms ?? []) {
    if (m.penumbraAssetId?.inner.length) {
      l.local.set(b64(m.penumbraAssetId.inner), m);
    }
  }
  const accountIndices = penumbraAccountIndices(info);
  for (const av of info.perspective?.addressViews ?? []) {
    if (isMine(av)) {
      addressStrings(av).forEach(s => l.mine.add(s));
      if (av.addressView.case === 'decoded' && av.addressView.value.index) {
        accountIndices.add(av.addressView.value.index.account);
      }
    }
  }

  // what moved for us, per asset, and what went to someone else
  const net = new Map<string, { asset: Asset; amount: bigint }>();
  const bump = (asset: Asset, amount: bigint) => {
    const prev = net.get(asset.raw);
    net.set(asset.raw, { asset, amount: (prev?.amount ?? 0n) + amount });
  };
  const sentTo: { asset: Asset; amount: bigint; to: string }[] = [];
  let spentSomething = false;
  for (const { note, sign } of visibleNotes(actions)) {
    const v = valueParts(l, note.value);
    if (!v) {
      continue;
    }
    if (isMine(note.address)) {
      addressStrings(note.address).forEach(s => l.mine.add(s));
      bump(v.asset, sign * v.amount);
      spentSomething ||= sign < 0n;
    } else if (sign > 0n) {
      sentTo.push({ ...v, to: addressStrings(note.address)[0] ?? '' });
    }
  }

  // the fee is ours only when we spent; it is shown on its own, not in amounts
  const feeProto = info.view?.bodyView?.transactionParameters?.fee;
  let fee: PenumbraAmount | undefined;
  if (spentSomething && feeProto?.amount) {
    const feeAsset = resolveAsset(l, feeProto.assetId ?? stakingAssetId());
    const amount = big(feeProto.amount);
    if (amount > 0n) {
      fee = amt(feeAsset, amount, 'out');
      if (net.has(feeAsset.raw)) {
        bump(feeAsset, amount);
      }
    }
  }

  const cases = new Set(actions.map(a => a.actionView.case));
  const dominant = DOMINANT.find(([c]) => cases.has(c));
  let kind: PenumbraKind = dominant?.[1] ?? 'unknown';
  let amounts: PenumbraAmount[] = [];
  let counterparty: PenumbraRef | undefined;
  let detail: PenumbraRef | undefined;
  let title: string | undefined;
  let swapTxId: string | undefined;
  let claimTxId: string | undefined;
  let hidden = false;

  // money only: receipts and staking tokens are told by the title and detail
  const moved = () =>
    [...net.values()]
      .filter(({ asset, amount }) => amount !== 0n && !asset.nft && !asset.validator)
      .map(({ asset, amount }) => amt(asset, amount, amount > 0n ? 'in' : 'out'));
  const nfts = [...net.values()].flatMap(({ asset }) => (asset.nft ? [asset.nft] : []));
  const viaOf = (a?: PenumbraAmount) => {
    const via = a && seen.get(a.asset.raw)?.via;
    return via && a ? { label: 'via', display: clip(`via ${via}`), raw: a.asset.raw } : undefined;
  };

  for (const { actionView: av } of actions) {
    if (av.case === 'swap' && av.value.swapView.case === 'visible') {
      const s = av.value.swapView.value;
      const p = s.swapPlaintext;
      const in1 = big(p?.delta1I);
      const [assetId, meta, amount] =
        in1 > 0n
          ? [p?.tradingPair?.asset1, s.asset1Metadata, in1]
          : [p?.tradingPair?.asset2, s.asset2Metadata, big(p?.delta2I)];
      const input = resolveAsset(l, assetId, meta);
      amounts.push(amt(input, amount, 'out'));
      for (const note of [s.output1, s.output2]) {
        const v = valueParts(l, note?.value);
        if (v && v.amount > 0n && v.asset.raw !== input.raw) {
          amounts.push(amt(v.asset, v.amount, 'in'));
        }
      }
      claimTxId = hex(s.claimTx?.inner) || undefined;
    } else if (av.case === 'swapClaim' && av.value.swapClaimView.case === 'visible') {
      swapTxId = hex(av.value.swapClaimView.value.swapTx?.inner) || undefined;
    } else if (av.case === 'delegate' && av.value.validatorIdentity) {
      const um = assetOfDenom(l, 'upenumbra');
      amounts.push(amt(um, big(av.value.unbondedAmount), 'out'));
      detail = validatorRef(l, bech32mIdentityKey(av.value.validatorIdentity));
    } else if (av.case === 'undelegate' && av.value.validatorIdentity) {
      const um = assetOfDenom(l, 'upenumbra');
      amounts.push(amt(um, big(av.value.unbondedAmount), 'neutral'));
      detail = validatorRef(l, bech32mIdentityKey(av.value.validatorIdentity));
    } else if (av.case === 'undelegateClaim' && av.value.body?.validatorIdentity) {
      detail = validatorRef(l, bech32mIdentityKey(av.value.body.validatorIdentity));
    } else if (av.case === 'ics20Withdrawal') {
      const asset = assetOfDenom(l, av.value.denom?.denom ?? '');
      amounts.push(amt(asset, big(av.value.amount), 'out'));
      const chain = reg.registry?.ibcConnections.find(c => c.channelId === av.value.sourceChannel);
      const to = av.value.destinationChainAddress;
      counterparty = { label: 'to', display: clip(shortAddress(to)), raw: to };
      title = chain ? clip(`sent to ${chain.displayName.toLowerCase()}`) : 'sent out';
    } else if (
      (av.case === 'positionClose' ||
        av.case === 'positionWithdraw' ||
        av.case === 'positionRewardClaim') &&
      av.value.positionId
    ) {
      const id = bech32mPositionId(av.value.positionId);
      nfts.push({ label: 'position', display: shortId(id), raw: id });
    }
  }

  if (kind === 'deposit') {
    // a relayer batches packets; ours is the one paid to (or refunded to) us
    const packets = ibcPackets(actions);
    const ours = (who: string) => l.mine.has(who) || packets.length === 1;
    const recv = packets.find(
      p => p.message instanceof MsgRecvPacket && ours(p.tokenData.receiver),
    );
    const refund = packets.find(
      p =>
        !(p.message instanceof MsgRecvPacket) &&
        ours(p.tokenData.sender) &&
        (p.message.getType().typeName.includes('Timeout') ||
          ackFailed((p.message as { acknowledgement?: Uint8Array }).acknowledgement)),
    );
    const hit = recv ?? refund;
    if (hit) {
      const { packet, tokenData } = hit;
      // a denom coming home loses the hop prefix; a foreign one gains ours
      const back = `${packet.sourcePort}/${packet.sourceChannel}/`;
      const denom = recv
        ? tokenData.denom.startsWith(back)
          ? tokenData.denom.slice(back.length)
          : `${packet.destinationPort}/${packet.destinationChannel}/${tokenData.denom}`
        : tokenData.denom;
      const asset = assetOfDenom(l, denom);
      amounts.push(amt(asset, BigInt(tokenData.amount || '0'), 'in'));
      const channel = recv ? packet.destinationChannel : packet.sourceChannel;
      const chain = reg.registry?.ibcConnections.find(c => c.channelId === channel);
      const from = recv ? tokenData.sender : tokenData.receiver;
      kind = recv ? 'deposit' : 'refund';
      title = clip(
        chain
          ? `${recv ? 'received from' : 'returned from'} ${chain.displayName.toLowerCase()}`
          : TITLE[kind],
      );
      counterparty = from
        ? { label: recv ? 'from' : 'to', display: clip(shortAddress(from)), raw: from }
        : undefined;
    } else {
      hidden = !moved().length;
      amounts = moved();
      kind = 'receive';
    }
  }

  if (kind === 'unknown') {
    const theirs = sentTo.filter(s => s.amount > 0n);
    if (theirs.length) {
      kind = 'send';
      amounts = theirs.map(s => amt(s.asset, s.amount, 'out'));
      const to = theirs[0]!.to;
      counterparty = to ? { label: 'to', display: shortAddress(to), raw: to } : undefined;
    } else if (!spentSomething && moved().length) {
      kind = 'receive';
    } else if (spentSomething) {
      kind = moved().length ? 'unknown' : 'internal';
    }
  }

  if (!amounts.length) {
    amounts = moved();
  }

  if (kind === 'liquidity') {
    const action = DOMINANT.find(([c]) => cases.has(c) && LP_TITLE[c!])?.[0];
    title = LP_TITLE[action!] ?? TITLE.liquidity;
    const ids = [...new Map(nfts.map(n => [n.raw, n])).values()].filter(
      n => n.label === 'position',
    );
    detail =
      ids.length > 1
        ? {
            label: 'positions',
            display: `${ids.length} positions`,
            raw: ids.map(n => n.raw).join(' '),
          }
        : ids[0] && { label: 'position', display: `position ${ids[0].display}`, raw: ids[0].raw };
  }

  if (kind === 'swap') {
    const pair = [
      amounts.find(a => a.direction === 'out'),
      amounts.find(a => a.direction === 'in'),
    ];
    detail = pairRef(pair[0], pair[1]);
  }

  // an asset nobody could name: say so, keep its denom one tap away
  const unknown = amounts.find(a => a.asset.display === 'unknown asset');
  detail ??= unknown
    ? { label: 'asset', display: clip(shortId(unknown.asset.raw), 20), raw: unknown.asset.raw }
    : viaOf(amounts[0]);

  const memoView = info.view?.bodyView?.memoView?.memoView;
  const plain = memoView?.case === 'visible' ? memoView.value.plaintext : undefined;
  const memo = plain?.text.trim() || undefined;
  const returnTo = kind === 'receive' ? addressStrings(plain?.returnAddress)[0] : undefined;
  counterparty ??= returnTo
    ? { label: 'from', display: shortAddress(returnTo), raw: returnTo }
    : undefined;

  return {
    id: hex(info.id?.inner),
    height: Number(info.height ?? 0),
    kind,
    title: title ?? TITLE[kind],
    amounts,
    counterparty,
    detail,
    fee,
    memo,
    accountIndices,
    hidden,
    swapTxId,
    claimTxId,
  };
}

const pairRef = (from?: PenumbraAmount, to?: PenumbraAmount): PenumbraRef | undefined =>
  from || to
    ? {
        label: 'pair',
        display: clip(`${from?.asset.display ?? ''} → ${to?.asset.display ?? '…'}`.trim()),
        raw: [from?.asset.raw, to?.asset.raw].filter(Boolean).join(' → '),
      }
    : undefined;

/** every id an entry shortened, for the detail screen's copy buttons */
export const penumbraRefs = (e?: PenumbraEntry, except?: string): PenumbraRef[] => [
  ...new Map(
    [e?.counterparty, e?.detail, ...(e?.amounts.map(a => a.asset) ?? [])]
      .filter((r): r is PenumbraRef => !!r && r.raw !== r.display && r.raw !== except)
      .map(r => [r.raw, r]),
  ).values(),
];

/**
 * The whole history: one entry per transaction, newest first, relayer noise
 * dropped and each swap claim folded into the swap it settles.
 */
export function describePenumbraHistory(
  infos: Iterable<TransactionInfo>,
  reg?: Pick<Lookup, 'registry' | 'validatorNames'>,
): PenumbraEntry[] {
  const all = [...infos].map(i => describePenumbraTx(i, reg));
  const byId = new Map(all.map(e => [e.id, e]));
  const folded = new Set<string>();
  for (const claim of all) {
    if (claim.kind !== 'swap' || !claim.swapTxId) {
      continue;
    }
    const swap = byId.get(claim.swapTxId);
    if (!swap || swap === claim) {
      continue;
    }
    if (!swap.amounts.some(a => a.direction === 'in')) {
      swap.amounts.push(...claim.amounts.filter(a => a.direction === 'in'));
      swap.detail = pairRef(
        swap.amounts.find(a => a.direction === 'out'),
        swap.amounts.find(a => a.direction === 'in'),
      );
    }
    swap.claimTxId = claim.id;
    folded.add(claim.id);
  }
  return all.filter(e => !e.hidden && !folded.has(e.id)).sort((a, b) => b.height - a.height);
}
