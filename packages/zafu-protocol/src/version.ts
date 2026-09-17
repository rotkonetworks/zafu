/**
 * @zafu/protocol - wire version of the zafu_* dapp API.
 *
 * A single integer major. The dapp-facing message surface (the zafu_*
 * request/response shapes and the set of methods in ZAFU_V1_METHODS) is the
 * contract between a zafu wallet and an SDK such as @zafu/zid. Bump this on ANY
 * breaking change to that surface: a request or response field changing shape,
 * a method being removed, or the meaning of a field changing. Purely additive,
 * backward-compatible changes (a new optional field, a brand-new method) do NOT
 * require a bump - a dapp can feature-detect those from the wallet's version.
 *
 * The wallet reports this over the discovery handshake (the `ping` response's
 * `protocolVersion`), so an SDK can refuse to talk to a wallet whose major it
 * does not understand.
 */
export const ZAFU_PROTOCOL_VERSION = 1;
