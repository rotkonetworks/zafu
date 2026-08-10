/**
 * Resolves which pinned config source the voting UI should load from.
 *
 * Default: the hash-pinned, commit-locked `BUNDLED_PINNED_SOURCE` shipped
 * with the extension. Optionally overridden by a user-supplied source
 * persisted in `chrome.storage.local` under `votingConfigOverride` - a
 * last-resort escape hatch if a Chrome Web Store update can't ship in
 * time, and for pointing the voting UI at a local dev rig.
 *
 * The override is opt-in and surfaced with a warning in settings
 * (routes/popup/settings/settings-voting.tsx). It is the only thing that
 * relaxes the https-only / sha256-verified default path - see
 * `fetchStaticConfig` in ./api.ts for the exact scoping.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { BUNDLED_PINNED_SOURCE } from './types';
import type { PinnedConfigSource } from './types';

export const resolveVotingConfigSource = async (): Promise<PinnedConfigSource> => {
  const override = await localExtStorage.get('votingConfigOverride');
  if (override?.enabled && override.url.trim()) {
    return { url: override.url.trim(), sha256: override.sha256?.trim() || null };
  }
  return BUNDLED_PINNED_SOURCE;
};
