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

/**
 * Every wire-protocol major this wallet build supports, highest first, for
 * QUIC-style version negotiation over the ping handshake. Today just [1]; when
 * a v2 lands that can still serve v1 clients, this becomes [2, 1] while
 * ZAFU_PROTOCOL_VERSION (the highest) becomes 2. A client picks the highest
 * major it shares with this list.
 */
export const ZAFU_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [ZAFU_PROTOCOL_VERSION];
