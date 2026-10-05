/** @vitest-environment node */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  castPosition,
  castVote,
  fetchRoundParams,
  fetchRounds,
  postVoteTx,
  submitDelegation,
  submitShare,
  submitShares,
} from './api';
import { BUNDLED_SERVICE_CONFIG } from './bundled-config';
import type { VotingServiceConfig } from './types';

// the bundled prod config (endorsed rounds, pir layout) on test servers
const withServers = (...urls: string[]): VotingServiceConfig => ({
  ...BUNDLED_SERVICE_CONFIG,
  vote_servers: urls.map((url, i) => ({ url, label: `s${i}` })),
});
const config = withServers('https://vote.example/');

type Reply = { status?: number; body?: unknown } | Error;
const calls: { url: string; init?: RequestInit }[] = [];

/** `route(url, init)` answers each request; an Error is thrown as a fetch failure. */
const stubFetch = (route: (url: string, init?: RequestInit) => Reply) => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = route(url, init);
    if (r instanceof Error) {
      throw r;
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const hex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');
const b64 = (hexStr: string) => Buffer.from(hexStr, 'hex').toString('base64');

// trimmed from zvote-1's /shielded-vote/v1/rounds (vote-sdk 1.6.1-rc.5); its
// ea_pk is the one the bundled config endorses for this round id
const ROUND_ID = '2cba66eb16c7581a1692cb0b033785da0131059f645a0d2fb4dc2a5131505e01';
const prodRound = {
  vote_round_id: b64(ROUND_ID),
  snapshot_height: 3459350,
  vote_end_time: 1790712000,
  nullifier_imt_root: 'Ni6vFMWV1N90kyu8wYS1zV0YllkmaMLbp9zXusaF2gk=',
  nc_root: 'BgoT1255jEYLGlFJfmIfYankgrrh3vPKBu7LDYWl1B0=',
  status: 1,
  ea_pk: BUNDLED_SERVICE_CONFIG.rounds[ROUND_ID]!.ea_pk,
  title: 'Coinholder Retroactive Grants Q3',
  proposals: Array.from({ length: 37 }, (_, i) => ({
    id: i + 1,
    title: `grant ${i + 1}`,
    // proto3 drops index 0 from the wire
    options: [{ label: 'Support' }, { index: 1, label: 'Oppose' }, { index: 2, label: 'Abstain' }],
  })),
};
const otherKey = Buffer.alloc(32, 9).toString('base64');

describe('fetchRounds', () => {
  test('keeps the endorsed key and every proposal past 16', async () => {
    stubFetch(() => ({ body: { rounds: [prodRound] } }));
    const [round] = await fetchRounds(config);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/rounds');
    expect(round!.id).toBe(ROUND_ID);
    expect(round!.eaPkHex).toBe(hex(prodRound.ea_pk));
    expect(round!.inConfig).toBe(true);
    expect(round!.proposals).toHaveLength(37);
    expect(round!.proposals[36]!.id).toBe(37);
  });

  test('a server that reports another ea_pk leaves the round without a key', async () => {
    stubFetch(() => ({ body: { rounds: [{ ...prodRound, ea_pk: otherKey }] } }));
    const [round] = await fetchRounds(config);
    expect(round!.eaPkHex).toBeUndefined();
  });

  test('a round the bundled config does not endorse has no key, whatever the server says', async () => {
    const id = 'ab'.repeat(32);
    stubFetch(() => ({ body: { rounds: [{ ...prodRound, vote_round_id: b64(id) }] } }));
    const [round] = await fetchRounds(config);
    expect(round!.inConfig).toBe(false);
    expect(round!.eaPkHex).toBeUndefined();
  });

  test('option ids are the vote_decision index, with index 0 omitted', async () => {
    stubFetch(() => ({ body: { rounds: [prodRound] } }));
    const [round] = await fetchRounds(config);
    expect(round!.proposals[0]!.options).toEqual([
      { id: 0, label: 'Support' },
      { id: 1, label: 'Oppose' },
      { id: 2, label: 'Abstain' },
    ]);
  });

  test('a round still in its key ceremony (PENDING) is starting, not cancelled', async () => {
    const { ea_pk: _, ...pending } = prodRound;
    stubFetch(() => ({
      body: {
        rounds: [
          { ...pending, status: 4 },
          { ...prodRound, status: 5 },
        ],
      },
    }));
    const [a, b] = await fetchRounds(config);
    expect(a!.status).toBe('starting');
    expect(b!.status).toBe('cancelled');
  });
});

describe('fetchRoundParams', () => {
  const two = withServers('https://a.example', 'https://b.example', 'https://c.example');

  test('takes the roots once two servers agree, and ea_pk from the endorsement', async () => {
    stubFetch(() => ({ body: { round: prodRound } }));
    const p = await fetchRoundParams(two, ROUND_ID);
    expect(p).toEqual({
      voteRoundId: ROUND_ID,
      snapshotHeight: 3459350,
      eaPkHex: hex(prodRound.ea_pk),
      ncRootHex: hex(prodRound.nc_root),
      nullifierImtRootHex: hex(prodRound.nullifier_imt_root),
    });
    expect(calls.map(c => new URL(c.url).host)).toEqual(['a.example', 'b.example']);
  });

  test('servers that disagree on a root stop it', async () => {
    stubFetch(url =>
      url.includes('b.example')
        ? { body: { round: { ...prodRound, nc_root: Buffer.alloc(32, 1).toString('base64') } } }
        : { body: { round: prodRound } },
    );
    await expect(fetchRoundParams(two, ROUND_ID)).rejects.toThrow(/disagree/);
  });

  test('a server with another ea_pk stops it', async () => {
    stubFetch(url =>
      url.includes('a.example')
        ? { body: { round: { ...prodRound, ea_pk: otherKey } } }
        : { body: { round: prodRound } },
    );
    await expect(fetchRoundParams(two, ROUND_ID)).rejects.toThrow(/another election key/);
  });

  test('one answering server is not enough; a short root is not an answer', async () => {
    stubFetch(url =>
      url.includes('a.example')
        ? { body: { round: prodRound } }
        : url.includes('b.example')
          ? { body: { round: { ...prodRound, nc_root: 'AAAA' } } }
          : new TypeError('fetch failed'),
    );
    await expect(fetchRoundParams(two, ROUND_ID)).rejects.toThrow(/1 of the 2/);
  });

  test('an unendorsed round never gets params', async () => {
    stubFetch(() => ({ body: { round: prodRound } }));
    await expect(fetchRoundParams(two, 'ab'.repeat(32))).rejects.toThrow(/no endorsed/);
    expect(calls).toHaveLength(0);
  });
});

describe('vote-chain POSTs', () => {
  const two = withServers('https://a.example', 'https://b.example');
  const HASH = 'AB'.repeat(32);

  test('delegation goes to /delegate-vote and keeps the tx hash', async () => {
    stubFetch(() => ({ body: { tx_hash: HASH, code: 0 } }));
    const res = await submitDelegation(config, '{"tx1_effects":"AQ=="}');
    expect(res).toMatchObject({ ok: true, txHash: HASH });
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/delegate-vote');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  test('a cast goes to /cast-vote and keeps the tx hash', async () => {
    stubFetch(() => ({ body: { tx_hash: HASH, code: 0 } }));
    const res = await castVote(config, '{}');
    expect(res).toMatchObject({ ok: true, txHash: HASH });
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/cast-vote');
  });

  test('a timeout is unknown and never re-sent elsewhere', async () => {
    stubFetch(() => new DOMException('timed out', 'TimeoutError'));
    const res = await castVote(two, '{}');
    expect(res).toMatchObject({ ok: false, unknown: true });
    expect(res.rejected).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('400 and 422 are final, not failed over', async () => {
    stubFetch(() => ({ status: 400, body: { error: 'validation failed' } }));
    expect(await castVote(two, '{}')).toMatchObject({ rejected: true, status: 400 });
    expect(calls).toHaveLength(1);
    stubFetch(() => ({ status: 422, body: { tx_hash: HASH, code: 1, log: 'nullifier spent' } }));
    expect(await castVote(two, '{}')).toMatchObject({
      rejected: true,
      status: 422,
      message: 'nullifier spent',
    });
    expect(calls).toHaveLength(1);
  });

  test('after a dropped connection, a refusal is settled by hash: an included tx is accepted', async () => {
    stubFetch(url =>
      url.startsWith('https://a.example')
        ? new TypeError('connection reset')
        : url.endsWith('/cast-vote')
          ? { status: 422, body: { tx_hash: HASH, code: 1, log: 'nullifier already spent' } }
          : { body: { height: '792', code: 0, events: [] } },
    );
    const res = await castVote(two, '{}');
    expect(res).toMatchObject({ ok: true, txHash: HASH });
    expect(calls.map(c => c.url)).toEqual([
      'https://a.example/shielded-vote/v1/cast-vote',
      'https://b.example/shielded-vote/v1/cast-vote',
      // a.example is still down for the lookup; b.example answers it
      `https://a.example/shielded-vote/v1/tx/${HASH}`,
      `https://b.example/shielded-vote/v1/tx/${HASH}`,
    ]);
  });

  test('a 5xx naming a tx hash is looked up; pending stays unknown', async () => {
    stubFetch(url =>
      url.endsWith('/cast-vote')
        ? {
            status: 502,
            body: { error: `broadcast outcome unknown after retries; tx_hash=${HASH}: EOF` },
          }
        : { status: 404, body: { error: 'tx not found' } },
    );
    const res = await castVote(two, '{}');
    expect(res).toMatchObject({ ok: false, unknown: true, txHash: HASH });
    expect(calls).toHaveLength(2);
  });

  test('a 5xx without a hash fails over', async () => {
    stubFetch(url =>
      url.startsWith('https://a.example')
        ? { status: 503, body: {} }
        : { body: { tx_hash: HASH, code: 0 } },
    );
    expect(await castVote(two, '{}')).toMatchObject({ ok: true, txHash: HASH });
  });

  test('a re-send of an unknown cast settles a double-spend refusal by hash', async () => {
    stubFetch(url =>
      url.endsWith('/cast-vote')
        ? { status: 422, body: { tx_hash: HASH, code: 1, log: 'nullifier already spent' } }
        : { body: { height: 9, code: 0, events: [] } },
    );
    expect(
      await postVoteTx(two, '/shielded-vote/v1/cast-vote', '{}', { mayBeOnChain: true }),
    ).toMatchObject({ ok: true, txHash: HASH });
  });

  test('a chain past TX1 effects v1 gets a clear message', async () => {
    stubFetch(() => ({
      status: 400,
      body: { error: 'unsupported tx1 effects version: expected 2, got 1' },
    }));
    const res = await submitDelegation(config, '{}');
    expect(res.rejected).toBe(true);
    expect(res.message).toMatch(/newer delegation format/);
  });
});

describe('castPosition', () => {
  const HASH = 'CD'.repeat(32);
  const vc = Buffer.alloc(32, 4).toString('base64');
  const van = Buffer.alloc(32, 3).toString('base64');
  const tx = {
    height: '792',
    code: 0,
    events: [
      {
        type: 'cast_vote',
        attributes: [
          { key: 'vote_round_id', value: ROUND_ID },
          { key: 'leaf_index', value: '3,4' },
        ],
      },
    ],
  };

  test('reads leaf_index from the included tx and checks it against the tree', async () => {
    stubFetch(url =>
      url.includes('/tx/')
        ? { body: tx }
        : { body: { blocks: [{ height: 792, start_index: 3, leaves: [van, vc] }] } },
    );
    expect(await castPosition(config, ROUND_ID, HASH, vc)).toEqual({
      height: 792,
      vcPosition: 4,
      vanPosition: 3,
    });
    expect(calls[1]!.url).toBe(
      `https://vote.example/shielded-vote/v1/commitment-tree/${ROUND_ID}/leaves?from_height=792&to_height=792`,
    );
  });

  test('a tree that does not hold this vote at that index is refused', async () => {
    stubFetch(url =>
      url.includes('/tx/')
        ? { body: tx }
        : { body: { blocks: [{ height: 792, start_index: 3, leaves: [vc, van] }] } },
    );
    await expect(castPosition(config, ROUND_ID, HASH, vc)).rejects.toThrow(/does not hold/);
  });

  test('waits while the tx is pending, and reports a failed tx', async () => {
    let n = 0;
    stubFetch(() =>
      n++ === 0
        ? { status: 404, body: {} }
        : { status: 422, body: { height: 5, code: 3, log: 'out of gas' } },
    );
    await expect(
      castPosition(config, ROUND_ID, HASH, vc, { attempts: 3, intervalMs: 1 }),
    ).rejects.toThrow(/out of gas/);
  });
});

describe('helper shares', () => {
  test('a share goes to the helper on that server', async () => {
    stubFetch(() => ({ body: { status: 'queued' } }));
    const res = await submitShare('https://vote.example/', '{}');
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/shares');
  });

  test('an array is refused before it is sent: one share per request', async () => {
    stubFetch(() => ({ body: {} }));
    const res = await submitShare('https://vote.example', '[{},{}]');
    expect(res).toMatchObject({ ok: false, message: 'one share object per request' });
    expect(calls).toHaveLength(0);
  });

  test('a refused share reports the helper error', async () => {
    stubFetch(() => ({ status: 400, body: { error: 'vote_round_id is required' } }));
    const res = await submitShare('https://vote.example', '{}');
    expect(res).toEqual({ ok: false, status: 400, message: 'vote_round_id is required' });
  });

  test('each share reaches half the helpers, rounded up, one share per request', async () => {
    const five = withServers(...[1, 2, 3, 4, 5].map(i => `https://h${i}.example`));
    stubFetch(() => ({ body: { status: 'queued' } }));
    const shares = Array.from({ length: 16 }, (_, i) => ({ share_index: i }));
    const res = await submitShares(five, JSON.stringify(shares));
    expect(res).toEqual({ total: 16, queued: 16, errors: [] });
    expect(calls).toHaveLength(16 * 3);
    for (const c of calls) {
      expect(Array.isArray(JSON.parse(String(c.init?.body)))).toBe(false);
    }
    for (let i = 0; i < 16; i++) {
      const hosts = calls
        .filter(c => JSON.parse(String(c.init?.body)).share_index === i)
        .map(c => new URL(c.url).host);
      expect(new Set(hosts).size).toBe(3);
    }
  });
});
