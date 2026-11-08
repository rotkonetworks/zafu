import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '.';
import { readEncrypted, writeEncrypted } from './encrypted-storage';
import { DEFAULT_PRIVACY_SETTINGS } from './privacy';
import { exportSettings, importProxy } from './settings-backup';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
const PROXY = { kind: 'http', host: 'resi.example', port: 80, on: true };

describe('the proxy in the personal backup', () => {
  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  it('carries the proxy and its login, and keeps the login sealed at rest', async () => {
    await chrome.storage.local.set({ netProxy: PROXY });
    await writeEncrypted(localExtStorage, sessionExtStorage, 'netProxyLogin' as never, {
      username: 'u',
      password: 'secret-pass',
    });
    expect(JSON.stringify(localMock.get('netProxyLogin'))).not.toContain('secret-pass');
    const out = JSON.parse(
      JSON.stringify(await exportSettings(DEFAULT_PRIVACY_SETTINGS)),
    ) as Awaited<ReturnType<typeof exportSettings>>;
    expect(out.proxy).toEqual({ config: PROXY, login: { username: 'u', password: 'secret-pass' } });

    await chrome.storage.local.remove(['netProxy', 'netProxyLogin']);
    await importProxy(out.proxy);
    expect((await chrome.storage.local.get('netProxy'))['netProxy']).toEqual(PROXY);
    expect(
      await readEncrypted(localExtStorage, sessionExtStorage, 'netProxyLogin' as never),
    ).toEqual({ username: 'u', password: 'secret-pass' });
    expect(JSON.stringify(localMock.get('netProxyLogin'))).not.toContain('secret-pass');
  });

  it('ignores a proxy of a shape this build does not trust', async () => {
    await importProxy({ config: { ...PROXY, host: 'a"; DIRECT' } });
    expect(await chrome.storage.local.get('netProxy')).toEqual({});
  });
});
