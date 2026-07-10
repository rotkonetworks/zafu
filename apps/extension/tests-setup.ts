import { runtime, storage } from '@repo/mock-chrome';
import { vi } from 'vitest';
import { installMockLocks } from '@repo/mock-chrome/mocks/navigator-locks';

vi.stubGlobal('chrome', { runtime, storage });
vi.stubGlobal('DEFAULT_GRPC_URL', 'https://rpc.example.com/');

installMockLocks();
