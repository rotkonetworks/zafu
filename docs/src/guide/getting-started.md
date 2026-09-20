# getting started

zafu is a multi-chain privacy wallet for zcash and penumbra, distributed as a
chrome extension (manifest v3). it supports three onboarding paths: creating a
new wallet, importing an existing seed phrase, or connecting a zigner airgap
device. (a ledger path also exists but stays hidden behind a feature flag.)

## building from source

zafu is a pnpm monorepo. the extension lives in `apps/extension/`.

prerequisites:

- node.js (with `--max-old-space-size=8192` - set automatically by build scripts)
- pnpm 9.4+
- rust toolchain (for zcash wasm compilation in `packages/zcash-wasm/`)

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install
pnpm build
```

`pnpm build` runs turbo across the monorepo. it produces two extension builds:

- `apps/extension/dist/` - production build (`bundle:prod`)
- `apps/extension/beta-dist/` - beta/testnet build (`bundle:beta`)

for development with hot reload against testnet:

```sh
cd apps/extension
pnpm dev
```

this runs webpack in watch mode with `NODE_ENV=testnet` and inline source maps.

to load the unpacked extension in chromium, navigate to `chrome://extensions`,
enable developer mode, and load the `dist/` or `beta-dist/` directory.

other commands:

- `pnpm lint` - eslint
- `pnpm lint:strict` - typecheck + eslint with zero warnings
- `pnpm test` - vitest
- `pnpm clean` - remove `dist/`, `beta-dist/`, `bin/`

## onboarding

on first launch, zafu opens a full-page onboarding tab. there are three paths.
onboarding is deliberately minimal - there is no network-selection screen. a
fresh wallet defaults to zcash only; you enable more networks later in
settings > networks.

### create new wallet

generates a new 24-word BIP-39 seed phrase. 24 words are used for better
entropy and zcash compatibility. the phrase is generated client-side and
never leaves the device.

the phrase is displayed as a numbered grid; you must confirm you wrote it
down before continuing. the flow then proceeds directly to password creation.

### import seed phrase

enter an existing 12 or 24-word BIP-39 recovery phrase. you can paste the
full phrase into the first input box and the remaining fields fill
automatically. the phrase is validated before the continue button becomes
active.

after review, imported wallets go through a zcash wallet-birthday step
(described below) and then password creation.

### connect zigner (airgap)

zigner is zafu's companion airgap signing device. it keeps spending keys
offline and communicates with zafu via QR codes.

the zigner import flow:

1. open the zigner app on your phone and export the viewing key as a QR code
2. scan the QR code with your computer's camera (a separate keystone flow
   scans an animated `ur:zcash-accounts` QR for zcash)
3. zafu detects the network type automatically (penumbra, zcash, cosmos, or polkadot)
4. set an optional wallet label
5. choose to set a password or skip it

zigner wallets are watch-only. you can view balances and construct unsigned
transactions, but signing requires the zigner device. the extension stores
only the full viewing key (penumbra), unified/orchard full viewing key
(zcash), or public address (cosmos/polkadot).

zigner supports four network types:

- penumbra - imports the full viewing key and account index
- zcash - imports the orchard full viewing key or unified full viewing key
- cosmos - imports watch-only addresses for cosmos chains
- polkadot - imports the SS58 address and genesis hash

## zcash wallet birthday (imported wallets)

imported wallets pick a wallet birthday in a dedicated step before the
password screen. an estimate is enough - it only sets how far back the first
sync scans, not whether funds are safe. picking an earlier date only costs
scan time; picking one too late can hide older notes until a rescan. if you
don't remember, zafu scans from the orchard activation height (~may 2022),
which is safe but slower. freshly generated wallets skip this step and sync
from the chain tip.

## password

the password encrypts your wallet data in local storage. it is required to
unlock the extension after it locks.

when connecting via zigner, you can skip password creation. this means the
extension does not require login but is less secure - anyone with access to
your browser can open the wallet.

password requirements: the password and confirmation must match. only an
empty password is rejected; there is no longer-length minimum enforced by the
UI, but longer passwords are recommended.

## fresh wallet optimization

when creating a new wallet (not importing), zafu records the current penumbra
block height at the time of creation and fetches the penumbra compact frontier
snapshot from the RPC node. this bootstraps the penumbra state commitment tree
without downloading full chain history once penumbra is enabled. a freshly
generated zcash wallet simply syncs from the current chain tip, since there
cannot be any transactions for a newly generated key before that height.

## after onboarding

once onboarding completes, close the setup tab. the wallet is accessible from
the zafu icon in the browser toolbar. additional networks (penumbra, noble,
and others) can be enabled from settings > networks.
