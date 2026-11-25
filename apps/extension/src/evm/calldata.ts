/**
 * What a transaction's data asks for, as a person reads it: an ERC-20
 * approve or transfer, and an ics20 move over ibc (cosmos eureka's
 * sendTransfer, its permit2 twin, and the brinance bridge's), are spelled
 * out; anything else is shown as its 4-byte selector and length, never
 * guessed at.
 */

import { decodeFunctionData, formatUnits, parseAbi, toFunctionSelector, type Hex } from 'viem';

export type CallView =
  | { kind: 'none' }
  | { kind: 'approve'; spender: Hex; amount: bigint }
  | { kind: 'transfer'; to: Hex; amount: bigint }
  /** `timeout` in unix seconds, 0 for none */
  | {
      kind: 'ibc';
      token: Hex;
      amount: bigint;
      receiver: string;
      timeout: bigint;
      memo: string;
      sourceClient?: string;
    }
  | { kind: 'call'; selector: string; bytes: number };

interface SendTransferMsg {
  denom: Hex;
  amount: bigint;
  receiver: string;
  timeoutTimestamp: bigint;
  memo: string;
  sourceClient?: string;
}

const ibc = (m: SendTransferMsg, timeoutUnit = 1n): CallView => ({
  kind: 'ibc',
  token: m.denom,
  amount: m.amount,
  receiver: m.receiver,
  timeout: m.timeoutTimestamp / timeoutUnit,
  memo: m.memo,
  ...(m.sourceClient !== undefined && { sourceClient: m.sourceClient }),
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
 * `bridge`: the call goes to one of the chain's known ics20 / bridge contracts
 * (evm/chains isKnownBridge). Only then is an ibc move read as one; the same
 * shape sent anywhere else is an unreadable call.
 */
export const readCall = (data: Hex | undefined, bridge = false): CallView => {
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
    return view && (view.kind !== 'ibc' || bridge) ? view : unread;
  } catch {
    // its selector matched but its arguments don't decode
    return unread;
  }
};

/** the token a call moves: the contract called for erc-20, the denom for an ibc move */
export const tokenAddress = (view: CallView, to: Hex | undefined): Hex | undefined =>
  view.kind === 'ibc'
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
export type Line = [label: string, text: string];

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
      const lines: (Line | false)[] = [
        [
          'what it does',
          `moves ${amountOf(view.amount, token)} ${penumbra ? 'into penumbra' : 'over ibc to another chain'}`,
        ],
        ['token', view.token],
        view.sourceClient !== undefined && ['source client', view.sourceClient],
        ['to', view.receiver],
        penumbra && ['whose', WHOSE[owner ?? 'unknown']],
        view.timeout > 0n && ['back to you if not there by', utc(view.timeout)],
        !!view.memo && ['memo', view.memo],
      ];
      return lines.filter((l): l is Line => !!l);
    }
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
