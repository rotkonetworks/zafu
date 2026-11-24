import { describe, expect, it, vi } from 'vitest';

// the prod build: hyperliquid is beta-build only for now
vi.mock('./feature-flags', async orig => ({ ...(await orig<object>()), IS_BETA_BUILD: false }));

const { getTopLevelNetworks, liveNetworks } = await import('./networks');
const { compileEgress, describeEgress } = await import('../net/egress-policy');
const { decideEgress } = await import('../net/egress-table');

const INFO = 'https://api.hyperliquid.xyz/info';

describe('hyperliquid in the prod build', () => {
  it('is never listed, even with beta features on or after it was turned on', () => {
    expect(getTopLevelNetworks(true, [])).not.toContain('hyperliquid');
    expect(getTopLevelNetworks(true, ['hyperliquid'])).not.toContain('hyperliquid');
  });

  it('is dropped from a stored list, and an active hyperliquid falls back to the next network', () => {
    expect(liveNetworks(['zcash', 'hyperliquid'], 'hyperliquid')).toEqual({
      enabled: ['zcash'],
      active: 'zcash',
    });
    expect(liveNetworks(['zcash', 'nowhere'], 'zcash')).toEqual({
      enabled: ['zcash'],
      active: 'zcash',
    });
  });

  it('is never contacted, even when it is on and was allowed by hand', () => {
    const inputs = {
      enabledNetworks: ['zcash', 'hyperliquid'],
      netEgress: { optIns: { hyperliquid: 'allowed' as const } },
    };
    expect(decideEgress(INFO, 'popup', compileEgress(inputs)).allow).toBe(false);
    expect(describeEgress(inputs).map(d => d.id)).not.toContain('hyperliquid');
  });
});
