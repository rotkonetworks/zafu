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
  /** authenticated monotonic per-sender counter, sealed inside the frame. */
  seq: number;
  mine: boolean;
}

type ThreadStatus = 'idle' | 'connecting' | 'live' | 'error';

interface ThreadState {
  messages: GroupChatMessage[];
  status: ThreadStatus;
  error?: string;
  /** highest accepted `seq` per lowercased sender pubkey - the replay guard.
   *  Persisted alongside the messages so trimming the log cannot reset it. */
  sendCounters: Record<string, number>;
}

/** The frame envelope put on the wire (then sealed per peer). */
interface ChatFrame {
  v: 1;
  id: string;
  body: string;
  ts: number;
  /** per-sender monotonic counter; a frame not newer than the highest seen
   *  from its sender is a replay/rollback and is rejected. */
  seq: number;
}

/** A thread as persisted under the single `groupChats` storage key. */
type StoredChats = NonNullable<LocalStorageState['groupChats']>;

/** Live runtime handles, kept out of the serialisable store. */
interface Runtime {
  channel: GroupChatChannel;
  abort: AbortController;
  /** our relay pubkey, so an optimistic local echo carries a real sender label. */
  publicKey: string;
}
const runtimes = new Map<string, Runtime>();
/** groups whose open() is mid-flight, keyed by the generation it is running. */
const opening = new Map<string, number>();
/** cancellation generation per group: closeChat bumps it to abort an in-flight open. */
const generation = new Map<string, number>();

/**
 * Serialise every read-modify-write of the single `groupChats` key. Message
 * persistence and the session-id cache write both mutate one storage key from
 * separate async paths; without a queue a poll batch persisting concurrently
 * with the cache write would clobber one of them (last full-object write wins).
 */
let writeChain: Promise<void> = Promise.resolve();
const updateGroupChats = (
  local: ExtensionStorage<LocalStorageState>,
  mutate: (all: StoredChats) => void,
): Promise<void> => {
  const run = writeChain.then(async () => {
    const all = ((await local.get('groupChats')) ?? {}) as StoredChats;
    mutate(all);
    await local.set('groupChats', all);
  });
  // keep the queue alive across a failed write: assigning the rejected promise
  // would wedge every later write behind it. The caller still sees `run`.
  writeChain = run.catch(() => {});
  return run;
};

/** hard cap on a chat message, well under frostd's 64KB sealed-frame limit. */
export const MAX_CHAT_CHARS = 4000;

/** Cap on a whole inbound frame: MAX_CHAT_CHARS chars is at most 4 UTF-8 bytes
 *  each, plus the small JSON envelope. Anything larger is not a chat frame. */
export const MAX_FRAME_BYTES = MAX_CHAT_CHARS * 4 + 512;

/** Retained messages per thread. The per-sender counters persist separately, so
 *  trimming old messages cannot let their ciphertext be re-ingested. */
export const MAX_THREAD_MESSAGES = 500;

/** Derive per-sender counters from persisted messages (legacy threads predate
 *  the counter, and a trimmed log may have dropped earlier ones). */
const countersFromMessages = (messages: GroupChatMessage[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of messages) {
    const sender = m.senderPub.toLowerCase();
    out[sender] = Math.max(out[sender] ?? 0, m.seq ?? 0);
  }
  return out;
};

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
    /** Merge a batch of messages into a thread: drop duplicates and any frame
     *  not newer than the highest counter seen from its sender (replay guard),
     *  append in acceptance order, bound the log, persist. */
    const ingest = async (walletId: string, incoming: GroupChatMessage[]): Promise<void> => {
      if (incoming.length === 0) {
        return;
      }
      let changed = false;
      set(state => {
        const thread =
          state.groupChat.threads[walletId] ??
          ({ messages: [], status: 'live', sendCounters: {} } satisfies ThreadState);
        const seen = new Set(thread.messages.map(m => m.id));
        for (const m of incoming) {
          const sender = m.senderPub.toLowerCase();
          const highest = thread.sendCounters[sender] ?? 0;
          // a frame not newer than the highest counter accepted from this
          // sender is a replay/rollback - retained ciphertext cannot re-ingest
          if (m.seq <= highest) {
            continue;
          }
          if (seen.has(m.id)) {
            continue;
          }
          thread.messages.push(m);
          seen.add(m.id);
          thread.sendCounters[sender] = m.seq;
          changed = true;
        }
        if (thread.messages.length > MAX_THREAD_MESSAGES) {
          thread.messages.splice(0, thread.messages.length - MAX_THREAD_MESSAGES);
        }
        state.groupChat.threads[walletId] = thread;
      });
      if (changed) {
        await persist(walletId);
      }
    };

    /** write a group's message log to encrypted storage, preserving the cached
     *  session id and the per-sender counters. Serialised so a concurrent
     *  session-id write is not lost. */
    const persist = async (walletId: string): Promise<void> => {
      const thread = get().groupChat.threads[walletId];
      if (!thread) {
        return;
      }
      const { messages, sendCounters } = thread;
      await updateGroupChats(local, all => {
        all[walletId] = { chatSessionId: all[walletId]?.chatSessionId, messages, sendCounters };
      });
    };

    const setStatus = (walletId: string, status: ThreadStatus, error?: string): void =>
      set(state => {
        const thread =
          state.groupChat.threads[walletId] ??
          ({ messages: [], status, sendCounters: {} } satisfies ThreadState);
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
        // a frame larger than a max-length message plus the envelope is not a
        // chat frame - reject before parsing so the relay cannot make us parse
        // or store unbounded input
        if (payload.byteLength > MAX_FRAME_BYTES) {
          continue;
        }
        let frame: ChatFrame;
        try {
          const parsed = JSON.parse(dec(payload)) as Partial<ChatFrame>;
          if (
            parsed.v !== 1 ||
            typeof parsed.id !== 'string' ||
            typeof parsed.body !== 'string' ||
            typeof parsed.ts !== 'number' ||
            !Number.isFinite(parsed.ts) ||
            typeof parsed.seq !== 'number' ||
            !Number.isInteger(parsed.seq) ||
            parsed.seq <= 0
          ) {
            continue; // not a chat frame we understand
          }
          frame = parsed as ChatFrame;
        } catch {
          continue;
        }
        messages.push({
          id: frame.id,
          senderPub,
          body: frame.body,
          ts: frame.ts,
          recvTs: now,
          seq: frame.seq,
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
        // already live - nothing to do. Otherwise a stale in-flight open (or a
        // StrictMode double-mount) is superseded below rather than raced.
        if (runtimes.has(walletId)) {
          return;
        }
        // an open already running for the CURRENT generation is the same
        // open (double-mount): do not build a second channel. A close() bumps
        // the generation, so a genuine re-open after close gets through.
        if (opening.has(walletId) && opening.get(walletId) === (generation.get(walletId) ?? 0)) {
          return;
        }
        const gen = (generation.get(walletId) ?? 0) + 1;
        generation.set(walletId, gen);
        opening.set(walletId, gen);
        // true once closeChat (or a newer open) has bumped the generation; the
        // long await chain below is the window in which that can happen
        const cancelled = () => generation.get(walletId) !== gen;

        setStatus(walletId, 'connecting');
        let channel: GroupChatChannel | undefined;

        try {
          // hydrate persisted history first, so the thread is populated even if
          // the relay is unreachable
          const stored = (await local.get('groupChats'))?.[walletId];
          if (cancelled()) {
            return;
          }
          if (stored?.messages?.length) {
            set(state => {
              const thread =
                state.groupChat.threads[walletId] ??
                ({ messages: [], status: 'connecting', sendCounters: {} } satisfies ThreadState);
              // threads written by older builds have no seq; treat as counter 0
              thread.messages = stored.messages.map(m => ({ ...m, seq: m.seq ?? 0 }));
              thread.sendCounters = stored.sendCounters ?? countersFromMessages(thread.messages);
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
          if (cancelled()) {
            return;
          }
          const identity = await buildRelayIdentity(relayIdentity, peerKeys);
          if (cancelled()) {
            return;
          }
          channel = new GroupChatChannel(relayUrl, identity, relayIdentity.privateKey);

          const all = (await local.get('groupChats')) ?? {};
          const cachedId = all[walletId]?.chatSessionId;
          const sessionId = await channel.resolveSession(cachedId);
          // the user may have closed the thread while we were resolving or
          // creating the session - abort the orphan channel rather than
          // installing a poll loop nobody will ever stop.
          if (cancelled()) {
            channel.stop();
            return;
          }

          // cache the resolved session id (serialised, so a poll batch
          // persisting concurrently does not clobber it or lose its messages)
          if (sessionId !== cachedId) {
            await updateGroupChats(local, next => {
              next[walletId] = {
                chatSessionId: sessionId,
                messages: next[walletId]?.messages ?? [],
                sendCounters: next[walletId]?.sendCounters,
              };
            });
            if (cancelled()) {
              channel.stop();
              return;
            }
          }

          const abort = new AbortController();
          runtimes.set(walletId, { channel, abort, publicKey: identity.publicKey });
          setStatus(walletId, 'live');

          // surface a thread that keeps failing to reach the relay rather than
          // leaving it stuck on "live"; recover to live on the next good poll
          let consecutiveFails = 0;
          void channel.poll(
            frames => {
              void handleFrames(walletId, identity.publicKey, frames).catch(e => {
                // a persist failure must not vanish into a bare `void`
                setStatus(walletId, 'error', e instanceof Error ? e.message : String(e));
              });
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
          if (!cancelled()) {
            setStatus(walletId, 'error', e instanceof Error ? e.message : String(e));
          }
        } finally {
          // only clear the in-flight marker if this is still the current
          // generation; a newer open owns it otherwise
          if (opening.get(walletId) === gen) {
            opening.delete(walletId);
          }
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
        const sender = rt.publicKey.toLowerCase();
        const seq = (get().groupChat.threads[walletId]?.sendCounters[sender] ?? 0) + 1;
        const frame: ChatFrame = {
          v: 1,
          id: crypto.randomUUID(),
          body: text,
          ts: Date.now(),
          seq,
        };
        // optimistic local echo, deduped against any relay echo by frame id
        await ingest(walletId, [
          {
            id: frame.id,
            senderPub: rt.publicKey,
            body: text,
            ts: frame.ts,
            recvTs: Date.now(),
            seq,
            mine: true,
          },
        ]);
        await rt.channel.send(enc(JSON.stringify(frame)));
      },

      closeChat: (walletId: string) => {
        // bump the generation FIRST: an in-flight openChat checks it after each
        // await and, if it has moved, aborts the channel it just built instead
        // of installing an orphan poll loop nobody will stop.
        generation.set(walletId, (generation.get(walletId) ?? 0) + 1);
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
