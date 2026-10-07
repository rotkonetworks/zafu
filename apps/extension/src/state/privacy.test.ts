import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY_SETTINGS, fromStoredPrivacy } from './privacy';

// privacySettings as a v5 install stored it, before the three-way explorer choice
const v5Stored = {
  enableTransparentBalances: false,
  enableTransactionHistory: true,
  keepPenumbraSyncing: false,
  transparentBackgroundSync: false,
  enableIdentity: true,
  hideBalances: false,
  txSigningSecurity: 'grace',
};

const hydrate = (raw: unknown) => ({ ...DEFAULT_PRIVACY_SETTINGS, ...fromStoredPrivacy(raw) });

describe('stored privacy settings', () => {
  it('reads explorer links once on as open, and drops the old key', () => {
    const s = hydrate({ ...v5Stored, enableExplorerLinks: true });
    expect(s.explorerLinks).toBe('open');
    expect(s).not.toHaveProperty('enableExplorerLinks');
    expect(s.enableTransactionHistory).toBe(true);
  });

  it('reads explorer links off or never set as off', () => {
    expect(hydrate({ ...v5Stored, enableExplorerLinks: false }).explorerLinks).toBe('off');
    expect(hydrate(v5Stored).explorerLinks).toBe('off');
    expect(hydrate({ ...v5Stored, enableExplorerLinks: false })).not.toHaveProperty(
      'enableExplorerLinks',
    );
  });

  it('keeps a three-way choice already made, and drops one it does not know', () => {
    expect(hydrate({ explorerLinks: 'copy', enableExplorerLinks: true }).explorerLinks).toBe(
      'copy',
    );
    expect(hydrate({ explorerLinks: 'loud' }).explorerLinks).toBe('off');
  });

  it('reads a sealed box or nothing as nothing stored', () => {
    expect(fromStoredPrivacy({ encrypted: 'x' })).toEqual({});
    expect(fromStoredPrivacy(undefined)).toEqual({});
    expect(fromStoredPrivacy(['x'])).toEqual({});
  });
});
