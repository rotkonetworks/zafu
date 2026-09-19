/**
 * ICS-20 timeout-height computation for IBC withdrawals.
 *
 * Separate from the slice so it stays free of store / `viewClient` imports and
 * can be unit tested directly. Also holds the counterparty-height query the
 * timeout is computed against.
 */

import { getIbcBlockTimeMs } from '../config/networks';

/**
 * How long the packet should stay live measured against the DESTINATION chain's
 * block height.
 *
 * ICS-20 carries two timeouts and whichever trips first wins. The timestamp
 * timeout is two days (privacy-rounded, below); the height timeout only needs to
 * be a backstop for a stalled relayer, so a couple of hours is ample while still
 * refunding promptly if the packet is never relayed.
 *
 * This used to be a flat `+1000` blocks, which is a Penumbra/Noble-rate figure:
 * on Injective's ~0.7s blocks it is barely twelve minutes, so a merely slow
 * relayer would push the packet past its height timeout and bounce the transfer.
 */
const TIMEOUT_HEIGHT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Never go below this many blocks regardless of the computed rate - protects
 * against a chain whose configured block time is wildly overstated.
 */
const MIN_TIMEOUT_BLOCKS = 1_000n;

/**
 * Block offset to add to the destination chain's current height so the packet
 * stays valid for {@link TIMEOUT_HEIGHT_WINDOW_MS}.
 */
export const timeoutBlocksForChain = (chainId: string): bigint => {
  const blockTimeMs = getIbcBlockTimeMs(chainId);
  const blocks = BigInt(Math.ceil(TIMEOUT_HEIGHT_WINDOW_MS / blockTimeMs));
  return blocks > MIN_TIMEOUT_BLOCKS ? blocks : MIN_TIMEOUT_BLOCKS;
};

/** REST endpoints for counterparty chains (for querying latest block height) */
const CHAIN_REST_ENDPOINTS: Record<string, string> = {
  'noble-1': 'https://noble-api.polkachu.com',
  'cosmoshub-4': 'https://cosmos-api.polkachu.com',
  // Injective has no polkachu LCD; this is the public sentry endpoint.
  'injective-1': 'https://sentry.lcd.injective.network',
};

/** query the latest block height on a counterparty cosmos chain */
export const getCounterpartyHeight = async (
  chainId: string,
): Promise<{ height: bigint; revisionNumber: bigint }> => {
  const restEndpoint = CHAIN_REST_ENDPOINTS[chainId];
  if (!restEndpoint) {
    throw new Error(`no REST endpoint for chain ${chainId}`);
  }

  const res = await fetch(`${restEndpoint}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  if (!res.ok) {
    throw new Error(`failed to query ${chainId} latest block: ${res.status}`);
  }

  const data = await res.json();
  const latestHeight = BigInt(data.block?.header?.height ?? data.sdk_block?.header?.height ?? '0');
  if (latestHeight === 0n) {
    throw new Error(`could not parse latest height for ${chainId}`);
  }

  // revision number from chain ID (e.g. "noble-1" -> 1, "osmosis-1" -> 1)
  const revMatch = /-(\d+)$/.exec(chainId);
  const revisionNumber = revMatch?.[1] ? BigInt(revMatch[1]) : 0n;

  return { height: latestHeight, revisionNumber };
};
