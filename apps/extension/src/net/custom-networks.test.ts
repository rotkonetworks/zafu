import { describe, expect, it } from 'vitest';
import {
  addCustomNetwork,
  customNetworkHosts,
  parseCustomNetworks,
  readCustomNetworks,
  removeCustomNetwork,
  type CustomNetwork,
} from './custom-networks';
import { compileEgress } from './egress-policy';
import { decideEgress } from './egress-table';
import { readNetEgress, setDestinationDecision } from './ledger';

/** Whether the policy lets zafu reach `host` with only the stored custom networks. */
const reachable = async (host: string) =>
  decideEgress(
    `https://${host}/status`,
    'popup',
    compileEgress({ customNetworks: await readCustomNetworks() }),
  ).allow;

/** Unique hosts per test: the ledger caches in module scope, so tests must not
 *  share a host or they would observe each other's records. */
let seq = 0;
const unique = (label: string) => {
  seq += 1;
  return `node-${label}-${seq}.example:9067`;
};

describe('parseCustomNetworks', () => {
  it('degrades a hand-edited value to the entries that parse', () => {
    expect(parseCustomNetworks(undefined)).toEqual([]);
    expect(parseCustomNetworks('nope')).toEqual([]);
    expect(
      parseCustomNetworks([
        { id: 'a', name: 'no rpc', chainId: 'x-1' },
        { id: 'b', name: 'ok', chainId: 'x-1', rpc: 'https://node.example' },
      ]),
    ).toEqual([
      {
        id: 'b',
        name: 'ok',
        chainId: 'x-1',
        rpc: 'https://node.example',
        addedAt: 0,
      } as CustomNetwork,
    ]);
  });
});

describe('customNetworkHosts', () => {
  it('covers rpc and rest, without repeating a shared host', () => {
    const base = { id: 'a', name: 'n', chainId: 'x-1', addedAt: 0 };
    expect(customNetworkHosts({ ...base, rpc: 'https://node.example:9067' })).toEqual([
      'node.example:9067',
    ]);
    expect(
      customNetworkHosts({
        ...base,
        rpc: 'https://node.example:9067',
        rest: 'https://node.example:9067/api',
      }),
    ).toEqual(['node.example:9067']);
  });
});

describe('addCustomNetwork', () => {
  it('keeps one endpoint per chain: a second entry replaces the first', async () => {
    const chainId = `replace-${Date.now()}`;
    const first = unique('first');
    const second = unique('second');
    await addCustomNetwork({ name: 'first', chainId, rpc: `https://${first}` });
    await addCustomNetwork({ name: 'second', chainId, rpc: `https://${second}` });

    const stored = (await readCustomNetworks()).filter(n => n.chainId === chainId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rpc).toBe(`https://${second}`);
    expect(stored[0]!.name).toBe('second');
  });

  it('makes the host a destination the user configured', async () => {
    const host = unique('trusted');
    const network = await addCustomNetwork({
      name: 'my node',
      chainId: `trust-${Date.now()}`,
      rpc: `https://${host}`,
    });

    expect(await reachable(host)).toBe(true);

    await removeCustomNetwork(network.id);
  });
});

describe('removeCustomNetwork', () => {
  it('forgets the destination it was the only reason to trust', async () => {
    const host = unique('forget');
    const network = await addCustomNetwork({
      name: 'my node',
      chainId: `forget-${Date.now()}`,
      rpc: `https://${host}`,
    });
    await setDestinationDecision(host, 'allowed', { label: network.name });
    expect((await readNetEgress()).destinations[host]).toBeDefined();

    await removeCustomNetwork(network.id);

    expect((await readNetEgress()).destinations[host]).toBeUndefined();
    expect(await reachable(host)).toBe(false);
    expect((await readCustomNetworks()).some(n => n.id === network.id)).toBe(false);
  });
});
