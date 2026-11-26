/**
 * What a transaction's data asks for, as a person reads it: an ERC-20
 * approve or transfer, and an ics20 move over ibc (cosmos eureka's
 * sendTransfer, its permit2 twin, and the brinance bridge's), are spelled
 * out; anything else is shown as its 4-byte selector and length, never
 * guessed at.
 */

import { decodeFunctionData, formatUnits, parseAbi, toFunctionSelector, type Hex } from 'viem';
import type { KnownBridge } from './chains';

/** an ics20 move as the call states it; `timeout` in unix seconds, 0 for none */
export interface IbcMove {
  token: Hex;
  amount: bigint;
  receiver: string;
  timeout: bigint;
  memo: string;
  sourceClient?: string;
  destPort?: string;
}

export type CallView =
  | { kind: 'none' }
  | { kind: 'approve'; spender: Hex; amount: bigint }
  | { kind: 'transfer'; to: Hex; amount: bigint }
  /** to a known bridge, on the route pinned for it (evm/chains) */
  | ({ kind: 'ibc' } & IbcMove)
  /** to a known bridge, on any other client or port: it may go anywhere */
  | ({ kind: 'off-route' } & IbcMove)
  | { kind: 'call'; selector: string; bytes: number };

interface SendTransferMsg {
  denom: Hex;
  amount: bigint;
  receiver: string;
  timeoutTimestamp: bigint;
  memo: string;
  sourceClient?: string;
  destPort?: string;
}

const ibc = (m: SendTransferMsg, timeoutUnit = 1n): CallView => ({
  kind: 'ibc',
  token: m.denom,
  amount: m.amount,
  receiver: m.receiver,
  timeout: m.timeoutTimestamp / timeoutUnit,
  memo: m.memo,
  ...(m.sourceClient !== undefined && { sourceClient: m.sourceClient }),
  ...(m.destPort !== undefined && { destPort: m.destPort }),
});

const MSG =
  '(address denom,uint256 amount,string receiver,string sourceClient,string destPort,uint64 timeoutTimestamp,string memo)';

/** each call zafu reads, by its signature, and how it reads */
const READERS: [signature: string, read: (args: readonly unknown[]) => CallView][] = [
  [
    'function approve(address spender, uint256 amount)',
    ([spender, amount]) => ({ kind: 'approve', spender: spender as Hex, amount: amount as bigint }),
  ],
  [
    'function transfer(address to, uint256 amount)',
    ([to, amount]) => ({ kind: 'transfer', to: to as Hex, amount: amount as bigint }),
  ],
  // cosmos eureka ICS20Transfer v3.0.2
  [`function sendTransfer(${MSG} msg_)`, ([m]) => ibc(m as SendTransferMsg)],
  [
    `function sendTransferWithPermit2(${MSG} msg_, ((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, bytes signature)`,
    ([m]) => ibc(m as SendTransferMsg),
  ],
  // the brinance bridge: the same move, flat, its timeout in nanoseconds
  [
    'function sendTransfer(address token,uint256 amount,string receiver,string memo,uint64 timeoutTimestamp)',
    ([denom, amount, receiver, memo, timeoutTimestamp]) =>
      ibc({ denom, amount, receiver, memo, timeoutTimestamp } as SendTransferMsg, 10n ** 9n),
  ],
];

const ABI = parseAbi(READERS.map(([sig]) => sig));
const BY_SELECTOR = new Map(READERS.map(([sig, read]) => [toFunctionSelector(sig), read]));

/** no real allowance reaches this: it is the "unlimited" one dapps ask for */
export const UNLIMITED = 2n ** 96n;

/**
 * `bridge`: the known ics20 / bridge contract the call goes to (evm/chains
 * knownBridge), if it does. Only then is an ibc move read as one, and only on
 * the client and port pinned for that bridge: the client picks the chain a
 * packet goes to, not the receiver string. The same shape sent anywhere else
 * is an unreadable call; on another route it is `off-route`.
 */
export const readCall = (data: Hex | undefined, bridge?: KnownBridge): CallView => {
  if (!data || data === '0x') {
    return { kind: 'none' };
  }
  const unread: CallView = {
    kind: 'call',
    selector: data.slice(0, 10),
    bytes: (data.length - 2) / 2,
  };
  const read = BY_SELECTOR.get(data.slice(0, 10).toLowerCase() as Hex);
  try {
    const view = read?.(decodeFunctionData({ abi: ABI, data }).args ?? []);
    if (view?.kind !== 'ibc') {
      return view ?? unread;
    }
    if (!bridge) {
      return unread;
    }
    const onRoute = view.sourceClient === bridge.client && view.destPort === bridge.port;
    return onRoute ? view : { ...view, kind: 'off-route' };
  } catch {
    // its selector matched but its arguments don't decode
    return unread;
  }
};

/** the token a call moves: the contract called for erc-20, the denom for an ibc move */
export const tokenAddress = (view: CallView, to: Hex | undefined): Hex | undefined =>
  view.kind === 'ibc' || view.kind === 'off-route'
    ? view.token
    : view.kind === 'approve' || view.kind === 'transfer'
      ? to
      : undefined;

/** whose a penumbra receiver is, as the worker found it; undefined when it could not tell */
export type Owner = 'account' | 'one-time' | 'not-yours' | undefined;

const WHOSE: Record<Exclude<Owner, undefined> | 'unknown', string> = {
  account: 'your own penumbra address',
  'one-time': 'a one-time address of yours',
  'not-yours': "not an address of this wallet · if this is meant for you, please don't approve",
  unknown: "zafu couldn't check whether this address is yours",
};

export const isPenumbraReceiver = (receiver: string): boolean => receiver.startsWith('penumbra1');

/** the latest second a Date holds */
const LAST_DATE = 8_640_000_000_000n;

const utc = (seconds: bigint) =>
  seconds > LAST_DATE
    ? 'far future'
    : `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} utc`;

const amountOf = (amount: bigint, token?: { symbol: string; decimals: number }): string =>
  amount >= UNLIMITED
    ? `any amount of ${token?.symbol ?? 'this token'}`
    : token
      ? `${formatUnits(amount, token.decimals)} ${token.symbol}`
      : `${amount} (smallest units of this token)`;

interface Token {
  symbol: string;
  decimals: number;
}
/** a line of the approval; `warn` is said loudly */
export type Line = [label: string, text: string, warn?: true];

const routeLines = (v: IbcMove): (Line | false)[] => [
  ['token', v.token],
  v.sourceClient !== undefined && ['source client', v.sourceClient],
  v.destPort !== undefined && ['destination port', v.destPort],
];

const tailLines = (v: IbcMove): (Line | false)[] => [
  v.timeout > 0n && ['back to you if not there by', utc(v.timeout)],
  !!v.memo && ['memo', v.memo],
];

const lines = (all: (Line | false)[]): Line[] => all.filter((l): l is Line => !!l);

/** what the data does, line by line; nothing for a plain value transfer */
export const callLines = (view: CallView, token?: Token, owner?: Owner): Line[] => {
  switch (view.kind) {
    case 'approve':
      return [
        [
          'what it does',
          `lets ${view.spender} spend ${amountOf(view.amount, token)} from this address`,
        ],
      ];
    case 'transfer':
      return [['what it does', `sends ${amountOf(view.amount, token)} to ${view.to}`]];
    case 'ibc': {
      const penumbra = isPenumbraReceiver(view.receiver);
      // anything short of "yours" is said loudly: not yours, or not checked
      const whose: Line =
        owner === 'account' || owner === 'one-time'
          ? ['whose', WHOSE[owner]]
          : ['whose', WHOSE[owner ?? 'unknown'], true];
      return lines([
        [
          'what it does',
          `moves ${amountOf(view.amount, token)} ${penumbra ? 'into penumbra' : 'over ibc to another chain'}`,
        ],
        ...routeLines(view),
        ['to', view.receiver],
        penumbra && whose,
        ...tailLines(view),
      ]);
    }
    case 'off-route':
      return lines([
        [
          'what it does',
          `sends ${amountOf(view.amount, token)} over a route this bridge doesn't use for penumbra · it may never arrive, please don't approve unless you expected it`,
          true,
        ],
        ['token', view.token],
        ['source client', view.sourceClient ?? 'none'],
        ['destination port', view.destPort ?? 'none'],
        ['to', view.receiver],
        ...tailLines(view),
      ]);
    case 'call':
      return [
        [
          'what it does',
          `calls ${view.selector} with ${view.bytes} bytes of data · zafu can't read what it does`,
        ],
      ];
    case 'none':
      return [];
  }
};
