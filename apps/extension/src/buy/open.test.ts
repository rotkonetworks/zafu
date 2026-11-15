import { afterEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
const load = async (beta: boolean) => {
  vi.resetModules();
  vi.doMock('../config/beta', () => ({ betaFeatures: () => beta }));
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => `chrome-extension://zafu/${p}` },
    tabs: { create: (o: { url: string }) => (opened.push(o.url), Promise.resolve()) },
  });
  return import('./open');
};

describe('where a buy opens', () => {
  afterEach(() => {
    opened.length = 0;
    vi.unstubAllGlobals();
  });

  it('with beta features on, the in-wallet buy page', async () => {
    (await load(true)).openBuyPage();
    expect(opened).toEqual(['chrome-extension://zafu/buy.html']);
  });

  it("with them off, peer's zec buy page with zafu's referral", async () => {
    (await load(false)).openBuyPage();
    expect(opened).toEqual([
      'https://app.peer.xyz/buy/cashapp/usd/zcash/nep141%3Azec.omft.near?referralCode=UOW41E',
    ]);
  });
});
