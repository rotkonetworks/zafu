# networks

zafu organizes networks into three categories based on their privacy
properties: privacy networks, IBC/cosmos chains, and transparent networks.

only zcash and penumbra are currently launched and available for selection
during onboarding. the remaining networks are defined in the codebase but
not yet enabled in the UI.

## privacy networks

these networks use client-side trial decryption. the wallet downloads all
compact blocks and decrypts them locally with the viewing key. the RPC node
never learns which addresses or notes belong to the user.

### zcash

- symbol: ZEC
- decimals: 8
- pool: orchard (shielded)
- sync model: zidecar trustless sync - header chain proven via Ligerito
  polynomial commitments, nullifier set verified by NOMT merkle proofs.
  compact blocks are trial-decrypted locally.
- default endpoint: `https://zcash.rotko.net`
- orchard activation height: 1,687,104 - scanning never starts before this
- key derivation: ZIP-32 shielded derivation
- features: encrypted inbox (shielded memos)
- staking: no
- swaps: no

zcash sync downloads compact blocks from the orchard activation height (or
the wallet birthday height for imported wallets). each action in a compact
block is trial-decrypted against the incoming viewing key at approximately
3 microseconds per action. this is privacy-preserving - the RPC node sees
only that someone is downloading blocks, not which notes are relevant.

zafu uses a dedicated web worker (`zcash-worker.ts`) for zcash sync and
proving. the zcash WASM module is compiled from rust with wasm-bindgen and
rayon support for parallel proving.

FROST threshold multisig is supported for zcash. coordination happens via
shielded memos with no coordinator server.

### penumbra

- symbol: UM
- decimals: 6
- denomination: upenumbra
- sync model: compact blocks verified by state commitment tree,
  trial-decrypted locally - keys never leave the device
- default endpoint: `https://penumbra.rotko.net`
- chain ID: penumbra-1
- bech32 prefix: penumbra
- key derivation: penumbra-specific derivation
- features: staking, governance voting, encrypted inbox
- swaps: no (in zafu - the penumbra DEX is accessed via frontend dapps)

penumbra is a shielded DEX chain. all assets on penumbra are shielded by
default. zafu syncs by downloading all compact blocks and trial-decrypting
locally with the full viewing key. the RPC node never learns which notes
belong to the user.

penumbra supports staking (delegation to validators) and on-chain governance
voting directly from the wallet. asset swaps are performed through connected
frontend dapps like the penumbra DEX rather than built into zafu itself.

for fresh wallets, zafu fetches the compact frontier snapshot to bootstrap
the state commitment tree without downloading full chain history.

## IBC/cosmos chains

cosmos-sdk chains used primarily for IBC transfers into and out of penumbra.
these are transparent - queries send specific bech32 addresses to centralized
RPC nodes, which can observe address activity and correlate it with IP
addresses.

all cosmos chains use BIP44 secp256k1 key derivation with path
`m/44'/118'/0'/0/0` and chain-specific bech32 prefixes.

these networks are not yet launched in the UI.

### osmosis

- symbol: OSMO
- decimals: 6
- denomination: uosmo
- chain ID: osmosis-1
- bech32 prefix: osmo
- default RPC: `https://rpc.osmosis.zone`
- default LCD: `https://lcd.osmosis.zone`
- features: staking, swaps
- role: DEX and IBC routing hub

### noble

- symbol: USDC
- decimals: 6
- denomination: uusdc (native USDC issuance)
- chain ID: noble-1
- bech32 prefix: noble
- default RPC: `https://noble-rpc.polkachu.com`
- default LCD: `https://noble-api.polkachu.com`
- features: none (transfer only)
- role: native USDC issuance chain

### nomic

- symbol: nBTC
- decimals: 8 (satoshis)
- denomination: usat
- chain ID: nomic-stakenet-3
- bech32 prefix: nomic
- default RPC: `https://rpc.nomic.io`
- default REST: `https://app.nomic.io:8443` (relayer endpoint for deposits)
- features: none (transfer only)
- role: bitcoin bridge - deposit BTC, receive nBTC, transfer to penumbra
  via IBC for shielded bitcoin

the intended flow: BTC -> nomic (nBTC) -> penumbra (shielded nBTC).

### celestia

- symbol: TIA
- decimals: 6
- denomination: utia
- chain ID: celestia
- bech32 prefix: celestia
- default RPC: `https://celestia-rpc.polkachu.com`
- default LCD: `https://celestia-api.polkachu.com`
- features: staking
- role: data availability layer

## transparent networks

fully public ledgers. all balances and transactions are visible on-chain.
these networks are not yet launched in the UI.

### polkadot

- symbol: DOT
- decimals: 10
- SS58 prefix: 0
- default endpoint: `wss://rpc.polkadot.io`
- key derivation: sr25519 (default), ed25519, ledger_ed25519, ecdsa
- features: staking
- sync model: smoldot embedded light client - connects to the p2p network
  directly, verifies headers cryptographically. queries are distributed
  across peers rather than sent to a single RPC node.

polkadot supports multiple encryption types per network. sr25519 is the
default for hot wallets. ledger_ed25519 uses SLIP-10/BIP32-Ed25519
derivation matching the Ledger hardware wallet app, so users can add their
Ledger wallet to zigner and use it with zafu.

substrate parachains are supported under the polkadot umbrella with the same
key derivation but different SS58 prefixes and RPC endpoints. defined
parachains: hydration, acala, moonbeam, astar.

### kusama

- symbol: KSM
- decimals: 12
- SS58 prefix: 2
- default endpoint: `wss://kusama-rpc.polkadot.io`
- key derivation: sr25519 (default), ed25519, ledger_ed25519, ecdsa
- features: staking
- sync model: same as polkadot (smoldot light client)

kusama parachains: karura, moonriver.

### ethereum

- symbol: ETH
- decimals: 18
- chain ID: 1
- default endpoint: `https://eth.llamarpc.com`
- key derivation: secp256k1, path `m/44'/60'/0'/0/0`
- features: swaps

### bitcoin

- symbol: BTC
- decimals: 8
- default endpoint: `https://mempool.space`
- key derivation: BIP-84 native segwit, path `m/84'/0'/0'/0/0`
- features: none

## custom endpoints

all network endpoints can be changed in the settings. custom endpoints are
persisted in local storage independently of the default configuration.

## network selection in settings

networks can be enabled or disabled after onboarding through the settings
page. disabling a network that still has associated wallets is not permitted.
