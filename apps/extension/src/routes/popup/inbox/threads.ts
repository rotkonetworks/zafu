/**
 * Direct threads, derived from the memo store: one thread per counterparty
 * address (who you sent to, or who said they wrote from), newest first. A
 * memo with no address of the other side is its own thread (`s:<txid>`), so
 * two strangers are never merged into one person.
 */

import type { Message } from '../../../state/messages';

export interface DirectThread {
  /** the counterparty address, or `s:<txid>` for an unknown sender */
  id: string;
  /** the other side's address, when known */
  address?: string;
  network: Message['network'];
  /** oldest first */
  messages: Message[];
  last: Message;
  unread: number;
}

/**
 * the other side of one memo: the recipient of a send; for a receive, the
 * person you gave the address it arrived on (your own record), else the
 * sender's declared `reply:` address
 */
export const counterparty = (m: Message): string | undefined =>
  (m.direction === 'sent' ? m.recipientAddress : (m.personAddress ?? m.senderAddress))?.trim() ||
  undefined;

export const threadIdOf = (m: Message): string => counterparty(m)?.toLowerCase() ?? `s:${m.txId}`;

export const deriveThreads = (messages: readonly Message[]): DirectThread[] => {
  const byId = new Map<string, Message[]>();
  for (const m of messages) {
    const id = threadIdOf(m);
    byId.set(id, [...(byId.get(id) ?? []), m]);
  }
  return [...byId.entries()]
    .map(([id, list]) => {
      const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
      const last = sorted[sorted.length - 1]!;
      return {
        id,
        address: sorted.map(counterparty).find(Boolean),
        network: last.network,
        messages: sorted,
        last,
        unread: sorted.filter(m => m.direction === 'received' && !m.read).length,
      };
    })
    .sort((a, b) => b.last.timestamp - a.last.timestamp);
};

/** the first line a row shows for a memo */
export const previewOf = (m: Message): string => {
  const text = m.content.trim().split('\n')[0] ?? '';
  if (text) {
    return m.asset === 'contact-card' ? 'a card' : text;
  }
  return m.amount
    ? `${m.direction === 'sent' ? 'you paid' : 'received'} ${m.amount} ${m.network === 'zcash' ? 'zec' : (m.asset ?? '')}`.trim()
    : '';
};

/** 14:02 today, "yesterday", a weekday this week, else "sep 12"; empty when unknown */
export const whenOf = (ts: number, now = Date.now()): string => {
  if (!ts) {
    return '';
  }
  const d = new Date(ts);
  const n = new Date(now);
  const days = Math.round(
    (new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return d.toLocaleDateString('en', { weekday: 'short' }).toLowerCase();
  }
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase();
};

export const shortAddress = (a: string): string =>
  a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;

/**
 * A card that arrived in a memo, as the memo store keeps it: `name\naddress`
 * (older records lead with a pictograph, which is dropped). Its name and
 * address are the sender's claim, never checked.
 */
export const cardOf = (m: Message): { name: string; address: string } | undefined => {
  if (m.asset !== 'contact-card') {
    return undefined;
  }
  const [name = '', address = ''] = m.content
    .replace(/^\p{Extended_Pictographic}\s*/u, '')
    .split('\n');
  return address.trim() ? { name: name.trim(), address: address.trim() } : undefined;
};
