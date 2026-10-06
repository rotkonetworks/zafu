/**
 * The private-contact-discovery relay the wallet uses when the user has opted
 * in but never named a relay of their own.
 *
 * A relay is a dumb key-value store keyed by `(appScope, epoch, shard)` holding
 * opaque tags and sealed blobs - `apps/minirelay` is the reference server, and
 * this host is the deployment of it rotko networks runs. The value is a BASE
 * URL only: the client appends `/bucket` (see packages/zid/src/relay-http.ts
 * for the two-route contract).
 *
 * A user who types their own endpoint in settings → privacy always wins over
 * this; the default exists so that opting in is enough to have working
 * discovery, and so an app that asks for it has something to enable.
 *
 * relay.zafu.pro runs the reference minirelay (/bucket) beside frostd and
 * rendezvous, so discovery, zirc rooms and multisig share one relay host and
 * the zcash light-client container carries only zebrad and zidecar.
 */
export const DEFAULT_CONTACT_DISCOVERY_RELAY = 'https://relay.zafu.pro';

/**
 * What to persist when the user opts in. Blank is the stored spelling of "use
 * the built-in default", so the default host must never be written down as if
 * the user had chosen it: a pinned copy would outlive any later change to
 * DEFAULT_CONTACT_DISCOVERY_RELAY (a moved or retired host) and would keep
 * users pointing at it forever, with the UI claiming the wallet picked it.
 *
 * Settings pre-fills the input with the default precisely so that opting in is
 * one click, which means "the user left the pre-filled value alone" and "the
 * user typed this exact URL" are indistinguishable at save time - collapsing
 * the default to blank is the only behaviour that is right for both.
 */
export function relayEndpointForStorage(endpoint: string): string {
  const trimmed = endpoint.trim();
  return trimmed === DEFAULT_CONTACT_DISCOVERY_RELAY ? '' : trimmed;
}

/** true when `endpoint` is an http(s) URL the relay transport can talk to.
 *  Anything else (unset, garbage) leaves the feature unconfigured. */
export const isUsableRelayEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/** discovery is on unless the person turned it off: only an explicit false opts out */
export const discoveryOn = (stored?: { enabled?: boolean } | null): boolean =>
  stored?.enabled !== false;
