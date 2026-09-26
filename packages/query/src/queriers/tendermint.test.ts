/**
 * The tip height is cached, because it is on the wallet's hot path.
 *
 * The view service asks for the tip on every `Balances`/`Status` call (price
 * relevance, sync progress), so a connected dapp polling balances turned each
 * poll into a GetStatus round trip inside the service worker - the reported
 * "workers looping on getStatus, nothing happening", where the wallet's own RPCs
 * queued behind the polling. The tip moves every few seconds; a short TTL keeps
 * the value fresh enough for its uses (caught-up checks, price thresholds, sync
 * labels) while taking the round trip off the hot path.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import { TendermintProxyService } from '@penumbra-zone/protobuf';
import { GetStatusResponse } from '@penumbra-zone/protobuf/penumbra/util/tendermint_proxy/v1/tendermint_proxy_pb';
import { TendermintQuerier } from './tendermint';

const querierWith = (getStatus: () => Promise<GetStatusResponse> | GetStatusResponse) => {
  const transport = createRouterTransport(router => {
    router.service(TendermintProxyService, { getStatus });
  });
  return new TendermintQuerier({ grpcEndpoint: 'https://unused.example', transport });
};

describe('TendermintQuerier.latestBlockHeight', () => {
  it('reuses the tip within the TTL instead of asking again', async () => {
    const getStatus = vi.fn(() => new GetStatusResponse({ syncInfo: { latestBlockHeight: 800n } }));
    const querier = querierWith(getStatus);

    await expect(querier.latestBlockHeight()).resolves.toBe(800n);
    await expect(querier.latestBlockHeight()).resolves.toBe(800n);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('asks again once the TTL has passed', async () => {
    vi.useFakeTimers();
    try {
      const getStatus = vi.fn(
        () => new GetStatusResponse({ syncInfo: { latestBlockHeight: 800n } }),
      );
      const querier = querierWith(getStatus);

      await querier.latestBlockHeight();
      await vi.advanceTimersByTimeAsync(11_000);
      await querier.latestBlockHeight();

      expect(getStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one round trip between concurrent callers', async () => {
    const getStatus = vi.fn(() => new GetStatusResponse({ syncInfo: { latestBlockHeight: 800n } }));
    const querier = querierWith(getStatus);

    await expect(
      Promise.all([querier.latestBlockHeight(), querier.latestBlockHeight()]),
    ).resolves.toEqual([800n, 800n]);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so the next call retries', async () => {
    let calls = 0;
    const querier = querierWith(() => {
      calls++;
      if (calls === 1) {
        throw new Error('endpoint unreachable');
      }
      return new GetStatusResponse({ syncInfo: { latestBlockHeight: 900n } });
    });

    await expect(querier.latestBlockHeight()).resolves.toBeUndefined();
    await expect(querier.latestBlockHeight()).resolves.toBe(900n);
    expect(calls).toBe(2);
  });
});
