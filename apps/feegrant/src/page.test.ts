import { describe, expect, it } from 'vitest';
import { handleStats, renderPage, wantsHtml } from './page';
import type { NetworkStats, Stats } from './stats';

const net = (over: Partial<NetworkStats> = {}): NetworkStats => ({
  symbol: 'INJ',
  sponsor: 'inj1sponsor',
  addressUrl: 'https://injscan.com/account/inj1sponsor/',
  balance: '1.5',
  capacity: 900,
  today: 7,
  dailyCap: 200,
  records: [
    {
      time: '2026-11-01T10:00:00Z',
      txHash: 'ABCDEF0123456789ABCDEF',
      to: 'inj1<script>',
      amount: '0.001',
      url: 'https://injscan.com/transaction/ABCDEF0123456789ABCDEF/',
    },
  ],
  ...over,
});
const stats: Stats = { updatedAt: '2026-11-01T10:01:00Z', injective: net(), base: null };
const get = () => Promise.resolve(stats);

describe('wantsHtml', () => {
  it.each([
    ['text/html,application/xhtml+xml,*/*;q=0.8', 'curl/8', true],
    ['*/*', 'Mozilla/5.0', false],
    ['application/json', undefined, false],
    [undefined, 'curl/8.5.0', false],
    [undefined, 'Wget/1.21', false],
    [undefined, undefined, false],
    [undefined, 'Mozilla/5.0 (X11)', true],
  ])('accept=%s ua=%s -> %s', (accept, ua, want) => {
    expect(wantsHtml(accept, ua)).toBe(want);
  });
});

describe('handleStats', () => {
  it('serves html to a browser, with Vary', async () => {
    const r = await handleStats(get, { accept: 'text/html' }, false);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['vary']).toBe('Accept, User-Agent');
    expect(r.body).toContain('enough for about 900 more people');
  });
  it('serves json to curl and to header-less tools', async () => {
    for (const h of [{ accept: '*/*' }, { 'user-agent': 'curl/8' }, {}]) {
      const r = await handleStats(get, h, false);
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['vary']).toBe('Accept, User-Agent');
      expect(JSON.parse(r.body)).toEqual(stats);
    }
  });
  it('/v1/stats is json even for a browser', async () => {
    const r = await handleStats(get, { accept: 'text/html' }, true);
    expect(r.headers['content-type']).toBe('application/json');
  });
});

describe('renderPage', () => {
  it('escapes chain data and shows each network once configured', () => {
    const html = renderPage({ ...stats, base: net({ symbol: 'ETH', sponsor: '0xbase' }) });
    expect(html).not.toContain('inj1<script>');
    expect(html).toContain('inj1&#60;script&#62;');
    expect(html).toContain('data-copy="0xbase"');
    expect(html).toContain('7 of 200');
  });
  it('gives each network a tab and a donation qr, and drops base when unset', () => {
    const both = renderPage({ ...stats, base: net({ symbol: 'ETH', sponsor: '0xbase' }) });
    expect(both.match(/class="qr"/g)).toHaveLength(2);
    expect(both).toContain('for="t-base"');
    const injOnly = renderPage({ ...stats, base: null });
    expect(injOnly.match(/class="qr"/g)).toHaveLength(1);
    expect(injOnly).not.toContain('id="t-base"');
  });
  it('says so when the chain could not be read', () => {
    const html = renderPage({ ...stats, injective: net({ balance: null, capacity: null }) });
    expect(html).toContain('not readable just now');
  });
});
