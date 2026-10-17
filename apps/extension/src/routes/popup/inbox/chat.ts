/**
 * What a direct thread says about itself: who sees what, and where a line of
 * yours stands. Only what zafu actually knows; the relay keeps no receipts and
 * no presence, so there is no "delivered" and no "online" here.
 */

import type { Explain } from '../settings/settings-explain';
import type { ThreadItem } from '../../../people/vault';
import { hhmm } from '../../../utils/when';

/** a memo with the `reply:` line that files it under you in their thread */
export const withReply = (text: string, reply?: string): string =>
  reply ? (text ? `${text}\nreply:${reply}` : `reply:${reply}`) : text;

/** the memo's own words, without a trailing `reply:` line */
export const withoutReply = (content: string): string =>
  content.replace(/\n?reply:\S+\s*$/i, '').trim();

export interface ChatPrivacy {
  lines: [string, string];
  explain: Explain;
}

/** where the pair room stands on post-quantum (people/pair-pq) */
export type ChatPq = 'on' | 'securing' | 'off';

const PQ_LINE: Record<ChatPq, string> = {
  on: 'end-to-end encrypted · post-quantum',
  securing: 'post-quantum keys on the way · your lines wait for them',
  off: 'end-to-end encrypted',
};

const pqBlurb = (pq: ChatPq, name: string): string =>
  pq === 'on'
    ? ' the key is x25519 and ml-kem together, so a recording stays closed to a quantum computer later.'
    : ` not post-quantum yet: that comes once you both run the newest zafu, then ${name} and you move the room.`;

/** the quiet line under the title, and the sheet its "?" opens */
export const chatPrivacy = (
  via: 'relay' | 'memo',
  name: string,
  relay: string,
  transparent: boolean,
  pq: ChatPq = 'off',
): ChatPrivacy =>
  via === 'relay'
    ? {
        lines: [PQ_LINE[pq], `${relay} sees your ip and when, never your words`],
        explain: {
          blurb: `lines to ${name} go sealed through ${relay}. only the two of you can open them.${pqBlurb(pq, name)}`,
          states: [
            { label: name, text: 'every line you send, on their device' },
            { label: relay, text: 'your ip and when you check or send · never the words' },
            { label: 'the chain', text: 'nothing · a chat line never touches it' },
          ],
          footer: 'a payment goes on the chain as its own transaction, with a network fee',
        },
      }
    : transparent
      ? {
          lines: ['public payments', 'anyone can see the address and the amount'],
          explain: {
            blurb: `${name} has a transparent address. a payment to it is public.`,
            states: [
              { label: name, text: 'the amount' },
              { label: 'the chain', text: 'the address and the amount, to anyone' },
            ],
          },
        }
      : {
          lines: ['shielded payments with a note', 'each one is a transaction with a network fee'],
          explain: {
            blurb: `each message to ${name} here is a shielded payment with a note, on the chain.`,
            states: [
              { label: name, text: 'the amount and the note' },
              {
                label: 'the chain',
                text: 'that a transaction happened · not who, how much or what',
              },
            ],
            footer: "once you hold each other's cards, chat goes over the relay, free",
          },
        };

export interface SendLine {
  text: string;
  tone: 'muted' | 'failed';
  /** a square mark: on the relay */
  mark: boolean;
}

/**
 * Where a line of yours stands: in flight, waiting for the next try (you are
 * offline or the relay did not answer), given up, or on the relay. With no
 * `sent`, a line on the relay says nothing (a group keeps quiet).
 */
export const sendLine = (
  item: Pick<ThreadItem, 'status' | 'ts'>,
  sent?: boolean,
  /** seconds: they said they read up to this line, while both of you have read receipts on */
  readAt?: number,
): SendLine | undefined =>
  readAt && !item.status
    ? { text: `read ${hhmm(readAt * 1000)}`, tone: 'muted', mark: true }
    : item.status === 'sending'
      ? { text: 'sending', tone: 'muted', mark: false }
      : item.status === 'waiting'
        ? { text: 'waiting to send', tone: 'muted', mark: false }
        : item.status === 'failed'
          ? { text: 'this did not reach the relay', tone: 'failed', mark: false }
          : sent
            ? { text: item.ts ? `sent ${hhmm(item.ts * 1000)}` : 'sent', tone: 'muted', mark: true }
            : undefined;
