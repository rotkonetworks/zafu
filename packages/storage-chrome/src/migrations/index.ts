import { ExtensionStorageMigrations } from '../base';
import local_v0_v1 from './local-v0-v1';
import local_v1_v2 from './local-v1-v2';
import local_v2_v3 from './local-v2-v3';
import local_v3_v4 from './local-v3-v4';
import local_v4_v5 from './local-v4-v5';

import type { LocalStorageVersion } from '../local';

export const localMigrations: ExtensionStorageMigrations<LocalStorageVersion, 0 | 1 | 2 | 3 | 4> = {
  0: local_v0_v1,
  1: local_v1_v2,
  2: local_v2_v3,
  3: local_v3_v4,
  4: local_v4_v5,
} as const;
