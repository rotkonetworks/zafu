import { afterEach, describe, expect, it, vi } from 'vitest';

type Change = Record<string, { newValue?: unknown }>;

/** the module as one build loads it, with `stored` in local storage */
const load = async (build: 'beta' | 'prod', stored?: boolean) => {
  vi.resetModules();
  vi.doMock('./feature-flags', () => ({ IS_BETA_BUILD: build === 'beta' }));
  vi.doMock('@repo/storage-chrome/local', () => ({
    localExtStorage: { get: async () => stored, set: vi.fn(async () => undefined) },
  }));
  const listeners: ((c: Change, area: string) => void)[] = [];
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: (l: never) => listeners.push(l) } },
  });
  const beta = await import('./beta');
  await Promise.resolve();
  return {
    ...beta,
    change: (v: unknown) => listeners.forEach(l => l({ betaFeatures: { newValue: v } }, 'local')),
  };
};

describe('beta features', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('default to the build: on in beta, off in prod', async () => {
    expect((await load('beta')).betaFeatures()).toBe(true);
    expect((await load('prod')).betaFeatures()).toBe(false);
  });

  it("the person's choice wins in either build", async () => {
    expect((await load('prod', true)).betaFeatures()).toBe(true);
    expect((await load('beta', false)).betaFeatures()).toBe(false);
  });

  it('follow a change made elsewhere (settings in another window)', async () => {
    const b = await load('prod');
    b.change(true);
    expect(b.betaFeatures()).toBe(true);
    b.change(undefined);
    expect(b.betaFeatures()).toBe(false);
  });
});
