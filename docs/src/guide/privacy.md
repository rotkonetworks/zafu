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
guarantees as trial decryption.

balance queries for light client networks are always permitted regardless of
privacy settings.

### tier 3: transparent (cosmos chains)

queries specific bech32 addresses against centralized RPC nodes. the RPC
operator can observe which addresses are being watched and correlate this
with the user's IP address and query timing.

balance queries, background sync, and transaction history for transparent
networks are controlled by the privacy toggles described below.

## privacy toggles

all toggles default to off (false). settings are persisted in local storage.

### cosmos balances (`enableTransparentBalances`)

- default: off
- when off: no balance queries are sent for cosmos/IBC networks. balances
  are not displayed.
- when on: queries RPC nodes for account balances on cosmos chains. the RPC
  node learns which bech32 addresses you control.
- scope: cosmos/IBC chains only (noble, cosmoshub). does not
  affect penumbra or zcash, which are always safe.
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
  a price for a given asset. this is relatively low risk compared to the
  other toggles.
- scope: all networks
- visible when: active network is penumbra or an IBC chain

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

### always sent

- DNS lookups for configured endpoints
- TLS handshakes with configured endpoints
- penumbra chain registry queries during onboarding (to discover RPC
  endpoints and numeraire denominations)

## leaky feature detection

the wallet tracks whether any metadata-leaking features are enabled. the
`hasLeakyFeatures()` function returns true if any of the following are on:

- `enableTransparentBalances`
- `enableTransactionHistory`
- `enableBackgroundSync`

note: `enablePriceFetching` is not included in the leaky features check
because price APIs do not receive address data.

## resetting to defaults

the privacy settings page provides a way to reset all toggles to their
default values (all off). this immediately stops all transparent network
queries.

## numeraire pricing

penumbra uses a separate privacy-preserving approach for asset pricing.
instead of querying third-party price APIs, zafu indexes asset prices
locally by a user-selected denomination (the numeraire). this is configured
during onboarding. prices are derived from on-chain DEX data that is
already downloaded as part of the normal sync process.
