import { vi } from 'vitest';
import { storage, runtime } from '@repo/mock-chrome';
import { installMockLocks } from '@repo/mock-chrome/mocks/navigator-locks';

vi.stubGlobal('chrome', { storage, runtime });

vi.stubGlobal('serviceWorker', true);

installMockLocks();
