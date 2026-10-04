/**
 * registry.penumbra.fi mirrors github.com/penumbrafi/registry (same paths), so
 * fetching it never sends the user to GitHub. `just publish-live` there.
 */
export const REGISTRY_EGRESS = 'penumbra-registry';
export const LIVE_REGISTRY_DIR = 'https://registry.penumbra.fi/';
export const LIVE_REGISTRY_URL = `${LIVE_REGISTRY_DIR}registry/chains/penumbra-1.json`;
export const LIVE_REGISTRY_SIG_URL = `${LIVE_REGISTRY_DIR}signed/penumbra-1.json.sig`;
