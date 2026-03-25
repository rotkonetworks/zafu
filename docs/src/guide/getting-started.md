# getting started

zafu is a multi-chain privacy wallet for zcash and penumbra, distributed as a
chrome extension (manifest v3). it supports three onboarding paths: creating a
new wallet, importing an existing seed phrase, or connecting a zigner airgap
device.

## building from source

zafu is a pnpm monorepo. the extension lives in `apps/extension/`.

prerequisites:

- node.js (with `--max-old-space-size=8192` - set automatically by build scripts)
- pnpm 9.4+
- rust toolchain (for zcash wasm compilation in `packages/zcash-wasm/`)

```sh
git clone https://github.com/nicely-gg/zafu
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

### create new wallet

generates a new 24-word BIP-39 seed phrase. 24 words are used for better
entropy and zcash compatibility. the phrase is generated client-side and
never leaves the device.

after generation, the flow proceeds to network selection and then password
creation.

### import seed phrase

enter an existing 12 or 24-word BIP-39 recovery phrase. you can paste the
full phrase into the first input box and the remaining fields fill
automatically. the phrase is validated before the import button becomes
active.

after validation, the flow proceeds to network selection and then password
creation.

### connect zigner (airgap)

zigner is zafu's companion airgap signing device. it keeps spending keys
offline and communicates with zafu via QR codes.

the zigner import flow:

1. open the zigner app on your phone and export the viewing key as a QR code
2. scan the QR code with your computer's camera
3. zafu detects the network type automatically (penumbra, zcash, cosmos, or polkadot)
4. set an optional wallet label
5. choose to set a password or skip it

zigner wallets are watch-only. you can view balances and construct unsigned
transactions, but signing requires the zigner device. the extension stores
only the full viewing key (penumbra), unified full viewing key (zcash), or
public address (cosmos/polkadot).

zigner supports four network types:

- penumbra - imports the full viewing key and account index
- zcash - imports the orchard full viewing key or unified full viewing key
- cosmos - imports watch-only addresses for cosmos chains
- polkadot - imports the SS58 address and genesis hash

## network selection

after creating or importing a wallet (seed phrase path), you select which
networks to enable. only launched networks appear in the list. transparent
networks are labeled "public" to indicate their ledger is fully visible.

you must select at least one network. the first selected network becomes the
active network. network selection can be changed later in settings.

## password

the password encrypts your wallet data in local storage. it is required to
unlock the extension after it locks.

when connecting via zigner, you can skip password creation. this means the
extension does not require login but is less secure - anyone with access to
your browser can open the wallet.

password requirements: the password and confirmation must match. there is no
minimum length enforced by the UI, but longer passwords are recommended.

## fresh wallet optimization

when creating a new wallet (not importing), zafu records the current block
height at the time of creation. this allows the sync process to skip all
historical blocks before your wallet existed, since there cannot be any
transactions for a newly generated key before that height.

for penumbra, it also fetches the compact frontier snapshot from the RPC node
to bootstrap the state commitment tree without downloading the full chain
history.

## after onboarding

once onboarding completes, close the setup tab. the wallet is accessible from
the zafu icon in the browser toolbar.
