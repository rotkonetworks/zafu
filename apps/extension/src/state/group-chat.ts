/**
 * group-chat slice - multisig coordination chat, one thread per group.
 *
 * The transport (GroupChatChannel) carries opaque sealed frames over a
 * dedicated frostd session; this slice is the thread state the inbox renders:
 * hydrating local history, opening/closing the live poll, appending and
 * de-duplicating frames, and persisting the log encrypted at rest.
 *
 * A group id is a multisig wallet id. A wallet can be chatted with only once
 * its co-signers' relay keys are on file (relayPeerKeys) - the same key set a
 * signing session needs. Airgap groups qualify too: the zafu companion of an
 * airgap signer is the relay participant, only the zigner is offline.
 *
 * The live channel and its abort controller are class instances and an
 * AbortController, so they live in a module map rather than in the immer state.
 */

import type { SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import { GroupChatChannel } from './keyring/group-chat-channel';
import { getOrCreateRelayIdentity, buildRelayIdentity } from './keyring/relay-identity';
import { DEFAULT_RELAY_URL } from '../routes/popup/multisig/dkg-helpers';

/** One rendered chat message. Mirrors the persisted shape. */
export interface GroupChatMessage {
  id: string;
  senderPub: string;
  body: string;
  ts: number;
  recvTs: number;
  mine: boolean;
}

type ThreadStatus = 'idle' | 'connecting' | 'live' | 'error';

interface ThreadState {
  messages: GroupChatMessage[];
  status: ThreadStatus;
  error?: string;
}

/** The frame envelope put on the wire (then sealed per peer). */
interface ChatFrame {
  v: 1;
  id: string;
  body: string;
  ts: number;
}

/** Live runtime handles, kept out of the serialisable store. */
interface Runtime {
  channel: GroupChatChannel;
  abort: AbortController;
}
const runtimes = new Map<string, Runtime>();
/** groups whose open() is mid-flight, to stop a second open racing a channel. */
const opening = new Set<string>();

/**
 * Serialise every read-modify-write of the single `groupChats` key. Message
 * persistence and the session-id cache write both mutate one storage key from
 * separate async paths; without a queue a poll batch persisting concurrently
 * with the cache write would clobber one of them (last full-object write wins).
 */
let writeChain: Promise<void> = Promise.resolve();
const updateGroupChats = (
  local: ExtensionStorage<LocalStorageState>,
  mutate: (all: Record<string, { chatSessionId?: string; messages: GroupChatMessage[] }>) => void,
): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const all = ((await local.get('groupChats')) ?? {}) as Record<
      string,
      { chatSessionId?: string; messages: GroupChatMessage[] }
    >;
    mutate(all);
    await local.set('groupChats', all);
  });
  return writeChain;
};

/** hard cap on a chat message, well under frostd's 64KB sealed-frame limit. */
export const MAX_CHAT_CHARS = 4000;

export interface GroupChatSlice {
  /** thread state by group (multisig wallet) id */
  threads: Record<string, ThreadState>;
  /** hydrate history, resolve the session and start polling for a group */
  openChat: (walletId: string) => Promise<void>;
  /** send a text message to the group */
  sendChat: (walletId: string, body: string) => Promise<void>;
  /** stop polling a group's thread (call on unmount) */
  closeChat: (walletId: string) => void;
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export const createGroupChatSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<GroupChatSlice> =>
  (set, get) => {
    /** merge a batch of messages into a thread, drop duplicates, keep time order, persist. */
    const ingest = async (walletId: string, incoming: GroupChatMessage[]): Promise<void> => {
      if (incoming.length === 0) {
        return;
      }
      set(state => {
        const thread = state.groupChat.threads[walletId] ?? { messages: [], status: 'live' };
        const seen = new Set(thread.messages.map(m => m.id));
        for (const m of incoming) {
          if (!seen.has(m.id)) {
            thread.messages.push(m);
            seen.add(m.id);
          }
        }
        thread.messages.sort((a, b) => a.recvTs - b.recvTs);
        state.groupChat.threads[walletId] = thread;
      });
      await persist(walletId);
    };

    /** write a group's message log to encrypted storage, preserving the cached
     *  session id. Serialised so a concurrent session-id write is not lost. */
    const persist = async (walletId: string): Promise<void> => {
      const thread = get().groupChat.threads[walletId];
      if (!thread) {
        return;
      }
      const messages = thread.messages;
      await updateGroupChats(local, all => {
        all[walletId] = { chatSessionId: all[walletId]?.chatSessionId, messages };
      });
    };

    const setStatus = (walletId: string, status: ThreadStatus, error?: string): void =>
      set(state => {
        const thread = state.groupChat.threads[walletId] ?? { messages: [], status };
        thread.status = status;
        thread.error = error;
        state.groupChat.threads[walletId] = thread;
      });

    /** decode + record a batch of inbound frames in one persist. */
    const handleFrames = async (
      walletId: string,
      myPub: string,
      incoming: { senderPub: string; payload: Uint8Array }[],
    ): Promise<void> => {
      const now = Date.now();
      const mineLower = myPub.toLowerCase();
      const messages: GroupChatMessage[] = [];
      for (const { senderPub, payload } of incoming) {
        let frame: ChatFrame;
        try {
          const parsed = JSON.parse(dec(payload)) as ChatFrame;
          if (parsed.v !== 1 || typeof parsed.id !== 'string' || typeof parsed.body !== 'string') {
            continue; // not a chat frame we understand
          }
          frame = parsed;
        } catch {
          continue;
        }
        messages.push({
          id: frame.id,
          senderPub,
          body: frame.body,
          ts: frame.ts,
          recvTs: now,
          // if a second device of the same user shares this identity, its own
          // frame comes back under our pubkey - render it as ours, not a peer's
          mine: senderPub.toLowerCase() === mineLower,
        });
      }
      await ingest(walletId, messages);
    };

    return {
      threads: {},

      openChat: async (walletId: string) => {
        // already live, or an open is already in flight - either way, do not
        // build a second channel racing the first (StrictMode double-mount,
        // fast re-entry). The long await chain below is the race window.
        if (runtimes.has(walletId) || opening.has(walletId)) {
          return;
        }
        opening.add(walletId);
        setStatus(walletId, 'connecting');

        try {
          // hydrate persisted history first, so the thread is populated even if
          // the relay is unreachable
          const stored = (await local.get('groupChats'))?.[walletId];
          if (stored?.messages?.length) {
            set(state => {
              const thread = state.groupChat.threads[walletId] ?? {
                messages: [],
                status: 'connecting',
              };
              thread.messages = stored.messages;
              state.groupChat.threads[walletId] = thread;
            });
          }

          const wallet = get().wallets.zcashWallets.find(w => w.id === walletId);
          const ms = wallet?.multisig;
          if (!ms) {
            setStatus(walletId, 'error', 'not a multisig wallet');
            return;
          }
          const peerKeys = ms.relayPeerKeys ?? [];
          if (peerKeys.length === 0) {
            setStatus(walletId, 'error', 'no co-signer relay keys on file - exchange them first');
            return;
          }

          const relayUrl = (typeof ms.relayUrl === 'string' && ms.relayUrl) || DEFAULT_RELAY_URL;
          const identityId = String(ms.relayCeremonyId ?? ms.publicKeyPackage);
          const relayIdentity = await getOrCreateRelayIdentity(identityId);
          const identity = await buildRelayIdentity(relayIdentity, peerKeys);
          const channel = new GroupChatChannel(relayUrl, identity, relayIdentity.privateKey);

          const all = (await local.get('groupChats')) ?? {};
          const cachedId = all[walletId]?.chatSessionId;
          const sessionId = await channel.resolveSession(cachedId);

          // cache the resolved session id (serialised, so a poll batch
          // persisting concurrently does not clobber it or lose its messages)
          if (sessionId !== cachedId) {
            await updateGroupChats(local, next => {
              next[walletId] = {
                chatSessionId: sessionId,
                messages: next[walletId]?.messages ?? [],
              };
            });
          }

          const abort = new AbortController();
          runtimes.set(walletId, { channel, abort });
          setStatus(walletId, 'live');

          // surface a thread that keeps failing to reach the relay rather than
          // leaving it stuck on "live"; recover to live on the next good poll
          let consecutiveFails = 0;
          void channel.poll(
            frames => {
              void handleFrames(
                walletId,
                identity.publicKey,
                frames.map(f => ({ senderPub: f.senderPub, payload: f.payload })),
              );
            },
            abort.signal,
            ok => {
              if (ok) {
                consecutiveFails = 0;
                if (get().groupChat.threads[walletId]?.status === 'error') {
                  setStatus(walletId, 'live');
                }
              } else if (++consecutiveFails >= 3) {
                setStatus(walletId, 'error', 'cannot reach the relay - retrying');
              }
            },
          );
        } catch (e) {
          setStatus(walletId, 'error', e instanceof Error ? e.message : String(e));
        } finally {
          opening.delete(walletId);
        }
      },

      sendChat: async (walletId: string, body: string) => {
        const text = body.trim();
        if (!text) {
          return;
        }
        if (text.length > MAX_CHAT_CHARS) {
          throw new Error(`message too long (max ${MAX_CHAT_CHARS} characters)`);
        }
        const rt = runtimes.get(walletId);
        if (!rt) {
          throw new Error('group chat: open the thread before sending');
        }
        const frame: ChatFrame = {
          v: 1,
          id: crypto.randomUUID(),
          body: text,
          ts: Date.now(),
        };
        // optimistic local echo, deduped against any relay echo by frame id
        await ingest(walletId, [
          { id: frame.id, senderPub: '', body: text, ts: frame.ts, recvTs: Date.now(), mine: true },
        ]);
        await rt.channel.send(enc(JSON.stringify(frame)));
      },

      closeChat: (walletId: string) => {
        const rt = runtimes.get(walletId);
        if (rt) {
          rt.abort.abort();
          rt.channel.stop();
          runtimes.delete(walletId);
        }
      },
    };
  };

export const groupChatSelector = (state: { groupChat: GroupChatSlice }) => state.groupChat;
