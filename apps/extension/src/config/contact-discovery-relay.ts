/**
 * The private-contact-discovery relay the wallet uses when the user has opted
 * in but never named a relay of their own.
 *
 * A relay is a dumb key-value store keyed by `(appScope, epoch, shard)` holding
 * opaque tags and sealed blobs — `apps/minirelay` is the reference server, and
 * this host is the deployment of it rotko networks runs. The value is a BASE
 * URL only: the client appends `/bucket` (see packages/zid/src/relay-http.ts
 * for the two-route contract).
 *
 * A user who types their own endpoint in settings → privacy always wins over
 * this; the default exists so that opting in is enough to have working
 * discovery, and so an app that asks for it has something to enable.
 *
 * Why this host and not a `relay.*` name: the reference deployment is served on
 * the same vhost as the zcash light-client endpoints, and a default that does
 * not resolve is worse than no default at all — presence would be published
 * into the void with the UI claiming otherwise.
 */
export const DEFAULT_CONTACT_DISCOVERY_RELAY = 'https://zcash.rotko.net';
