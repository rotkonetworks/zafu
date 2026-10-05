/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Key } from '@repo/encryption/key';
import { BUNDLED_SERVICE_CONFIG } from './bundled-config';
import type { VotingServiceConfig } from './types';

const worker = vi.hoisted(() => ({ casts: 0, shareBuilds: [] as number[] }));

vi.mock('../../state/keyring/network-worker', () => ({
  castVoteHotInWorker: async (a: { voteJson: string }) => {
    worker.casts++;
    const { proposal_id } = JSON.parse(a.voteJson) as { proposal_id: number };
    return {
      proposalId: proposal_id,
      wire: JSON.stringify({ vote_commitment: VC, proposal_id }),
      commitmentBundleJson: `{"bundle":${worker.casts}}`,
      nextDelegationStateJson: '{"proposal_authority":1}',
    };
  },
  buildVoteSharesFromRecoveryInWorker: async (a: { vcTreePosition: number }) => {
    worker.shareBuilds.push(a.vcTreePosition);
    return { sharesJson: JSON.stringify([0, 1, 2, 3].map(i => ({ share_index: i }))) };
  },
}));

const { castAndShare, resumeCast } = await import('./cast');
const { loadVoteCast, loadVotingRoundRecord, saveVotingHotkey } = await import('./persistence');

const VC = Buffer.alloc(32, 4).toString('base64');
const VAN = Buffer.alloc(32, 3).toString('base64');
const HASH = 'AB'.repeat(32);
const ROUND = 'cd'.repeat(32);

const config: VotingServiceConfig = {
  ...BUNDLED_SERVICE_CONFIG,
  vote_servers: ['https://a.example', 'https://b.example', 'https://c.example'].map(url => ({
    url,
    label: url,
  })),
};

type Reply = { status?: number; body?: unknown } | Error;
const calls: { url: string; body?: string }[] = [];
const stubFetch = (route: (url: string, body?: string) => Reply) => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body as string | undefined;
    calls.push({ url, body });
    const r = route(url, body);
    if (r instanceof Error) {
      throw r;
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
};

/** A chain that includes the cast at VAN 5 / VC 6 and queues every share. */
const happyChain = (url: string): Reply => {
  if (url.endsWith('/cast-vote')) {
    return { body: { tx_hash: HASH, code: 0 } };
  }
  if (url.includes('/tx/')) {
    return {
      body: {
        height: 9,
        code: 0,
        events: [{ type: 'cast_vote', attributes: [{ key: 'leaf_index', value: '5,6' }] }],
      },
    };
  }
  if (url.includes('/leaves')) {
    return { body: { blocks: [{ height: 9, start_index: 5, leaves: [VAN, VC] }] } };
  }
  return { body: { status: 'queued' } };
};

let deps: Awaited<ReturnType<typeof makeDeps>>;
const makeDeps = async () => {
  const { key } = await Key.create('pw');
  const keyJson = await key.toJson();
  const mem = new Map<string, unknown>();
  const local = {
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => void mem.set(k, v),
  } as never;
  const session = {
    get: async (k: string) => (k === 'passwordKey' ? keyJson : undefined),
  } as never;
  await saveVotingHotkey(local, session, 'w', ROUND, 'aa', 'pub');
  return { config, local, session, mem };
};

const args = (proposalId = 37) => ({
  walletId: 'w',
  network: 'mainnet',
  round: {
    voteRoundId: ROUND,
    snapshotHeight: 1,
    eaPkHex: '00'.repeat(32),
    ncRootHex: '00'.repeat(32),
    nullifierImtRootHex: '00'.repeat(32),
  },
  hotkeySecretHex: 'aa',
  delegationStateJson: '{}',
  vanWitnessJson: '{}',
  proposalId,
  choice: 1,
  numOptions: 2,
  submitAt: 0,
});

beforeEach(async () => {
  worker.casts = 0;
  worker.shareBuilds = [];
  deps = await makeDeps();
});
afterEach(() => vi.unstubAllGlobals());

describe('castAndShare', () => {
  test('casts, finds the position from the tx, sends every share, stores the next state', async () => {
    stubFetch(happyChain);
    const out = await castAndShare(deps, args());
    expect(out).toMatchObject({
      state: 'cast',
      txHash: HASH,
      position: { vcPosition: 6, vanPosition: 5 },
      total: 4,
      queued: 4,
    });
    expect(worker.shareBuilds).toEqual([6]);
    const rec = await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37);
    expect(rec).toMatchObject({ txHash: HASH, sharesQueued: true, sharesSent: [0, 1, 2, 3] });
    const round = await loadVotingRoundRecord(deps.local, deps.session, 'w', ROUND);
    expect(round!.delegationStateJson).toBe('{"proposal_authority":1}');
  });

  test('a vote already stored for the proposal is refused before any proof, untouched', async () => {
    stubFetch(happyChain);
    await castAndShare(deps, args());
    const before = await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37);
    calls.length = 0;
    const out = await castAndShare(deps, args());
    expect(out.state).toBe('exists');
    expect(worker.casts).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37)).toEqual(before);
  });

  test("one operator's 422 keeps the record, marked refused, when nobody else can confirm", async () => {
    stubFetch(url =>
      url.startsWith('https://a.example')
        ? { status: 422, body: { tx_hash: HASH, code: 1, log: 'nope' } }
        : new TypeError('down'),
    );
    const out = await castAndShare(deps, args());
    expect(out).toEqual({ state: 'refused', confirmed: false, message: 'nope' });
    const rec = await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37);
    expect(rec).toMatchObject({ refused: { operators: ['a.example'] }, txHash: HASH });
    expect(rec!.commitmentBundleJson).toBe('{"bundle":1}');
    // the delegation state is untouched: nothing landed
    const round = await loadVotingRoundRecord(deps.local, deps.session, 'w', ROUND);
    expect(round!.delegationStateJson).toBeNull();
  });

  test('a /tx "failed" from one operator does not delete it either', async () => {
    stubFetch(url =>
      url.startsWith('https://a.example') && url.includes('/tx/')
        ? { status: 422, body: { height: 9, code: 5, log: 'failed here' } }
        : url.startsWith('https://a.example')
          ? { status: 502, body: { error: `broadcast outcome unknown; tx_hash=${HASH}` } }
          : new TypeError('down'),
    );
    const out = await castAndShare(deps, args());
    expect(out).toMatchObject({ state: 'refused', confirmed: false });
    expect(await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37)).not.toBeNull();
  });

  test('a refusal two operators agree on (and no block holds) deletes it', async () => {
    stubFetch(url =>
      url.includes('/tx/')
        ? { status: 404 }
        : { status: 422, body: { tx_hash: HASH, code: 1, log: 'nullifier spent' } },
    );
    const out = await castAndShare(deps, args());
    expect(out).toMatchObject({ state: 'refused', confirmed: true });
    expect(await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37)).toBeNull();
  });

  test("another operator's acceptance overrules one refusal and the cast carries on", async () => {
    stubFetch(url =>
      url.startsWith('https://a.example') && url.endsWith('/cast-vote')
        ? { status: 422, body: { tx_hash: HASH, code: 1, log: 'lie' } }
        : url.includes('/tx/') && url.startsWith('https://b.example')
          ? { status: 404 }
          : happyChain(url),
    );
    const out = await castAndShare(deps, args());
    expect(out).toMatchObject({ state: 'cast', queued: 4 });
  });
});

describe('resumeCast', () => {
  test('an unknown cast is settled by re-sending the identical sealed wire, then finished', async () => {
    stubFetch(() => new DOMException('slow', 'TimeoutError'));
    expect((await castAndShare(deps, args())).state).toBe('unknown');
    const sealed = await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37);

    stubFetch(happyChain);
    const out = await resumeCast(deps, {
      walletId: 'w',
      roundId: ROUND,
      proposalId: 37,
      submitAt: 0,
    });
    expect(out).toMatchObject({ state: 'cast', txHash: HASH, queued: 4 });
    expect(worker.casts).toBe(1);
    expect(calls.find(c => c.url.endsWith('/cast-vote'))!.body).toBe(sealed!.wire);
  });

  test('only the shares no helper queued are sent again', async () => {
    let failing = true;
    stubFetch(url =>
      url.endsWith('/shares') && failing ? new TypeError('helpers down') : happyChain(url),
    );
    const first = await castAndShare(deps, args());
    expect(first).toMatchObject({ state: 'cast', queued: 0 });

    failing = false;
    let sent: number[] = [];
    stubFetch((url, body) => {
      if (url.endsWith('/shares')) {
        sent.push((JSON.parse(body!) as { share_index: number }).share_index);
      }
      return happyChain(url);
    });
    const second = await resumeCast(deps, {
      walletId: 'w',
      roundId: ROUND,
      proposalId: 37,
      submitAt: 0,
    });
    expect(second).toMatchObject({ state: 'cast', queued: 4 });
    // the position was kept: no second /tx lookup
    expect(calls.some(c => c.url.includes('/tx/'))).toBe(false);

    sent = [];
    const third = await resumeCast(deps, {
      walletId: 'w',
      roundId: ROUND,
      proposalId: 37,
      submitAt: 0,
    });
    expect(third).toMatchObject({ state: 'cast', queued: 4 });
    expect(sent).toEqual([]);
  });

  test('a refused record asks an operator that has not refused yet', async () => {
    stubFetch(url =>
      url.startsWith('https://a.example')
        ? { status: 422, body: { tx_hash: HASH, code: 1, log: 'nope' } }
        : new TypeError('down'),
    );
    await castAndShare(deps, args());

    stubFetch(url =>
      url.startsWith('https://a.example') ? new Error('must not ask a') : happyChain(url),
    );
    const out = await resumeCast(deps, {
      walletId: 'w',
      roundId: ROUND,
      proposalId: 37,
      submitAt: 0,
    });
    expect(out).toMatchObject({ state: 'cast', txHash: HASH });
    const rec = await loadVoteCast(deps.local, deps.session, 'w', ROUND, 37);
    expect(rec!.refused).toBeUndefined();
  });
});
