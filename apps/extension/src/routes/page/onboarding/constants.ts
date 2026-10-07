// Define a canonical default RPC.
export const DEFAULT_GRPC = 'https://penumbra.rotko.net';

// Define a canonical default landing page.
export const DEFAULT_LANDING_PAGE = 'https://zigner.zafu.pro';

// sessionStorage key the import birthday step stashes the chosen sync-start
// height under, read once by useFinalizeOnboarding after the wallet exists.
// One literal shared by the writer, the reader, and the set-password guard so
// they can never drift.
export const PENDING_ZCASH_BIRTHDAY_KEY = 'pendingZcashBirthday';
