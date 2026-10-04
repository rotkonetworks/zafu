import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

const sent: unknown[] = [];
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: async (m: unknown) => {
      sent.push(m);
      return { ok: true, value: {} };
    },
  },
});

import {
  CARD_DEFAULT_RELAY,
  answersOf,
  cardV2Memos,
  readCardV2,
  signCardV2,
  fromB64url,
} from '@repo/wallet/networks/zcash/card-v2';
import { ingestCardMemos } from './client';

const seed = new Uint8Array(32).fill(4);
const answer = signCardV2(
  {
    kind: 'answer',
    revision: 0,
    key: bytesToHex(ed25519.getPublicKey(seed)),
    pairKa: 'ab'.repeat(32),
    answers: answersOf('cd'.repeat(32)),
    zcash: '11'.repeat(43),
    relay: CARD_DEFAULT_RELAY,
    caps: 3,
    created: 1,
    // a future X-Wing key: three memos in one transaction
    ext: [{ tag: 0x10, value: new Uint8Array(1216).fill(7) }],
  },
  seed,
);

describe('a v2 answer that came as memos', () => {
  it('its fragments, in any order, become one card for the worker', async () => {
    const memos = cardV2Memos(answer);
    expect(memos).toHaveLength(3);
    ingestCardMemos(
      [memos[2]!, memos[0]!, memos[1]!].map(memo => ({
        txid: 't1',
        height: 9,
        memo,
        isChange: false,
      })),
    );
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    const call = sent[0] as { op: string; card: string; height: number };
    expect(call).toMatchObject({ op: 'card-memo', height: 9 });
    expect(fromB64url(call.card)).toEqual(answer);
    expect(readCardV2(fromB64url(call.card))?.kind).toBe('answer');
  });

  it('what you sent yourself is not read as an answer', async () => {
    sent.length = 0;
    ingestCardMemos(
      cardV2Memos(answer).map(memo => ({ txid: 't2', height: 1, memo, isChange: true })),
    );
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
  });
});
