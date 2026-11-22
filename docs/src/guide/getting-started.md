# getting started

zafu is a privacy wallet for zcash, with penumbra and cosmos chains on
request, distributed as a chrome extension (manifest v3).

## building from source

zafu is a pnpm monorepo. the extension lives in `apps/extension/`.

prerequisites:

- node.js (builds set `--max-old-space-size=8192` themselves)
- pnpm 9.4+
- rust toolchain (for the zcash wasm in `packages/zcash-wasm/`)

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install
pnpm build
```

`pnpm build` produces two extension builds:

- `apps/extension/dist/` - production
- `apps/extension/beta-dist/` - beta

`pnpm dev` in `apps/extension` rebuilds the beta in watch mode with inline
source maps. to load an unpacked build, open `chrome://extensions`, turn on
developer mode and load `dist/` or `beta-dist/`.

other commands: `pnpm lint`, `pnpm lint:strict` (typecheck plus lint),
`pnpm test` (vitest), `pnpm clean`.

## onboarding

on first launch zafu opens a full-page onboarding tab. there is no network
selection: a new wallet is zcash only, and more networks are turned on later
in settings > networks. onboarding contacts no server.

you start by creating a wallet or bringing one:

- **create** - a new 24-word recovery phrase
- **recovery phrase** - import 12 or 24 words
- **zigner or keystone** - scan the connect code of an air-gapped signer
- **ledger** - plug in over usb
- **viewing key** - watch only

### create

1. choose a password
2. zafu shows a new 24-word phrase, made on this device; write it down
3. zafu checks a few of the words

### import a recovery phrase

1. enter the phrase (pasting the whole phrase into the first box fills the
   rest)
2. choose a wallet birthday (see below)
3. choose a password

a 12-word phrase holds penumbra keys only; zcash needs 24 words.

### zigner or keystone

zigner is zafu's air-gapped android signer; keystone works the same way. the
signer keeps the spending keys and shows a connect code (a qr) with the
viewing key. zafu reads the code, recognises the device and the network from
it, and the wallet signs by qr from then on. zigner covers zcash and
penumbra.

you can set a password or continue without one. without a password, anyone
who opens your browser can open the wallet (it still cannot spend: the keys
are on the signer).

### ledger and viewing keys

a ledger holds transparent zcash and signs its payments over usb. a viewing key wallet can see its
transactions and balance but cannot spend.

## wallet birthday

an imported wallet (or a viewing key) asks when it was made. an estimate is
enough: it only decides how far back the first sync reads. an earlier date
costs scan time; a date too late can hide older notes until a rescan. "not
sure" starts at orchard activation (may 2022), which is safe but slower. a
wallet created in zafu starts at the chain tip.

## make it yours

one optional step before "wallet ready" offers a few settings: theme (sumi
or washi), whether to keep a transaction history, hide balances, auto-lock,
the zcash node, and whether to connect directly or over nym. skipping it
changes nothing; everything there is also in settings.

## after onboarding

close the setup tab and open zafu from the toolbar.

- receive shows a fresh shielded address each time you show or share one;
  all of them reach the same wallet.
- **pockets** are separate balances inside one wallet (zip 32 accounts),
  each with its own addresses; add them from the accounts sheet. nothing new
  to back up: they come from the same phrase.
- more networks (penumbra, cosmos chains) are in settings > networks.
