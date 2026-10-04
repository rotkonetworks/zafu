import { describe, expect, it } from 'vitest';
import templates from './templates.json';
import { PAY_APPS } from '../apps';
import {
  extractRows,
  isPaymentRequest,
  jsonPath,
  matchingRows,
  pinTemplate,
  replayOf,
  sessionMaterial,
  type Template,
} from './template';

const revolut = templates.revolut as Template;
const wise = templates.wise as Template;
const seen = (url: string, method = 'GET') => ({
  url,
  method,
  headers: [{ name: 'Cookie', value: 'sid=1' }],
});

describe('peer templates', () => {
  it('reads the jsonpath subset peer uses, nothing more', () => {
    const j = { a: [{ b: { c: 7 } }], x: 1 };
    expect(jsonPath('$', j)).toBe(j);
    expect(jsonPath('$.a[0].b.c', j)).toBe(7);
    expect(jsonPath('$.[0]', [5])).toBe(5);
    expect(jsonPath('$..c', j)).toBeUndefined();
    expect(jsonPath('$.a[?(@.b)]', j)).toBeUndefined();
  });

  it('watches the payment request and replays the metadata url', () => {
    const s = seen('https://app.revolut.com/api/retail/user/current/transactions/last?count=20');
    expect(isPaymentRequest(s, revolut)).toBe(true);
    expect(isPaymentRequest(seen('https://app.revolut.com/api/retail/user/current'), revolut)).toBe(
      false,
    );
    expect(replayOf(s, revolut).url).toBe(revolut.metadata.metadataUrl);
  });

  it('pulls rows and public params out of a wise response', () => {
    const body = JSON.stringify([
      {
        primaryAmount: '100 USD',
        resource: { id: 11 },
        title: 'maria k',
        visibleOn: 'x',
        currency: 'USD',
        ownedByProfile: 9,
      },
      {
        primaryAmount: '5 USD',
        resource: { id: 12 },
        title: 'bob',
        visibleOn: 'y',
        currency: 'USD',
        ownedByProfile: 9,
      },
    ]);
    const s = {
      ...seen('https://wise.com/gateway/v1/profiles/9/activities/list', 'POST'),
      body: '{}',
    };
    const rows = extractRows(wise, s, body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      amount: '100 USD',
      paymentId: 11,
      originalIndex: 0,
      hidden: false,
    });
    expect(rows[1]!.params).toEqual({ TRANSACTION_ID: '12', PROFILE_ID: '9' });
    expect(
      matchingRows(rows, { fiat: 100, currency: 'usd', handle: '@maria k' }).map(
        r => r.originalIndex,
      ),
    ).toEqual([0]);
  });

  it('matches minor-unit amounts and refuses a different recipient', () => {
    const body = JSON.stringify([
      {
        amount: -10000,
        currency: 'USD',
        recipient: { username: 'buymoretomorrow' },
        id: 'a',
        completedDate: 1,
        state: 'COMPLETED',
        type: 'TRANSFER',
      },
      {
        amount: -10000,
        currency: 'USD',
        recipient: { username: 'someoneelse' },
        id: 'b',
        completedDate: 1,
        state: 'COMPLETED',
        type: 'TRANSFER',
      },
    ]);
    const rows = extractRows(revolut, seen(revolut.metadata.metadataUrl!), body);
    expect(
      matchingRows(rows, { fiat: 100, currency: 'usd', handle: 'buymoretomorrow' }).map(
        r => r.paymentId,
      ),
    ).toEqual(['a']);
  });

  it('keeps the bundled template when a live one reaches past the pinned hosts', () => {
    const evil = {
      ...revolut,
      metadata: { ...revolut.metadata, metadataUrl: 'https://evil.example/steal' },
    };
    expect(pinTemplate(evil, revolut, ['app.revolut.com'])).toBe(revolut);
    const same = structuredClone(revolut);
    expect(pinTemplate(same, revolut, ['app.revolut.com'])).toBe(same);
    expect(pinTemplate({ success: false }, revolut, ['app.revolut.com'])).toBe(revolut);
  });

  it('refuses a live template whose urls only look pinned', () => {
    const hosts = ['app.revolut.com'];
    const withMeta = (metadataUrl: string) => ({
      ...revolut,
      metadata: { ...revolut.metadata, metadataUrl },
    });
    for (const bad of [
      '//evil.example/x', // protocol-relative: resolves to evil.example
      ' https://evil.example/x', // the old check never saw a host here
      '\thttps://app.revolut.com/x',
      'https://evil.example\\@app.revolut.com/x', // backslash reads as a path
      'https://app.revolut.com@evil.example/x',
      'https://app.revolut.com.evil.example/x',
      'https://app.revolut.com:8443/x',
      'http://app.revolut.com/x',
      'javascript:alert(1)',
      '/relative',
    ]) {
      expect(pinTemplate(withMeta(bad), revolut, hosts), bad).toBe(revolut);
    }
    // the open-a-tab link and the patterns are held to the same rule
    expect(pinTemplate({ ...revolut, authLink: '//evil.example/login' }, revolut, hosts)).toBe(
      revolut,
    );
    expect(
      pinTemplate(
        { ...revolut, metadata: { ...revolut.metadata, urlRegex: '.*' } },
        revolut,
        hosts,
      ),
    ).toBe(revolut);
    expect(
      pinTemplate(
        {
          ...revolut,
          metadata: { ...revolut.metadata, urlRegex: 'https://app.revolut.com/x|https://evil' },
        },
        revolut,
        hosts,
      ),
    ).toBe(revolut);
  });

  it('accepts every bundled template as its own live copy', () => {
    for (const app of PAY_APPS) {
      for (const key of app.templates) {
        const bundled = templates[key] as Template;
        const live = structuredClone(bundled);
        expect(pinTemplate(live, bundled, app.hosts), key).toBe(live);
      }
    }
  });

  it('seals every captured header and the body', () => {
    expect(sessionMaterial({ ...seen('https://x'), body: 'b' })).toEqual({
      Cookie: 'sid=1',
      body: 'b',
    });
  });
});
