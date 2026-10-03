/**
 * WebAuthn's rpId rule: a page may claim its own host or a registrable domain
 * above it, never a public suffix. Without the suffix check `a.github.io` could
 * claim `github.io` (and share that key with every other github.io site) and
 * any site could claim `com`.
 *
 * This is a minimal public suffix list, not the full one: every single-label
 * name (a TLD), the common second-level registries under country codes
 * (`co.uk`, `com.au`, `ne.jp`, ...) and the shared-hosting suffixes most
 * likely to host strangers' pages side by side. A parent that is not listed
 * here but is a public suffix in the full list is still accepted; the full
 * list needs a dependency (tldts) and is the follow-up.
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
export const isPublicSuffix = (domain: string): boolean => {
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

/**
 * May a page on `origin` use `rpId`? Its own host, or a registrable domain
 * above it that is not a public suffix. `origin` must be the browser-attested
 * sender origin, never a caller-supplied field.
 */
export const rpIdMatchesOrigin = (rpId: string, origin: string): boolean => {
  if (!rpId || rpId !== rpId.toLowerCase() || rpId.endsWith('.')) {
    return false;
  }
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === rpId) {
    return true;
  }
  // an IP address has no parent domain to claim
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) {
    return false;
  }
  return host.endsWith('.' + rpId) && !isPublicSuffix(rpId);
};
