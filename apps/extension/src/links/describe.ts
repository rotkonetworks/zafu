/**
 * One calm line for what an intent will open: shared by the chat link chip
 * and the omnibox suggestion, so the two never drift.
 */

import { formatZecAmount } from '@repo/wallet/networks/zcash/zip321';
import type { Intent } from './router';

const DESCRIBE: { [K in Intent['kind']]: (i: Extract<Intent, { kind: K }>) => string } = {
  pay: ({ payments: [p] }) =>
    [
      p?.amountZat !== undefined ? `pay ${formatZecAmount(p.amountZat)} ZEC` : 'pay',
      p?.label ?? p?.message,
    ]
      .filter(Boolean)
      .join(' - '),
  swap: ({ swap }) =>
    swap.direction === 'into_zec' ? `swap ${swap.token} into zec` : `swap zec into ${swap.token}`,
  move: ({ move }) =>
    move.action === 'shield' ? `shield from ${move.chain}` : `${move.action} ${move.asset}`,
  screen: ({ screen }) => `open ${screen}`,
  contact: () => 'contact',
  join: ({ code }) => `join ${code}`,
};

export const describeIntent = (intent: Intent): string =>
  (DESCRIBE[intent.kind] as (i: Intent) => string)(intent);
