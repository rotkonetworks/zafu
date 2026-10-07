/**
 * What the zcash home says about the node's chain proof (fly-verify.ts), as
 * data: which notice, from the sync failure and the last chain check alone.
 * A paused chain blocks the balance; a quiet one only says the chain is not
 * verified while the balance shows.
 */

import type { ZcashChainCheck } from '../../../state/keyring/network-worker';

export type ChainNoticeId = 'paused' | 'downgrade' | 'clock' | 'unverified' | 'accepted';

/** choose: another node; accept: keep this one, unverified */
export type ChainAction = 'choose' | 'accept';

export interface ChainNotice {
  tone: 'warn' | 'info';
  icon: string;
  lines: [string, string];
  actions?: ChainAction[];
  /** says, never blocks: shown only when nothing else needs the slot */
  quiet?: true;
}

export const CHAIN_NOTICE: Record<ChainNoticeId, ChainNotice> = {
  paused: {
    tone: 'warn',
    icon: 'i-ph-warning',
    lines: ["this server's chain didn't check out", 'balances are paused · nothing was lost'],
    actions: ['choose'],
  },
  downgrade: {
    tone: 'warn',
    icon: 'i-ph-warning',
    lines: ['this node stopped proving its chain', 'balances are paused · nothing was lost'],
    actions: ['choose', 'accept'],
  },
  clock: {
    tone: 'info',
    icon: 'i-ph-clock',
    lines: ["this computer's clock looks off", "zafu can't check the chain until it's right"],
  },
  unverified: {
    tone: 'info',
    icon: 'i-ph-shield',
    lines: ['chain not verified', "the node's proof didn't arrive · balances rest on it alone"],
    quiet: true,
  },
  accepted: {
    tone: 'info',
    icon: 'i-ph-shield',
    lines: [
      'chain not verified',
      'you kept this node without its proof · balances rest on it alone',
    ],
    quiet: true,
  },
};

export const ACTION_LABEL: Record<ChainAction, string> = {
  choose: 'choose another node',
  accept: 'keep using this node unverified',
};

const UNVERIFIED: Partial<Record<string, ChainNoticeId>> = {
  clock: 'clock',
  unreachable: 'unverified',
  accepted: 'accepted',
};

/**
 * The notice for a chain check. A node that stopped proving itself may be
 * kept, unverified; a proof that did not check out may not. A testnet or a
 * plain lightwalletd never offered a proof, so it says nothing here.
 */
export const chainNoticeOf = (
  unproven: boolean,
  chain?: Pick<ZcashChainCheck, 'status' | 'reason'>,
): ChainNoticeId | undefined =>
  unproven
    ? chain?.status === 'failed' && chain.reason === 'downgrade'
      ? 'downgrade'
      : 'paused'
    : chain?.status === 'unverified'
      ? UNVERIFIED[chain.reason ?? '']
      : undefined;
