/**
 * What the send form opens with: route state from inside zafu (a contact, a
 * card, a reply), or the query of an external payment link.
 */

import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

export interface SendLocationState {
  prefillMemo?: string;
  prefillRecipient?: string;
  prefillAmount?: string;
  /**
   * Row-level "Send X" quick-action on the home asset list: base denom of the
   * asset to preselect. Matched against `metadata.base` on the fetched balance
   * list. Falls back to the top-priority balance if the denom is not found.
   */
  prefillAsset?: string;
  /**
   * Cosmos off-ramp: open the cosmos send for this chain WITHOUT switching the
   * active network. Noble is a burner doorway, not a network - the user stays
   * on Penumbra; this just routes the send form to the transparent chain.
   */
  cosmosChain?: CosmosChainId;
  /** which burner index (BIP44 address_index) to spend from. Default 0. */
  cosmosAccountIndex?: number;
  /**
   * Why the cosmos send form was opened: 'shield' (back into Penumbra) or
   * 'send' (out to an external address, e.g. an exchange). The form is the same
   * today; this lets it prefill/route differently later without changing callers.
   */
  cosmosIntent?: 'send' | 'shield';
}

export interface SendPrefill {
  recipient?: string;
  amount?: string;
  memo?: string;
  /** where a link in `recipient` came from (see links/land viaLine) */
  via?: string;
}

/** amount_zat (uint64 string, zatoshi) -> the decimal ZEC string ZcashSend expects */
const zecFromZat = (zat: string | null): string | undefined => {
  const n = Number(zat ?? '');
  if (!zat || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return (n / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * Route state wins whenever it names a recipient or a memo, so a card or a
 * reply arrives whole. `externalMemo` is the link's memo with its tokens
 * already expanded.
 */
export const sendPrefill = (
  state: SendLocationState | undefined,
  query: URLSearchParams,
  externalMemo: string | undefined,
): SendPrefill | undefined => {
  if (state?.prefillRecipient || state?.prefillMemo) {
    return {
      recipient: state.prefillRecipient,
      amount: state.prefillAmount,
      memo: state.prefillMemo,
    };
  }
  const to = query.get('to');
  if (!to) {
    return undefined;
  }
  return {
    recipient: to,
    amount: zecFromZat(query.get('amount_zat')),
    memo: externalMemo,
    via: query.get('via') ?? undefined,
  };
};
