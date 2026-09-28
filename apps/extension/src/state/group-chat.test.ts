/**
 * group-chat slice tests - the thread state around the transport: replay
 * rejection via the per-sender counter, inbound limits, the bound on the
 * retained log, persist-failure surfacing, and open/close cancellation.
 *
 * The channel and relay identity are mocked; the transport's own behaviour is
 * covered in keyring/group-chat-channel.test.ts and group-chat-crypto.test.ts.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import {
  createGroupChatSlice,
  MAX_FRAME_BYTES,
  MAX_THREAD_MESSAGES,
  type GroupChatSlice,
} from './group-chat';

/** the mocked channel, as the slice sees it */
interface FakeChannel {
  onFrames: ((frames: { senderPub: string; payload: Uint8Array }[]) => void) | null;
  pollStarted: boolean;
  stopped: boolean;
}

const h = vi.hoisted(() => ({
  myPub: 'aa'.repeat(32),
  peer: 'cc'.repeat(32),
  created: [] as FakeChannel[],
  resolve: async (): Promise<string> => 'sess-1',
}));

vi.mock('./keyring/group-chat-channel', () => ({
  GroupChatChannel: class {
    onFrames: FakeChannel['onFrames'] = null;
    pollStarted = false;
    stopped = false;
    constructor() {
      h.created.push(this);
    }
    async resolveSession(_cached?: string): Promise<string> {
      return h.resolve();
    }
    async send(): Promise<void> {
      /* no-op */
    }
    async poll(onFrames: NonNullable<FakeChannel['onFrames']>): Promise<void> {
      this.pollStarted = true;
      this.onFrames = onFrames;
    }
    stop(): void {
      this.stopped = true;
    }
  },
}));

vi.mock('./keyring/relay-identity', () => ({
  getOrCreateRelayIdentity: async () => ({ privateKey: '11'.repeat(32), publicKey: h.myPub }),
  buildRelayIdentity: async (_r: unknown, peers: string[]) => ({
    publicKey: h.myPub,
    peers,
    sign: async () => new Uint8Array(64),
    cipher: {},
  }),
}));

const storage = new Map<string, unknown>();
const makeLocal = (failSet = false): ExtensionStorage<LocalStorageState> =>
  ({
    get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => {
      if (failSet) {
        throw new Error('storage write failed');
      }
      storage.set(key, value);
    },
    remove: async (key: string) => void storage.delete(key),
    clear: async () => storage.clear(),
  }) as unknown as ExtensionStorage<LocalStorageState>;

type TestState = { wallets: unknown; groupChat: GroupChatSlice };

const makeStore = (local: ExtensionStorage<LocalStorageState>) =>
  create<TestState>()(
    immer((set, get) => ({
      wallets: {
        zcashWallets: [{ id: 'w1', multisig: { relayPeerKeys: [h.peer], relayCeremonyId: 'c1' } }],
      },
      // the slice's set/get are typed for the full store; only the shape used by
      // this slice matters here, so the mismatch is erased at this one boundary
      groupChat: createGroupChatSlice(local)(set as never, get as never, undefined as never),
    })),
  );

const enc = (s: string) => new TextEncoder().encode(s);
const inbound = (body: string, seq: number, id = `id-${seq}`) => ({
  senderPub: h.peer,
  payload: enc(JSON.stringify({ v: 1, id, body, ts: Date.now(), seq })),
});

/** let the fire-and-forget handleFrames promise chain (all microtasks) settle */
const settle = async () => {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
};

const openAndGetChannel = async (store: { getState: () => TestState }) => {
  await store.getState().groupChat.openChat('w1');
  return h.created.at(-1)!;
};

describe('group-chat slice', () => {
  beforeEach(() => {
    storage.clear();
    h.created.length = 0;
    h.resolve = async () => 'sess-1';
    // the module-level runtime map outlives a test's store; close the previous
    // thread so each test starts from a clean open() path
    makeStore(makeLocal()).getState().groupChat.closeChat('w1');
  });

  test('rejects a replayed older-counter frame from the same sender', async () => {
    const store = makeStore(makeLocal());
    const chan = await openAndGetChannel(store);

    chan.onFrames!([inbound('newer', 2)]);
    await settle();
    chan.onFrames!([inbound('older', 1)]);
    await settle();

    const messages = store.getState().groupChat.threads['w1']!.messages;
    expect(messages.map(m => m.body)).toEqual(['newer']);
  });

  test('rejects an oversized inbound frame', async () => {
    const store = makeStore(makeLocal());
    const chan = await openAndGetChannel(store);

    // a well-formed envelope whose body pushes the frame past the byte cap;
    // older code had no receive-side size limit and stored it
    const payload = enc(
      JSON.stringify({
        v: 1,
        id: 'big',
        body: 'x'.repeat(MAX_FRAME_BYTES),
        ts: Date.now(),
        seq: 1,
      }),
    );
    chan.onFrames!([{ senderPub: h.peer, payload }]);
    await settle();

    expect(store.getState().groupChat.threads['w1']!.messages).toEqual([]);
  });

  test('rejects a frame with a non-finite ts', async () => {
    const store = makeStore(makeLocal());
    const chan = await openAndGetChannel(store);

    // 1e999 parses to Infinity - a length/counter-valid frame with a bogus time
    chan.onFrames!([
      { senderPub: h.peer, payload: enc('{"v":1,"id":"nf","body":"hi","ts":1e999,"seq":1}') },
    ]);
    await settle();

    expect(store.getState().groupChat.threads['w1']!.messages).toEqual([]);
  });

  test('bounds the retained message log', async () => {
    const store = makeStore(makeLocal());
    const chan = await openAndGetChannel(store);

    const frames = Array.from({ length: MAX_THREAD_MESSAGES + 5 }, (_, i) =>
      inbound(`m${i}`, i + 1),
    );
    chan.onFrames!(frames);
    await settle();

    const messages = store.getState().groupChat.threads['w1']!.messages;
    expect(messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(messages[0]!.body).toBe('m5'); // the oldest five were evicted
  });

  test('surfaces a persist failure as thread error instead of swallowing it', async () => {
    storage.set('groupChats', { w1: { chatSessionId: 'sess-1', messages: [] } });
    const store = makeStore(makeLocal(true));
    const chan = await openAndGetChannel(store);
    expect(store.getState().groupChat.threads['w1']!.status).toBe('live');

    chan.onFrames!([inbound('hi', 1)]);
    await settle();

    expect(store.getState().groupChat.threads['w1']!.status).toBe('error');
  });

  test('closeChat cancels an in-flight open so no orphan poll is installed', async () => {
    const store = makeStore(makeLocal());
    const gate = Promise.withResolvers<string>();
    h.resolve = () => gate.promise;

    const opening = store.getState().groupChat.openChat('w1');
    await settle(); // openChat is now awaiting resolveSession
    store.getState().groupChat.closeChat('w1');
    gate.resolve('sess-1');
    await opening;

    const chan = h.created.at(-1)!;
    expect(chan.stopped).toBe(true);
    expect(chan.pollStarted).toBe(false);
    await expect(store.getState().groupChat.sendChat('w1', 'hi')).rejects.toThrow(
      /open the thread before sending/,
    );
  });
});
