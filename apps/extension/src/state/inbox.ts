/**
 * inbox — conversation-oriented view of Zcash memos
 *
 * Design principles (à la hdevalence):
 *
 * 1. Address = conversation endpoint. Each peer gets a unique
 *    diversified address. The diversifier index IS the conversation ID.
 *    No session IDs, no metadata in memos, no linkability.
 *
 * 2. Notes ARE messages. A Zcash note is an authenticated encrypted
 *    datagram. The spend authority authenticates the sender.
 *    The diversified address identifies the recipient. We don't
 *    build messaging on top of Zcash — Zcash IS the messaging.
 *
 * 3. Fragment reassembly is transparent. The UI shows logical
 *    messages, not individual note memos. A 2000-char message
 *    that spans 5 notes appears as one bubble.
 *
 * 4. FROST coordination messages appear inline. DKG rounds,
 *    signing requests, commitments — all visible in the same
 *    conversation view with actionable UI.
 */

import { AllSlices, SliceCreator } from '.';
import {
  decodeMemo,
  reassemble,
  decodeText,
  memoTypeName,
  isStructuredMemo,
  decodeContactCard,
  type ParsedMemo,
  type ContactCard,
  MemoType,
  bytesToHex,
} from '@repo/wallet/networks/zcash/memo-codec';

// ── types ──

/** a single logical message (may span multiple notes) */
export interface InboxMessage {
  /** unique ID — messageId hex for fragmented, or txid for standalone */
  id: string;
  /** memo type */
  type: MemoType;
  /** decoded text (for text messages) or hex (for binary) */
  body: string;
  /** human-readable type label */
  typeLabel: string;
  /** block height of the first (or only) note */
  height: number;
  /** txid(s) that carry this message's fragments */
  txids: string[];
  /** timestamp (from block, if available) */
  timestamp?: number;
  /** true if all fragments have been received */
  complete: boolean;
  /** direction */
  direction: 'incoming' | 'outgoing';
  /** decoded contact card (only for MemoType.ContactCard) */
  contactCard?: ContactCard;
}

/** a conversation = all messages to/from one diversified address */
export interface Conversation {
  /** diversifier index — the conversation endpoint */
  diversifierIndex: number;
  /** optional label set by user */
  label?: string;
  /** messages in chronological order */
  messages: InboxMessage[];
  /** last activity height */
  lastHeight: number;
  /** unread count */
  unread: number;
}

export interface InboxSlice {
  /** conversations keyed by diversifier index */
  conversations: Map<number, Conversation>;
  /** set of message IDs that have been read */
  readIds: Set<string>;

  /** ingest raw memos from sync — call after each memo decrypt batch */
  ingestMemos: (memos: RawMemoNote[]) => void;
  /** mark a conversation as read */
  markRead: (diversifierIndex: number) => void;
  /** set a label for a conversation */
  setConversationLabel: (diversifierIndex: number, label: string) => void;
  /** get conversations sorted by last activity */
  sortedConversations: () => Conversation[];
}

/** raw memo note from the worker's decrypt_transaction_memos */
export interface RawMemoNote {
  txid: string;
  height: number;
  memo: Uint8Array;
  /** diversifier index of the receiving address (from note metadata) */
  diversifierIndex: number;
  /** is this a change note (outgoing)? */
  isChange: boolean;
  timestamp?: number;
}

// ── fragment buffer for incomplete multi-part messages ──
const fragmentBuffer = new Map<string, { parsed: ParsedMemo; meta: RawMemoNote }[]>();

export const createInboxSlice = (): SliceCreator<InboxSlice> => (set, get) => ({
  conversations: new Map(),
  readIds: new Set(),

  ingestMemos: (memos: RawMemoNote[]) => {
    const newMessages: { diversifierIndex: number; message: InboxMessage }[] = [];

    for (const raw of memos) {
      if (!isStructuredMemo(raw.memo)) continue;

      const parsed = decodeMemo(raw.memo);
      if (!parsed) continue;

      if (parsed.total === 1) {
        // standalone message
        const body = parsed.type === MemoType.Text
          ? decodeText(parsed.payload)
          : parsed.type === MemoType.ContactCard
            ? '' // body unused for contact cards, data lives in contactCard field
            : bytesToHex(parsed.payload);

        const contactCard = parsed.type === MemoType.ContactCard
          ? decodeContactCard(parsed.payload) ?? undefined
          : undefined;

        newMessages.push({
          diversifierIndex: raw.diversifierIndex,
          message: {
            id: raw.txid,
            type: parsed.type,
            body,
            typeLabel: memoTypeName(parsed.type),
            height: raw.height,
            txids: [raw.txid],
            timestamp: raw.timestamp,
            complete: true,
            direction: raw.isChange ? 'outgoing' : 'incoming',
            contactCard,
          },
        });
      } else {
        // fragmented — buffer until complete
        const msgIdHex = bytesToHex(parsed.messageId);
        let buffer = fragmentBuffer.get(msgIdHex);
        if (!buffer) {
          buffer = [];
          fragmentBuffer.set(msgIdHex, buffer);
        }

        // dedupe by part number
        if (!buffer.some(f => f.parsed.part === parsed.part)) {
          buffer.push({ parsed, meta: raw });
        }

        // try reassembly
        const payload = reassemble(buffer.map(f => f.parsed));
        if (payload) {
          fragmentBuffer.delete(msgIdHex);
          const body = parsed.type === MemoType.Text
            ? decodeText(payload)
            : bytesToHex(payload);

          newMessages.push({
            diversifierIndex: raw.diversifierIndex,
            message: {
              id: msgIdHex,
              type: parsed.type,
              body,
              typeLabel: memoTypeName(parsed.type),
              height: Math.min(...buffer.map(f => f.meta.height)),
              txids: buffer.map(f => f.meta.txid),
              timestamp: buffer[0]?.meta.timestamp,
              complete: true,
              direction: raw.isChange ? 'outgoing' : 'incoming',
            },
          });
        }
      }
    }

    if (newMessages.length === 0) return;

    set(state => {
      for (const { diversifierIndex, message } of newMessages) {
        let convo = state.inbox.conversations.get(diversifierIndex);
        if (!convo) {
          convo = {
            diversifierIndex,
            messages: [],
            lastHeight: 0,
            unread: 0,
          };
          state.inbox.conversations.set(diversifierIndex, convo);
        }

        // dedupe by message ID
        if (convo.messages.some(m => m.id === message.id)) continue;

        convo.messages.push(message);
        convo.messages.sort((a, b) => a.height - b.height);
        convo.lastHeight = Math.max(convo.lastHeight, message.height);

        if (message.direction === 'incoming' && !state.inbox.readIds.has(message.id)) {
          convo.unread++;
        }
      }
    });
  },

  markRead: (diversifierIndex: number) => {
    set(state => {
      const convo = state.inbox.conversations.get(diversifierIndex);
      if (!convo) return;

      for (const msg of convo.messages) {
        if (msg.direction === 'incoming') {
          state.inbox.readIds.add(msg.id);
        }
      }
      convo.unread = 0;
    });

    // persist read state
    const readIds = Array.from(get().inbox.readIds);
    void chrome.storage.local.set({ inboxReadIds: readIds });
  },

  setConversationLabel: (diversifierIndex: number, label: string) => {
    set(state => {
      const convo = state.inbox.conversations.get(diversifierIndex);
      if (convo) convo.label = label;
    });

    // persist labels
    const labels: Record<number, string> = {};
    for (const [idx, convo] of get().inbox.conversations) {
      if (convo.label) labels[idx] = convo.label;
    }
    void chrome.storage.local.set({ inboxLabels: labels });
  },

  sortedConversations: () => {
    const convos = Array.from(get().inbox.conversations.values());
    return convos.sort((a, b) => b.lastHeight - a.lastHeight);
  },
});

// ── selectors ──

export const inboxSelector = (state: AllSlices) => state.inbox;
export const selectConversations = (state: AllSlices) => state.inbox.sortedConversations();
export const selectUnreadCount = (state: AllSlices) => {
  let total = 0;
  for (const convo of state.inbox.conversations.values()) {
    total += convo.unread;
  }
  return total;
};
