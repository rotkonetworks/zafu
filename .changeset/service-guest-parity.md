---
'@zafu/service': minor
'@zafu/pq': minor
'@zafu/protocol': minor
'@zafu/zid': minor
'@zafu/media': minor
---

- **@zafu/service** (new): the services pattern from `docs/services-pattern.md`
  (Eriksen's "Your Server as a Function") as a shared, dependency-free module -
  `Service`, `Filter`/`ServiceFilter`, `StreamService`/`StreamFilter`,
  `compose`/`composeStream`, `identityFilter`, the `timeout`/`retry`/`trace`/`gate`
  filters with typed `TimeoutError`/`UnavailableError`, and `select`/`rescue`.
  Filters compose by `(Service) => Service`; `timeout` aborts the signal it passes
  downstream, so the deadline interrupts the work instead of only abandoning it.
- **@zafu/pq**: exposes `PQ_KEY_AUTH_DOMAIN` and `pqKeyAuthMessage`, which the
  prekey-authentication work added after the 0.1.0 publish. zid's advertised-key
  path imports it, so this is a hard dependency of the zid release below: an
  installed zid against the published pq 0.1.0 cannot even load.
- **@zafu/protocol**: `zafu_discover_contacts` (present intersection only, under
  app-scoped handles) and an additive `opts` argument on `ZafuTransport.request`.
- **@zafu/zid**: wallet-free parity. `zid.connect()` without a wallet now yields a
  guest identity with the same crypto surface as the wallet path - one in-page
  seed deriving the ed25519 identity plus an X-Wing (X25519 + ML-KEM-768) keypair,
  `keys()`/`sealFor()`/`openSealed()`, a hybrid channel, a local contact card,
  locally derived root secrets and `discover()` over the presence layer. In-memory
  by default; `persist: 'local'` is burner-grade custody, not a wallet. Also:
  `createHttpRelayTransport` (the blind presence relay's wire contract, whole-bucket
  reads only), and the service adapters `walletService`, `walletStrategy`,
  `channelService`, `sealingFilter`.
- **@zafu/media**: `callSignalService`, `serviceSignaling` and `signalingStrategy`,
  so call setup can ride any Service; no retry in the default strategy on purpose
  (replaying SDP/ICE can reorder a negotiation).
- **Behaviour change**: `zid.connect()`'s channel now defaults to the hybrid Noise
  handshake (post-quantum). A `@zafu/zid@0.1.0` peer speaks only the classical
  handshake and the hybrid one fails closed against it, so the choice is now
  explicit via `zid.connect({ channel })`: `'hybrid'` (default - never downgrades),
  `'classical'` (the legacy handshake, to reach a 0.1.0 peer), or `'auto'` (try
  hybrid, fall back to classical - a downgrade the caller accepts knowingly).
  There is no silent fallback and no implicit `'auto'`; `ZidChannel.kind` reports
  which handshake was actually used, so a caller can refuse a downgrade.
