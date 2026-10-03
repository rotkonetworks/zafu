/**
 * Rescan penumbra from the active wallet's own start, as a plain service so
 * the settings screen holds no logic of its own.
 *
 * Reuses the existing network-scoped clear cache (see
 * message/listen/internal-services.ts): it stops the block processor, marks
 * the penumbra view databases for deletion at next startup, and reloads the
 * extension. No new teardown path.
 *
 * The one thing clearing the cache does NOT touch is `penumbraStarts` - the
 * per-wallet record of where its sync starts. A wallet whose start was
 * written as 'tip' (sync from now) keeps asking for 'tip' after a plain
 * clear, which would just skip the same history again. Before clearing, this
 * pins the active wallet's start to `{ since: 0 }` - the same "read the whole
 * chain" value turn-on and the wallet-services self-heal already use - so the
 * resync actually reads from the beginning.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../state';
import { getActiveWalletJson } from '../state/wallets';
import { startsOf, type PenumbraStart } from '../penumbra/start';

/** the wallet's real start: every block decrypted, nothing skipped */
const READ_FROM_START: PenumbraStart = { since: 0 };

/** the penumbra wallet in view, or undefined when none is active */
const activeWalletId = (): string | undefined => getActiveWalletJson(useStore.getState())?.id;

/**
 * Forget what penumbra has found for the active wallet and read the chain
 * again from its own start. Clears every penumbra wallet's view data on this
 * computer (the clear-cache mechanism is not scoped narrower than that) and
 * reloads the extension; resolves once the clear has been requested, not
 * once it finishes.
 */
export const resyncPenumbraFromStart = async (): Promise<void> => {
  const walletId = activeWalletId();
  if (walletId) {
    const starts = startsOf(await localExtStorage.get('penumbraStarts')) ?? {};
    await localExtStorage.set('penumbraStarts', { ...starts, [walletId]: READ_FROM_START });
  }
  try {
    await chrome.runtime.sendMessage({ type: 'ClearCache', network: 'penumbra' });
  } catch {
    // expected - the extension reloads before a response arrives
  }
};
