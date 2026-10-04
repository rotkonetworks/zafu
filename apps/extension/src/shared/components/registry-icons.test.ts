import { describe, expect, it } from 'vitest';
import { resolveBundledIcon } from '@repo/ui/components/ui/asset-icon/bundled-icons';
import { installRegistryIcons } from './registry-icons';

installRegistryIcons();

describe('bundled registry icons', () => {
  it('a mirror url and its github url name the same bundled icon', () => {
    const gh =
      'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.png';
    const mirror =
      'https://registry.penumbra.fi/cosmos/chain-registry/master/osmosis/images/osmo.png';
    expect(resolveBundledIcon(gh)).toBeTruthy();
    expect(resolveBundledIcon(mirror)).toBe(resolveBundledIcon(gh));
  });

  it("the registry's own images resolve from the mirror too", () => {
    const own = 'https://registry.penumbra.fi/images/penumbra-favicon.png';
    expect(resolveBundledIcon(own)).toBe(
      resolveBundledIcon(
        'https://raw.githubusercontent.com/penumbrafi/registry/main/images/penumbra-favicon.png',
      ),
    );
    expect(resolveBundledIcon(own)).toBeTruthy();
  });

  it('an unknown url falls back to nothing', () => {
    expect(resolveBundledIcon('https://registry.penumbra.fi/images/nope.png')).toBeUndefined();
  });
});
