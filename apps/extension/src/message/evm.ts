/**
 * Wire contract for the evm provider, shared by the service-worker handler
 * (message/listen/evm.ts) and the approval screen (routes/popup/approval/evm.tsx).
 * Everything here is JSON-safe: bigints travel as decimal strings.
 */

import type { Hex } from 'viem';
import type { EvmChain } from '../evm/chains';
import type { StoredTx } from '../evm/tx';
import type { Owner } from '../evm/calldata';

/** what the content-script bridge sends the service worker */
export interface EvmMessage {
  type: 'ZafuEvm';
  method: string;
  params: unknown;
}

export const isEvmMessage = (m: unknown): m is EvmMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === 'ZafuEvm' &&
  typeof (m as { method?: unknown }).method === 'string';

/** the request stashed in session storage for the approval screen to read */
export interface EvmApprovalRequest {
  requestId: string;
  /** `chain`: a site asks to use a chain no egress opt-in covers (the local node) */
  kind: 'connect' | 'send' | 'sign' | 'chain';
  origin: string;
  title?: string;
  favIconUrl?: string;
  chain: EvmChain;
  from?: Hex;
  /** send: the transaction exactly as it will be signed */
  tx?: StoredTx;
  /** send: the token's own symbol and decimals, when `to` answered them */
  token?: { symbol: string; decimals: number };
  /** send: whose the penumbra receiver of an ibc move is, by the view service */
  owner?: Owner;
  /** sign: the message bytes */
  message?: Hex;
}

export const evmApprovalKey = (requestId: string): string => `evmApproval:${requestId}`;
