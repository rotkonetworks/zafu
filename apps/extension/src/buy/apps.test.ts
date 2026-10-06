import { describe, expect, it } from 'vitest';
import templates from './capture/templates.json';
import { PAY_APPS, appNote, defaultApp, localCurrency, type TemplateKey } from './apps';
import { templateHosts } from './capture/template';
import { compileEgress, describeEgress } from '../net/egress-policy';
import { decideEgress } from '../net/egress-table';
import { peerBuyUrl } from '../config/ramps';

describe('pay apps', () => {
  it('pins exactly the bundled templates', () => {
    const used = PAY_APPS.flatMap(a => a.templates).sort();
    expect(used).toEqual(Object.keys(templates).sort());
    const key: TemplateKey = 'revolut';
    expect(templates[key].actionType).toBe('transfer_revolut');
  });

  it("keeps every template's reads inside its app's hosts", () => {
    for (const app of PAY_APPS) {
      for (const t of app.templates) {
        for (const host of templateHosts(templates[t])) {
          expect(app.hosts).toContain(host);
        }
      }
    }
  });

  it('greys venmo, paypal and cash app, and monzo outside gbp', () => {
    expect(PAY_APPS.slice(0, 4).map(a => a.id)).toEqual(['revolut', 'wise', 'zelle', 'monzo']);
    expect(appNote(PAY_APPS.find(a => a.id === 'venmo')!, 'usd')).toBe('after your first buy');
    expect(appNote(PAY_APPS.find(a => a.id === 'monzo')!, 'usd')).toBe('gbp only');
    expect(appNote(PAY_APPS.find(a => a.id === 'monzo')!, 'gbp')).toBeUndefined();
  });

  it('remembers the last app when it takes the currency', () => {
    expect(defaultApp('usd', 'wise')?.id).toBe('wise');
    expect(defaultApp('usd', 'monzo')?.id).toBe('revolut');
    expect(defaultApp('gbp', 'monzo')?.id).toBe('monzo');
    expect(localCurrency('en-GB')).toBe('gbp');
    expect(localCurrency('de-DE')).toBe('eur');
    expect(localCurrency('en')).toBe('usd');
  });
});

describe('buy egress', () => {
  const at = (i: Parameters<typeof compileEgress>[0], url: string) =>
    decideEgress(url, 'page', compileEgress(i)).allow;
  const urls = [
    'https://api.zkp2p.xyz/v3/quote/exact-fiat',
    'https://attestation-service.zkp2p.xyz/attestation',
    'https://mainnet.base.org',
    'https://1click.chaindefuser.com/v0/quote',
    'https://sponsor.zafu.pro/base/gas',
    'https://app.revolut.com/api/retail/user/current/transactions/last?count=20',
  ];

  it('contacts none of peer, base, near or the sponsor by default', () => {
    for (const u of urls) {
      expect(at({ enabledNetworks: ['zcash'] }, u)).toBe(false);
    }
  });

  it('allows them once the ask-once sheet records the opt-ins', () => {
    const optIns = {
      peer: 'allowed',
      base: 'allowed',
      'near-swap': 'allowed',
      sponsor: 'allowed',
    } as const;
    for (const u of urls.slice(0, 5)) {
      expect(at({ enabledNetworks: ['zcash'], netEgress: { optIns } }, u)).toBe(true);
    }
    // the payment app stays off until its own tap
    expect(at({ enabledNetworks: ['zcash'], netEgress: { optIns } }, urls[5]!)).toBe(false);
    expect(
      at(
        {
          enabledNetworks: ['zcash'],
          netEgress: { optIns: { ...optIns, 'pay-revolut': 'allowed' } },
        },
        urls[5]!,
      ),
    ).toBe(true);
  });

  it('lists each one in everything zafu talks to, blockable', () => {
    const ids = describeEgress({ enabledNetworks: ['zcash'] }).map(d => d.id);
    expect(ids).toEqual(
      expect.arrayContaining(['peer', 'base', 'near-swap', 'sponsor', 'pay-revolut', 'pay-zelle']),
    );
  });
});

describe("peer's buy link", () => {
  it('carries only the redirect params peer reads', () => {
    const u = new URL(
      peerBuyUrl({ currency: 'eur', amount: '100', platform: 'revolut', recipient: '0xabc' }),
    );
    expect(u.pathname).toBe('/swap');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      inputCurrency: 'EUR',
      inputAmount: '100',
      paymentPlatform: 'revolut',
      toToken: '8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddress: '0xabc',
    });
    expect(new URL(peerBuyUrl({})).searchParams.has('recipientAddress')).toBe(false);
    expect(new URL(peerBuyUrl({})).searchParams.has('referrer')).toBe(false);
  });
});

describe('manifest permissions', () => {
  it('asks for capture access only as optional; the pay hosts ride on <all_urls>', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['public/manifest.json', 'public/beta-manifest.json']) {
      const m = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string[]>;
      // proxy waits for a per-destination transport to ask for it
      expect(m['optional_permissions']).toEqual(['webRequest', 'scripting', 'proxy']);
      expect(m['permissions']).not.toContain('proxy');
      expect(m['permissions']).not.toContain('webRequest');
      expect(m['permissions']).not.toContain('scripting');
      expect(m['permissions']).not.toContain('tabs');
      // listing them again as optional is redundant: Chrome warns and drops them
      expect(m['host_permissions']).toEqual(['<all_urls>']);
      expect(m['optional_host_permissions']).toBeUndefined();
      for (const h of PAY_APPS.flatMap(a => a.hosts)) {
        expect(h).toMatch(/^[a-z0-9.-]+$/);
      }
    }
  });
});
