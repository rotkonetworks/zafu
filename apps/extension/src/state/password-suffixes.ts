/**
 * The suffixes password scheme v2 treats as public when it strips a leading
 * common label (see normalizeOrigin in identity.ts). Frozen: it is part of
 * the derivation, so changing it would change passwords people already use.
 * The rpId check uses the full public suffix list (public-suffix.ts) instead.
 */

/** second-level labels that country-code registries hand out to the public */
const CC_SECOND_LEVEL = new Set([
  'ac',
  'biz',
  'co',
  'com',
  'ed',
  'edu',
  'firm',
  'gen',
  'go',
  'gob',
  'gouv',
  'gov',
  'gr',
  'govt',
  'id',
  'ind',
  'info',
  'lg',
  'ltd',
  'me',
  'mil',
  'ne',
  'net',
  'nhs',
  'nic',
  'nom',
  'or',
  'org',
  'plc',
  'sch',
  'web',
]);

/** suffixes under which unrelated people publish their own pages */
const SHARED_HOSTING = new Set([
  'appspot.com',
  'azurestaticapps.net',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'codeberg.page',
  'deno.dev',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'gitlab.io',
  'glitch.me',
  'herokuapp.com',
  'ngrok.io',
  'ngrok-free.app',
  'netlify.app',
  'onrender.com',
  'pages.dev',
  'r2.dev',
  'railway.app',
  'replit.app',
  's3.amazonaws.com',
  'surge.sh',
  'translate.goog',
  'vercel.app',
  'web.app',
  'workers.dev',
]);

/** is `domain` (lowercase, no trailing dot) a public suffix by the list above? */
export const isPasswordSuffix = (domain: string): boolean => {
  const labels = domain.split('.');
  if (labels.length <= 1) {
    return true;
  }
  if (SHARED_HOSTING.has(domain)) {
    return true;
  }
  // `co.uk`, `com.au`: a known second level under a two-letter country code
  return labels.length === 2 && labels[1]!.length === 2 && CC_SECOND_LEVEL.has(labels[0]!);
};
