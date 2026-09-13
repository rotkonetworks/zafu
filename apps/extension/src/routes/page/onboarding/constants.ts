// A request-level timeout that supersedes the channel transport-level timeout to prevent hanging requests.
export const DEFAULT_TRANSPORT_OPTS = { timeoutMs: 5000 };

// Define a canonical default RPC.
export const DEFAULT_GRPC = 'https://penumbra.rotko.net';

// Define a canonical default frontend. Links straight to penumbra.fi rather
// than a self-hosted minifront (dex.rotko.net is retired). Note: penumbra.fi is
// a third party, so it sees the user's traffic/IP for Penumbra dapp use; the
// SOCKS proxy setting (privacy.settings.proxy) still routes it if enabled.
export const DEFAULT_FRONTEND = 'https://penumbra.fi';

// Define a canonical default landing page.
export const DEFAULT_LANDING_PAGE = 'https://zigner.zafu.pro';
