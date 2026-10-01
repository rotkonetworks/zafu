import { describe, expect, it } from 'vitest';
import { looksLikeLink, notYet, parseLink, SCREENS, toUri, type Intent } from './router';

const U = 'u1v9gaqrdva0example0address0only0alphanumerics';
const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
const memo = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const intent = (uri: string): Intent => {
  const r = parseLink(uri);
  if (!r.ok) {
    throw new Error(`refused: ${r.reason}`);
  }
  return r.intent;
};
const reason = (uri: string): string => {
  const r = parseLink(uri);
  if (r.ok) {
    throw new Error(`accepted: ${JSON.stringify(r.intent)}`);
  }
  return r.reason;
};

describe('pay (ZIP 321)', () => {
  it('reads a full single payment', () => {
    expect(
      intent(`zcash:${U}?amount=1.25&memo=${memo('thanks')}&label=caf%C3%A9&message=lunch`),
    ).toEqual({
      kind: 'pay',
      payments: [
        {
          address: U,
          amountZat: 125_000_000n,
          memo: 'thanks',
          label: 'caf\u00e9',
          message: 'lunch',
        },
      ],
    });
  });

  it('reads several payments, and says zafu pays one at a time', () => {
    const i = intent(`zcash:?address=${U}&amount=1&address.1=${T}&amount.1=2`);
    expect(i).toEqual({
      kind: 'pay',
      payments: [
        { address: U, amountZat: 100_000_000n },
        { address: T, amountZat: 200_000_000n },
      ],
    });
    expect(notYet(i)).toBe('this request pays 2 addresses · zafu pays one at a time, for now');
    expect(notYet(intent(`zcash:${U}`))).toBeUndefined();
  });

  it.each([
    ['more zec than exists', `zcash:${U}?amount=21000001`],
    ['a huge amount', `zcash:${U}?amount=${'9'.repeat(40)}`],
    ['too many decimals', `zcash:${U}?amount=1.000000001`],
    ['a negative amount', `zcash:${U}?amount=-1`],
    ['an exponent', `zcash:${U}?amount=1e308`],
    ['a memo to a transparent address', `zcash:${T}?memo=${memo('hi')}`],
    ['a percent-encoded address', `zcash:u1%41bc`],
    ['an address with markup', `zcash:?address=<script>`],
    ['a required unknown', `zcash:${U}?req-future=1`],
    ['a duplicate amount', `zcash:${U}?amount=1&amount=2`],
    ['a non-utf8 memo', `zcash:${U}?memo=_w`],
  ])('refuses %s', (_why, uri) => {
    expect(reason(uri)).toMatch(/^this link can't be read, sorry · /);
  });

  it('keeps script in a memo or label as plain text', () => {
    const i = intent(
      `zcash:${U}?memo=${memo('<script>alert(1)</script>')}&label=%3Cimg%20onerror%3Dx%3E`,
    );
    expect(i).toEqual({
      kind: 'pay',
      payments: [{ address: U, memo: '<script>alert(1)</script>', label: '<img onerror=x>' }],
    });
  });

  it.each([
    ['a bidi override in the label', `zcash:${U}?label=pay%E2%80%AEevil`],
    ['a zero-width space in the message', `zcash:${U}?message=a%E2%80%8Bb`],
    ['a control character in the label', `zcash:${U}?label=a%07b`],
    ['a bidi isolate in the memo', `zcash:${U}?memo=${memo('ok\u2067x')}`],
    ['a raw bidi override in the link', `zcash:${U}?amount=1\u202e`],
  ])('refuses %s', (_why, uri) => {
    expect(reason(uri)).toMatch(/hidden characters/);
  });

  it('lets a memo keep its line breaks and emoji joiners', () => {
    const text = 'line one\nline two \u{1f469}\u200d\u{1f4bb}';
    expect(intent(`zcash:${U}?memo=${memo(text)}`)).toEqual({
      kind: 'pay',
      payments: [{ address: U, memo: text }],
    });
  });

  it('round-trips through toUri, one payment and several', () => {
    for (const uri of [
      `zcash:${U}?amount=1.5&memo=${memo('hi there')}&label=a%20b&message=c`,
      `zcash:${U}?amount=1&address.1=${T}&amount.1=0.0001&label.1=x`,
      `zcash:${T}`,
    ]) {
      const i = intent(uri);
      expect(intent(toUri(i))).toEqual(i);
    }
  });
});

describe('swap', () => {
  it('reads into zec, with the payer refund address', () => {
    expect(intent('zafu:swap?into=zec&from=eth&amount=1&refund=0xAbC123def456')).toEqual({
      kind: 'swap',
      swap: { direction: 'into_zec', token: 'eth', amount: '1', address: '0xAbC123def456' },
    });
  });

  it('reads from zec, with the destination', () => {
    expect(intent('zafu:swap?from=zec&to=BTC&dest=bc1qexampleaddr&chain=btc')).toEqual({
      kind: 'swap',
      swap: { direction: 'from_zec', token: 'btc', chain: 'btc', address: 'bc1qexampleaddr' },
    });
  });

  it('needs no amount or address', () => {
    expect(intent('zafu:swap?from=zec&to=usdc')).toEqual({
      kind: 'swap',
      swap: { direction: 'from_zec', token: 'usdc' },
    });
  });

  it.each([
    ['zec on both sides', 'zafu:swap?from=zec&to=zec', /pairs zec/],
    ['no zec', 'zafu:swap?from=eth&to=btc', /pairs zec/],
    ['no token', 'zafu:swap?to=zec', /pairs zec/],
    ['a token with markup', 'zafu:swap?from=zec&to=%3Cb%3E', /pairs zec/],
    ['a dest when buying zec', 'zafu:swap?from=eth&to=zec&dest=0xabc123', /own wallet/],
    ['a refund when selling zec', 'zafu:swap?from=zec&to=btc&refund=bc1qxyz', /own wallet/],
    ['an address with spaces', 'zafu:swap?from=zec&to=btc&dest=bc1q%20xyz', /address/],
    ['an address with markup', 'zafu:swap?from=zec&to=btc&dest=%3Cscript%3E', /address/],
    ['a very long address', `zafu:swap?from=zec&to=btc&dest=${'a'.repeat(200)}`, /address/],
    ['a cyrillic lookalike address', 'zafu:swap?from=zec&to=eth&dest=0x%D0%B0bc123', /address/],
    ['a huge amount', `zafu:swap?from=eth&to=zec&amount=${'9'.repeat(30)}`, /amount/],
    ['a zero amount', 'zafu:swap?from=eth&to=zec&amount=0.000', /amount/],
    ['a negative amount', 'zafu:swap?from=eth&to=zec&amount=-1', /amount/],
    ['an exponent amount', 'zafu:swap?from=eth&to=zec&amount=1e9', /amount/],
    ['more zec than exists', 'zafu:swap?from=zec&to=btc&amount=21000001', /amount/],
    ['nine zec decimals', 'zafu:swap?from=zec&to=btc&amount=0.000000001', /amount/],
    ['both to and into', 'zafu:swap?from=eth&to=zec&into=zec', /can't be read/],
    ['a duplicate param', 'zafu:swap?from=eth&from=btc&to=zec', /can't be read/],
    ['a required unknown', 'zafu:swap?from=eth&to=zec&req-sign=1', /doesn't know/],
    ['a path argument', 'zafu:swap/now?from=eth&to=zec', /can't be read/],
    ['a bad chain', 'zafu:swap?from=eth&to=zec&chain=e%20th', /can't be read/],
  ])('refuses %s', (_why, uri, why) => {
    expect(reason(uri)).toMatch(why);
  });

  it('ignores unknown optional params, so a link can never ask to sign or send', () => {
    expect(intent('zafu:swap?from=eth&to=zec&autosign=1&confirm=true')).toEqual({
      kind: 'swap',
      swap: { direction: 'into_zec', token: 'eth' },
    });
  });

  it('round-trips through toUri', () => {
    for (const uri of [
      'zafu:swap?from=eth&to=zec&amount=1&refund=0xabc123',
      'zafu:swap?from=zec&to=btc&chain=btc&amount=0.5&dest=bc1qexampleaddr',
      'zafu:swap?from=zec&to=sol',
      'zafu:swap?from=btc&to=zec&chain=btc&amount=0.1&refund=bc1qexampleaddr&xc=thor',
      'zafu:swap?from=zec&to=usdc&xc=near',
    ]) {
      expect(toUri(intent(uri))).toBe(uri);
    }
  });

  it('reads xc as the one route to quote', () => {
    expect(intent('zafu:swap?from=btc&to=zec&xc=THOR')).toEqual({
      kind: 'swap',
      swap: { direction: 'into_zec', token: 'btc', route: 'thor' },
    });
    expect(intent('zafu:swap?from=zec&to=btc&xc=')).toEqual({
      kind: 'swap',
      swap: { direction: 'from_zec', token: 'btc' },
    });
    expect(reason('zafu:swap?from=zec&to=btc&xc=binance')).toMatch(/route zafu doesn't know/);
    expect(reason('zafu:swap?from=zec&to=btc&xc=near&xc=thor')).toMatch(/can't be read/);
  });

  it('reads a route that cannot carry the pair, and declines it calmly', () => {
    const later = (uri: string) => notYet(intent(uri));
    expect(later('zafu:swap?from=zec&to=btc&xc=penumbra')).toMatch(
      /penumbra's dex doesn't trade zec/,
    );
    expect(later('zafu:swap?from=eth&to=zec&xc=penumbra')).toMatch(/penumbra/);
    expect(later('zafu:swap?from=zec&to=sol&xc=thor')).toMatch(/thorchain doesn't trade sol/);
    expect(later('zafu:swap?from=usdc&to=zec&xc=thor')).toMatch(/contract call/);
    expect(later('zafu:swap?from=btc&to=zec&xc=thor')).toBeUndefined();
    expect(later('zafu:swap?from=zec&to=sol&xc=near')).toBeUndefined();
  });
});

describe('open a screen', () => {
  it('opens every whitelisted screen by name', () => {
    for (const [name, path] of Object.entries(SCREENS)) {
      const i = intent(`zafu:open/${name}`);
      expect(i).toEqual({ kind: 'screen', screen: name });
      expect(SCREENS[(i as { screen: keyof typeof SCREENS }).screen]).toBe(path);
      expect(toUri(i)).toBe(`zafu:open/${name}`);
    }
  });

  it.each([
    'zafu:open/../approval/tx',
    'zafu:open/%2e%2e/approval/tx',
    'zafu:open/settings/../../approval/tx',
    'zafu:open//settings',
    'zafu:open/approval/tx',
    'zafu:open/settings/recovery-passphrase',
    'zafu:open/SETTINGS',
    'zafu:open/settings/',
    'zafu:open/constructor',
    'zafu:open/__proto__',
    'zafu:open/hasOwnProperty',
    'zafu:open/receive\u0000',
    'zafu:open/rec\u200beive',
    'zafu:open/',
  ])('refuses %s', uri => {
    expect(parseLink(uri).ok).toBe(false);
  });
});

describe('contact and join', () => {
  const card = 'A'.repeat(43) + '_-9';

  it('reads a contact card after the #', () => {
    expect(intent(`zafu:contact#${card}`)).toEqual({ kind: 'contact', card });
    expect(intent(`https://zafu.pro/c#${card}`)).toEqual({ kind: 'contact', card });
    expect(toUri({ kind: 'contact', card })).toBe(`zafu:contact#${card}`);
  });

  it('reads a group code, in both forms', () => {
    expect(intent('zafu:join/673-chaos-mail')).toEqual({ kind: 'join', code: '673-chaos-mail' });
    expect(intent('https://zafu.pro/j#673-chaos-mail')).toEqual({
      kind: 'join',
      code: '673-chaos-mail',
    });
    expect(intent('https://www.zafu.pro/j/#673-chaos-mail')).toEqual({
      kind: 'join',
      code: '673-chaos-mail',
    });
    expect(toUri({ kind: 'join', code: '673-chaos-mail' })).toBe('zafu:join/673-chaos-mail');
  });

  it.each([
    'zafu:contact#short',
    'zafu:contact#has spaces in it here',
    `zafu:contact/x#${card}`,
    'zafu:join/673-chaos',
    'zafu:join/../../settings',
    'zafu:join/673-CHAOS-MAIL',
    'https://zafu.pro/j?code=673-chaos-mail',
    'https://zafu.pro.evil.example/j#673-chaos-mail',
    'https://evil.example/zafu.pro/j#673-chaos-mail',
    'http://zafu.pro/j#673-chaos-mail',
    'https://zafu.pro/x#673-chaos-mail',
  ])('refuses %s', uri => {
    expect(parseLink(uri).ok).toBe(false);
  });
});

describe('anything else', () => {
  it.each([
    ['an empty string', ''],
    ['plain text', 'hello'],
    ['a plain address', U],
    ['another scheme', 'javascript:alert(1)'],
    ['a data url', 'data:text/html,<script>alert(1)</script>'],
    ['an authority form', 'zafu://swap?from=eth&to=zec'],
    ['an unknown verb', 'zafu:sign?tx=00'],
    ['an uppercase verb', 'zafu:SWAP?from=eth&to=zec'],
    ['a verb with a dot', 'zafu:swap.x?from=eth&to=zec'],
    ['a fullwidth colon', 'zafu\uff1aswap?from=eth&to=zec'],
    ['a huge link', `zafu:swap?from=eth&to=zec&x=${'a'.repeat(5000)}`],
  ])('refuses %s, in one calm line', (_why, uri) => {
    const why = reason(uri);
    expect(why).not.toMatch(/[!\u2014]/);
    expect(why).toBe(why.toLowerCase());
  });

  it('trims surrounding whitespace and takes any scheme case', () => {
    expect(intent(`  ZCASH:${T}\n`)).toEqual({ kind: 'pay', payments: [{ address: T }] });
    expect(intent('ZAFU:open/receive')).toEqual({ kind: 'screen', screen: 'receive' });
  });

  it('knows what looks like a link', () => {
    expect(looksLikeLink(`zcash:${T}`)).toBe(true);
    expect(looksLikeLink(' zafu:open/receive')).toBe(true);
    expect(looksLikeLink('https://zafu.pro/j#673-chaos-mail')).toBe(true);
    expect(looksLikeLink(U)).toBe(false);
    expect(looksLikeLink('https://example.com')).toBe(false);
  });
});
