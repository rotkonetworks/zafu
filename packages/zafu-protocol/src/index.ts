/**
 * @zafu/protocol - the versioned, transport-agnostic contract between a zafu
 * wallet and a website SDK (@zafu/zid).
 *
 * ```typescript
 * import { ZAFU_PROTOCOL_VERSION, type ZafuTransport, type ZafuRequest } from '@zafu/protocol';
 * ```
 *
 * - version.ts  - the wire major, ZAFU_PROTOCOL_VERSION
 * - methods.ts  - the zafu_* request/response shapes + the v1 method registry
 * - transport.ts - the pluggable ZafuTransport seam
 */

export { ZAFU_PROTOCOL_VERSION } from './version';

export {
  ZAFU_V1_METHODS,
  isZafuError,
  type ZafuApi,
  type ZafuMethod,
  type ZafuRequest,
  type ZafuResponse,
  type ZafuError,
  type Hex,
  type Base64,
  type ZafuPingRequest,
  type ZafuPingResponse,
  type ZafuSignRequest,
  type ZafuSignResponse,
  type ZafuZidPubkeyRequest,
  type ZafuZidPubkeyResponse,
  type ZafuCapability,
  type ZafuRequestCapabilityRequest,
  type ZafuRequestCapabilityResponse,
  type ZafuEncryptRequest,
  type ZafuEncryptResponse,
  type ZafuDecryptRequest,
  type ZafuDecryptResponse,
  type ZafuContact,
  type ZafuPickContactsRequest,
  type ZafuPickContactsResponse,
} from './methods';

export type { ZafuTransport, ZafuTransportCallOptions } from './transport';
