# privacy

zafu operates in minimal-footprint mode by default. all privacy-relevant
toggles default to off for transparent networks. shielded networks (penumbra,
zcash) are always safe to sync because they use trial decryption - the RPC
node never learns which addresses or notes belong to the user.

## privacy tiers

zafu classifies networks into three privacy tiers that determine how queries
are handled:

### tier 1: shielded (penumbra, zcash)

trial decryption. the client downloads all compact blocks and decrypts them
locally with the viewing key. the RPC node sees only that someone is
downloading blocks. it cannot determine which notes, addresses, or
transactions belong to the user.

syncing and balance queries for shielded networks are always permitted
regardless of privacy settings. no toggle controls them because they do not
leak metadata.

### tier 2: light client (polkadot)

smoldot embedded light client. connects to the p2p network directly and
verifies block headers cryptographically. queries are distributed across
multiple peers rather than sent to a single centralized RPC node. this makes
correlation harder than a single RPC endpoint but does not provide the same
guarantees as trial decryption. (polkadot is not currently launched in the
UI, but the tier still governs how its queries would be handled.)

balance queries for light client networks are always permitted regardless of
privacy settings.

### tier 3: transparent (cosmos chains)

queries specific bech32 addresses against centralized RPC nodes. the RPC
operator can observe which addresses are being watched and correlate this
with the user's IP address and query timing.

balance queries, background sync, and transaction history for transparent
networks are controlled by the privacy toggles described below.

## privacy toggles

network toggles default to off (false). settings are persisted in local
storage.

### cosmos balances (`enableTransparentBalances`)

- default: off
- when off: no balance queries are sent for cosmos/IBC networks. balances
  are not displayed.
- when on: queries RPC nodes for account balances on cosmos chains. the RPC
  node learns which bech32 addresses you control.
- scope: cosmos/IBC chains only (noble, cosmoshub). does not affect penumbra
  or zcash, which are always safe. enabling an IBC chain in settings turns
  this on automatically.
- visible when: active network is an IBC chain or penumbra

### transaction history (`enableTransactionHistory`)

- default: off
- when off: no transaction history is fetched or stored
- when on: queries and stores transaction history locally
- scope: all networks
- visible when: always (for all networks)

### background sync (`enableBackgroundSync`)

- default: off
- when off: transparent network state is only synced when the extension
  popup is open
- when on: periodically syncs state with transparent networks in the
  background via the service worker
- scope: cosmos/IBC chains and transparent networks. penumbra and zcash
  background sync is always permitted because it uses trial decryption.
- visible when: active network is an IBC chain or penumbra

### price display (`enablePriceFetching`)

- default: off
- when off: no fiat price data is fetched. amounts are shown in native
  denominations only.
- when on: fetches prices from external APIs. these APIs do not receive
  your addresses or any wallet data - they only know that someone requested
  a price for a given asset (and see your IP). this is relatively low risk
  compared to the other toggles.
- scope: all networks
- visible when: active network is penumbra or an IBC chain

### explorer links (`enableExplorerLinks`)

- default: off
- when off: transaction rows are copy-only, nothing leaves the wallet
- when on: transaction rows link to a third-party block explorer, which
  sees your IP and which specific transaction you open
- scope: zcash only
- visible when: active network is zcash

## other privacy controls

these controls sit alongside the network toggles on the privacy settings page.

### zid identity (`enableIdentity`)

- default: on
- when on: the zid identity surface is available - menu display, sign
  approvals, per-site identity derivation, and e2ee messaging
- when off: the identity surface is hidden and external requests involving
  zid return "identity disabled" errors. this does not affect the underlying
  seed; the same zids re-derive if re-enabled.

### hide balances (`hideBalances`)

- default: off
- a display-privacy control for shoulder-surfing / screen-sharing. when on,
  balance figures are blurred and non-selectable across every screen. it does
  not change syncing, queries, or what is stored.

### SOCKS5 proxy (`proxy`)

- default: off (direct - IP visible to servers)
- when on, routes all extension network traffic (zidecar, license, relay, and
  RPC connections) through a SOCKS5 proxy via the `chrome.proxy` API, hiding
  your IP from every server. you supply the host and port; pro includes access
  to a rotko-hosted proxy.

### transaction signing (`txSigningSecurity`)

controls when the wallet asks for your password to approve a transaction. it
never changes the cryptography - while unlocked the session key already
authorizes signing; this only decides when the confirmation gate appears.

- foil hat: password + a 3s delay on every transaction (strictest)
- grace (15 min): password once, then skipped for 15 minutes - no delay
  (default)
- unlock only: no per-transaction password; relies on unlock + auto-lock

## what data leaves the device

### with all toggles off (default)

- penumbra: compact block requests to the configured gRPC endpoint.
  the endpoint sees your IP address and that you are syncing. it cannot
  determine your addresses or balances.
- zcash: compact block requests to the configured zidecar endpoint.
  same privacy properties as penumbra - trial decryption means the
  endpoint cannot determine your addresses.
- transparent networks: nothing. no queries are sent.

### with toggles on

- `enableTransparentBalances`: balance queries containing your bech32
  addresses are sent to cosmos RPC nodes
- `enableTransactionHistory`: transaction history queries are sent to
  relevant network endpoints
- `enableBackgroundSync`: the above queries happen periodically in the
  background, not just when the popup is open
- `enablePriceFetching`: price requests for asset symbols are sent to
  external price APIs. no address data is included.
- `enableExplorerLinks`: opening a link sends your IP and the transaction id
  to a third-party explorer

### always sent

- DNS lookups for configured endpoints
- TLS handshakes with configured endpoints
- penumbra chain registry queries during onboarding (to discover RPC
  endpoints and numeraire denominations)

## leaky feature detection

the wallet tracks whether any metadata-leaking network features are enabled.
the `hasLeakyFeatures()` function returns true if any of the following are on:

- `enableTransparentBalances`
- `enableTransactionHistory`
- `enableBackgroundSync`

note: `enablePriceFetching` is not included in the leaky features check
because price APIs do not receive address data. explorer links and the proxy
are also excluded from this check.

## resetting to defaults

the privacy settings page provides a way to reset all toggles to their
default values (network toggles off, proxy cleared). this immediately stops
all transparent network queries.

## numeraire pricing

penumbra uses a separate privacy-preserving approach for asset pricing.
instead of querying third-party price APIs, zafu indexes asset prices
locally by numeraire denominations. these are fetched from the penumbra
chain registry during onboarding and stored locally. prices are derived from
on-chain DEX data that is already downloaded as part of the normal sync
process.
