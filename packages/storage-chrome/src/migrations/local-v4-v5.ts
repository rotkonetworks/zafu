import type * as FROM from '../versions/v4';
import type * as TO from '../versions/v5';
import { expectVersion, type Migration } from './util';

type MIGRATION = Migration<FROM.VERSION, FROM.LOCAL, TO.VERSION, TO.LOCAL>;

/**
 * v4 -> v5: split `privacySettings.enableBackgroundSync` in two.
 *
 * The one flag meant two things with two defaults: penumbra's "keep syncing
 * when closed" read it as `=== true`, while the background-sync alarm read it
 * as the transparent-chain switch with `!== false`, so an unset flag was off
 * in one place and on in the other, and turning penumbra's switch on also
 * turned on the transparent one.
 *
 * - `keepPenumbraSyncing` takes the flag exactly as the penumbra reader saw
 *   it (`=== true`). The only switch that wrote the flag was penumbra's.
 * - `transparentBackgroundSync` starts off (false): nothing in the ui ever
 *   asked for it on its own, and a true flag only ever meant penumbra's
 *   switch, so carrying it over would keep the very coupling this removes.
 *
 * `privacySettings` is passed through untouched unless it is a plain object
 * holding settings: a sealed `{ encrypted }` box (or anything else the
 * migration cannot read) is never opened, mapped or coerced.
 */
export default {
  version: v => expectVersion(v, 4, 5),
  transform: old => {
    const ps: unknown = old.privacySettings;
    if (!ps || typeof ps !== 'object' || Array.isArray(ps) || 'encrypted' in ps) {
      return old as unknown as TO.LOCAL;
    }
    const { enableBackgroundSync, ...rest } = ps as Record<string, unknown>;
    return {
      ...old,
      privacySettings: {
        ...rest,
        keepPenumbraSyncing: enableBackgroundSync === true || rest['keepPenumbraSyncing'] === true,
        transparentBackgroundSync: false,
      },
    } as unknown as TO.LOCAL;
  },
} satisfies MIGRATION;
