/**
 * WebAuthn's rpId rule: a page may claim its own host or a registrable domain
 * above it, never a public suffix. Without the suffix check `a.github.io` could
 * claim `github.io` (and share that key with every other github.io site) and
 * any site could claim `com`. The full public suffix list, private section
 * included, is bundled with tldts: nothing is fetched.
 */
import { getPublicSuffix } from 'tldts';

/**
 * Gateways where strangers publish side by side that the list does not name:
 * every ENS name under eth.limo and eth.link, every IPFS site under dweb.link.
 */
const GATEWAYS = new Set(['eth.limo', 'eth.link', 'dweb.link']);

/** is `domain` (lowercase, no trailing dot) a public suffix? unknown counts as one */
export const isPublicSuffix = (domain: string): boolean => {
  const suffix = getPublicSuffix(domain, { allowPrivateDomains: true });
  return suffix === null || suffix === domain || GATEWAYS.has(domain);
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
