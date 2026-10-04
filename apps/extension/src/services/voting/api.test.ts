/** @vitest-environment node */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { castVote, fetchRounds, submitDelegation, submitShare } from './api';
import type { VotingServiceConfig } from './types';

const config: VotingServiceConfig = {
  config_version: 1,
  vote_servers: [{ url: 'https://vote.example/', label: 'one' }],
  pir_endpoints: [],
  supported_versions: { pir: ['v0'], vote_protocol: 'v0', tally: 'v0', vote_server: 'v1' },
  rounds: {},
};

const calls: { url: string; init?: RequestInit }[] = [];

const stubFetch = (handler: (url: string) => unknown, status = 200) => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(handler(url)), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// trimmed from zvote-1's /shielded-vote/v1/rounds (vote-sdk 1.6.1-rc.5)
const prodRound = {
  vote_round_id: 'LLpm6xbHWBoWkssLAzeF2gExBZ9kWg0vtNwqUTFQXgE=',
  snapshot_height: 3459350,
  vote_end_time: 1790712000,
  nullifier_imt_root: 'Ni6vFMWV1N90kyu8wYS1zV0YllkmaMLbp9zXusaF2gk=',
  nc_root: 'BgoT1255jEYLGlFJfmIfYankgrrh3vPKBu7LDYWl1B0=',
  status: 1,
  ea_pk: 'wRS3/XKonR3xOxttb2zir4omb1zGmYuRWZzl+cHbIBs=',
  title: 'Coinholder Retroactive Grants Q3',
  proposals: Array.from({ length: 37 }, (_, i) => ({
    id: i + 1,
    title: `grant ${i + 1}`,
    // proto3 drops index 0 from the wire
    options: [{ label: 'Support' }, { index: 1, label: 'Oppose' }, { index: 2, label: 'Abstain' }],
  })),
};

const hex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

describe('fetchRounds', () => {
  test('keeps the keys casting needs and every proposal past 16', async () => {
    stubFetch(() => ({ rounds: [prodRound] }));
    const [round] = await fetchRounds(config);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/rounds');
    expect(round!.id).toBe(hex(prodRound.vote_round_id));
    expect(round!.eaPkHex).toBe(hex(prodRound.ea_pk));
    expect(round!.ncRootHex).toBe(hex(prodRound.nc_root));
    expect(round!.nullifierImtRootHex).toBe(hex(prodRound.nullifier_imt_root));
    expect(round!.proposals).toHaveLength(37);
    expect(round!.proposals[36]!.id).toBe(37);
  });

  test('option ids are the vote_decision index, with index 0 omitted', async () => {
    stubFetch(() => ({ rounds: [prodRound] }));
    const [round] = await fetchRounds(config);
    expect(round!.proposals[0]!.options).toEqual([
      { id: 0, label: 'Support' },
      { id: 1, label: 'Oppose' },
      { id: 2, label: 'Abstain' },
    ]);
  });

  test('a round still in its key ceremony has no ea_pk yet', async () => {
    const { ea_pk: _, ...pending } = prodRound;
    stubFetch(() => ({ rounds: [{ ...pending, status: 4 }] }));
    const [round] = await fetchRounds(config);
    expect(round!.eaPkHex).toBeUndefined();
    expect(round!.status).toBe('cancelled');
  });
});

describe('submissions hit the vote-sdk routes', () => {
  test('delegation goes to /delegate-vote', async () => {
    stubFetch(() => ({ code: 0 }));
    const res = await submitDelegation(config, '{"tx1_effects":"AQ=="}');
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/delegate-vote');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  test('a cast goes to /cast-vote', async () => {
    stubFetch(() => ({ code: 0 }));
    const res = await castVote(config, '{}');
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/cast-vote');
  });

  test('a share goes to the helper on that server', async () => {
    stubFetch(() => ({ status: 'queued' }));
    const res = await submitShare('https://vote.example/', '{}');
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://vote.example/shielded-vote/v1/shares');
  });

  test('a refused share reports the helper error', async () => {
    stubFetch(() => ({ error: 'vote_round_id is required' }), 400);
    const res = await submitShare('https://vote.example', '{}');
    expect(res).toEqual({ ok: false, status: 400, message: 'vote_round_id is required' });
  });
});
