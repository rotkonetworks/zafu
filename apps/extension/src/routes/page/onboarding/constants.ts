// A request-level timeout that supersedes the channel transport-level timeout to prevent hanging requests.
export const DEFAULT_TRANSPORT_OPTS = { timeoutMs: 5000 };

// Define a canonical default RPC.
export const DEFAULT_GRPC = 'https://penumbra.rotko.net';

// Define a canonical default frontend. Rotko runs its own minifront so the
// wallet does not depend on a third party staying up (or seeing our traffic).
export const DEFAULT_FRONTEND = 'https://dex.rotko.net';

// Define a canonical default landing page.
export const DEFAULT_LANDING_PAGE = 'https://zigner.zafu.pro';
