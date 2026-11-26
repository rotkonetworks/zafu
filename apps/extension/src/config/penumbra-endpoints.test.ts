/**
 * One source of truth for the Penumbra endpoint.
 *
 * The node picker (Settings > Networks) writes `networkEndpoints.penumbra`; the
 * old gRPC form and onboarding wrote the legacy `grpcEndpoint` key. The service
 * worker's RPC proxy used to read the legacy key alone - built once, at startup
 * - so a picked node was ignored by every proxied RPC and an unset legacy key
 * left the router un-buildable (every wallet RPC, and the worker-driven send,
 * pending forever with no error). This pins the precedence that keeps the sync,
 * the UI and the proxy on the same node.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import { defaultPenumbraEndpoint, resolvePenumbraEndpoint } from './penumbra-endpoints';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

describe('resolvePenumbraEndpoint', () => {
  beforeEach(() => {
    localMock.clear();
  });

  it('prefers the node picked in Settings > Networks', async () => {
    await localExtStorage.set('networkEndpoints', { penumbra: 'https://picked.example' });
    await localExtStorage.set('grpcEndpoint', 'https://legacy.example');

    await expect(resolvePenumbraEndpoint()).resolves.toBe('https://picked.example');
  });

  it('falls back to the legacy key when no node was picked', async () => {
    await localExtStorage.set('grpcEndpoint', 'https://legacy.example');

    await expect(resolvePenumbraEndpoint()).resolves.toBe('https://legacy.example');
  });

  it('never waits for onboarding: an unset endpoint resolves to the shipped default', async () => {
    await expect(resolvePenumbraEndpoint()).resolves.toBe(defaultPenumbraEndpoint().url);
  });

  describe('while the testnet is on', () => {
    beforeEach(() => localExtStorage.set('enabledNetworks', ['penumbra', 'penumbra-testnet']));

    it("is the testnet's own node, never mainnet's", async () => {
      await localExtStorage.set('networkEndpoints', {
        penumbra: 'https://picked.example',
        'penumbra-testnet': 'http://127.0.0.1:38080',
      });
      await expect(resolvePenumbraEndpoint()).resolves.toBe('http://127.0.0.1:38080');
      await expect(resolvePenumbraEndpoint('penumbra')).resolves.toBe('https://picked.example');
    });

    it('with no node set it refuses rather than reach mainnet', async () => {
      await expect(resolvePenumbraEndpoint()).rejects.toThrow('penumbra testnet has no node yet');
    });

    it('refuses plain http to a node away from this computer, even one restored from a backup', async () => {
      await localExtStorage.set('networkEndpoints', {
        'penumbra-testnet': 'http://testnet.example',
      });
      await expect(resolvePenumbraEndpoint()).rejects.toThrow(
        'a node away from this computer needs https',
      );
    });
  });
});
