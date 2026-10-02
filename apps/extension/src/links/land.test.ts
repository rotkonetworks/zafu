import { describe, expect, it } from 'vitest';
import { PopupPath } from '../routes/popup/paths';
import { land, viaLine } from './land';
import { parseLink, SCREENS } from './router';

const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
const landOf = (uri: string, via?: string) => land(parseLink(uri), via);

describe('land', () => {
  it('opens send with the payment, for review', () => {
    expect(landOf(`zcash:${T}?amount=1`, 'https://shop.example')).toEqual({
      to: `${PopupPath.SEND}?to=${encodeURIComponent(`zcash:${T}?amount=1`)}&via=${encodeURIComponent('https://shop.example')}`,
    });
  });

  it('opens swap with the config in route state', () => {
    expect(landOf('zafu:swap?from=zec&to=btc&dest=bc1qexampleaddr', 'pasted')).toEqual({
      to: PopupPath.SWAP,
      state: {
        link: { direction: 'from_zec', token: 'btc', address: 'bc1qexampleaddr' },
        via: 'pasted',
      },
    });
  });

  it('opens the normal router for a route zafu does not offer', () => {
    expect(landOf('zafu:swap?from=btc&to=zec&xc=maya')).toEqual({
      to: PopupPath.SWAP,
      state: { link: { direction: 'into_zec', token: 'btc', route: 'maya' } },
    });
  });

  it('opens a whitelisted screen', () => {
    expect(landOf('zafu:open/settings/networks/penumbra')).toEqual({
      to: PopupPath.SETTINGS_PENUMBRA_NETWORK,
    });
  });

  it('opens a card to review, from the app and from the web, keeping where it came from', () => {
    const card = 'A'.repeat(32);
    expect(landOf(`zafu:contact#${card}`)).toEqual({
      to: `${PopupPath.CONTACT_CARD}?card=${card}`,
    });
    expect(land(parseLink(`https://zafu.pro/c#${card}`), 'scanned')).toEqual({
      to: `${PopupPath.CONTACT_CARD}?card=${card}&via=scanned`,
    });
  });

  it('answers what is not ready with one calm line', () => {
    expect(landOf('zafu:join/673-chaos-mail')).toEqual({
      line: 'groups are coming soon · please keep the code until then',
    });
    expect(landOf(`zcash:?address=${T}&address.1=${T}`)).toEqual({
      line: 'this request pays 2 addresses · zafu pays one at a time, for now',
    });
    expect(landOf('zafu:sign?tx=00')).toEqual({ line: "zafu doesn't know this kind of link yet" });
    expect(landOf('zafu:swap?from=zec&to=btc&xc=penumbra')).toEqual({
      line: "penumbra's dex doesn't trade zec · thorchain or near intents can, if you like",
    });
  });

  it('never lands on an approval, signing or settings-changing screen', () => {
    const targets = [
      `zcash:${T}`,
      'zafu:swap?from=eth&to=zec',
      ...Object.keys(SCREENS).map(k => `zafu:open/${k}`),
    ].map(u => landOf(u));
    for (const l of targets) {
      expect('to' in l && /approval|sign|passphrase|remove/.test(l.to)).toBe(false);
    }
  });
});

describe('viaLine', () => {
  it('names the site, or how the link arrived', () => {
    expect(viaLine('https://shop.example')).toBe('link from shop.example');
    expect(viaLine('http://localhost:8080')).toBe('link from localhost:8080');
    expect(viaLine('pasted')).toBe('link pasted');
    expect(viaLine('scanned')).toBe('link scanned');
    expect(viaLine('message')).toBe('link from a message');
  });

  it('says nothing for anything else', () => {
    expect(viaLine(undefined)).toBeUndefined();
    expect(viaLine('')).toBeUndefined();
    expect(viaLine('javascript:alert(1)')).toBeUndefined();
    expect(viaLine('chrome-extension://abc')).toBeUndefined();
    expect(viaLine('constructor')).toBeUndefined();
  });
});

describe('row actions land on one screen each', () => {
  it('send, unshield, swap and shield', async () => {
    const { land: l } = await import('./land');
    const { parseLink: parse } = await import('./router');
    expect(l(parse('zafu:send?asset=upenumbra'))).toEqual({
      to: '/send',
      state: { network: 'penumbra', prefillAsset: 'upenumbra' },
    });
    expect(l(parse('zafu:unshield?asset=upenumbra'))).toMatchObject({
      to: '/send',
      state: { penumbraMode: 'withdraw', prefillAsset: 'upenumbra' },
    });
    expect(l(parse('zafu:swap?asset=upenumbra'))).toEqual({
      to: '/swap',
      state: { prefillFromAsset: 'upenumbra' },
    });
    expect(l(parse('zafu:shield?chain=injective&index=2'))).toEqual({
      to: '/send',
      state: { cosmosChain: 'injective', cosmosAccountIndex: 2, cosmosIntent: 'shield' },
    });
    expect(l(parse('zafu:shield?chain=nowhere'))).toEqual({
      line: "zafu can't shield from that chain",
    });
  });
});
