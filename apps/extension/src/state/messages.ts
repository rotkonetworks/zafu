/**
 * messages state slice - encrypted inbox
 *
 * stores decrypted memos from zcash and penumbra transactions,
 * providing an email-like inbox experience for encrypted communication.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';

export type MessageNetwork = 'penumbra' | 'zcash';

export interface Message {
  id: string;
  network: MessageNetwork;
  /** sender address (if known - might be shielded/unknown) */
  senderAddress?: string;
  /** recipient address (our address) */
  recipientAddress: string;
  /** the decrypted memo content */
  content: string;
  /** transaction id/hash */
  txId: string;
  /** block height */
  blockHeight: number;
  /** timestamp in ms */
  timestamp: number;
  /** direction */
  direction: 'sent' | 'received';
  /** read status */
  read: boolean;
  /** if this was a payment with memo, the amount */
  amount?: string;
  /** asset/denom */
  asset?: string;
}

export interface MessagesSlice {
  messages: Message[];

  /** add a new message (from tx processing) */
  addMessage: (message: Omit<Message, 'id'>) => Promise<Message>;

  /** add multiple messages (batch from sync) */
  addMessages: (messages: Omit<Message, 'id'>[]) => Promise<void>;

  /** mark a message as read */
  markRead: (id: string) => Promise<void>;

  /** mark all messages as read */
  markAllRead: () => Promise<void>;

  /** delete a message */
  deleteMessage: (id: string) => Promise<void>;

  /** get inbox (received messages) */
  getInbox: () => Message[];

  /** get sent messages */
  getSent: () => Message[];

  /** get unread count */
  getUnreadCount: () => number;

  /** get messages for a specific address (conversation) */
  getConversation: (address: string) => Message[];

  /** get messages by network */
  getByNetwork: (network: MessageNetwork) => Message[];

  /** search messages by content */
  search: (query: string) => Message[];

  /** check if a tx already has a message */
  hasMessage: (txId: string) => boolean;
}

const generateId = () => crypto.randomUUID();

export const createMessagesSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<MessagesSlice> =>
  (set, get) => ({
    messages: [],

    addMessage: async (messageData) => {
      // skip if we already have this tx
      if (get().messages.hasMessage(messageData.txId)) {
        const existing = get().messages.messages.find((m) => m.txId === messageData.txId);
        return existing!;
      }

      const message: Message = {
        ...messageData,
        id: generateId(),
      };

      set((state) => {
        state.messages.messages.push(message);
      });

      await local.set('messages' as keyof LocalStorageState, get().messages.messages as never);
      return message;
    },

    addMessages: async (messagesData) => {
      const existingTxIds = new Set(get().messages.messages.map((m) => m.txId));
      const newMessages = messagesData
        .filter((m) => !existingTxIds.has(m.txId))
        .map((m) => ({ ...m, id: generateId() }));

      if (newMessages.length === 0) return;

      set((state) => {
        state.messages.messages.push(...newMessages);
      });

      await local.set('messages' as keyof LocalStorageState, get().messages.messages as never);
    },

    markRead: async (id) => {
      set((state) => {
        const msg = state.messages.messages.find((m) => m.id === id);
        if (msg) {
          msg.read = true;
        }
      });

      await local.set('messages' as keyof LocalStorageState, get().messages.messages as never);
    },

    markAllRead: async () => {
      set((state) => {
        state.messages.messages.forEach((m) => {
          m.read = true;
        });
      });

      await local.set('messages' as keyof LocalStorageState, get().messages.messages as never);
    },

    deleteMessage: async (id) => {
      set((state) => {
        state.messages.messages = state.messages.messages.filter((m) => m.id !== id);
      });

      await local.set('messages' as keyof LocalStorageState, get().messages.messages as never);
    },

    getInbox: () => {
      return [...get().messages.messages]
        .filter((m) => m.direction === 'received')
        .sort((a, b) => b.timestamp - a.timestamp);
    },

    getSent: () => {
      return [...get().messages.messages]
        .filter((m) => m.direction === 'sent')
        .sort((a, b) => b.timestamp - a.timestamp);
    },

    getUnreadCount: () => {
      return get().messages.messages.filter((m) => !m.read && m.direction === 'received').length;
    },

    getConversation: (address) => {
      const normalized = address.toLowerCase();
      return [...get().messages.messages]
        .filter(
          (m) =>
            m.senderAddress?.toLowerCase() === normalized ||
            m.recipientAddress.toLowerCase() === normalized
        )
        .sort((a, b) => a.timestamp - b.timestamp);
    },

    getByNetwork: (network) => {
      return [...get().messages.messages]
        .filter((m) => m.network === network)
        .sort((a, b) => b.timestamp - a.timestamp);
    },

    search: (query) => {
      const q = query.toLowerCase();
      return get().messages.messages.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          m.senderAddress?.toLowerCase().includes(q)
      );
    },

    hasMessage: (txId) => {
      return get().messages.messages.some((m) => m.txId === txId);
    },
  });

// selectors
export const messagesSelector = (state: AllSlices) => state.messages;
export const inboxSelector = (state: AllSlices) => state.messages.getInbox();
export const sentSelector = (state: AllSlices) => state.messages.getSent();
export const unreadCountSelector = (state: AllSlices) => state.messages.getUnreadCount();
