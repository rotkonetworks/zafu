<div align="center">

# zafu

**A privacy wallet for Zcash, with Penumbra and Cosmos alongside.**

Shielded by default. Keys stay on your device. Nothing is contacted until you need it.

[![Release](https://img.shields.io/github/v/release/rotkonetworks/zafu?label=release&color=6E56CF)](https://github.com/rotkonetworks/zafu/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/rotkonetworks/zafu/turbo-ci.yml?branch=main&label=CI)](https://github.com/rotkonetworks/zafu/actions/workflows/turbo-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[zafu.pro](https://zafu.pro) · [install](#install) · [getting started](#getting-started) · [docs](docs/src/README.md) · [zigner](https://github.com/rotkonetworks/zigner)

</div>

## what it is

zafu is a Chrome extension wallet. It syncs, decrypts and builds
transactions on your own computer; there is no zafu server in the path.

- **Zcash:** Orchard and Ironwood shielded send and receive, transparent
  addresses, shielding, pockets (separate accounts under one seed), paying
  Bitcoin, Ethereum, Solana or NEAR addresses through a swap, FROST
  multisig.
- **Penumbra:** shielded transfers, swaps, staking, voting, IBC.
- **Cosmos:** Noble, Osmosis, Cosmos Hub and Injective accounts.
- **Cold signing:** [Zigner](https://github.com/rotkonetworks/zigner) (an
  offline Android phone, over QR), Keystone, and Ledger. Spending keys stay on
  the device.
- **Identity:** sign in to sites with a key made for each site, no
  transaction needed ([how it works](docs/src/identity/sign-in.md)); passkeys.
- **Privacy:** only the servers of the networks you turned on are contacted;
  prices, directories and relays ask first. Optional proxy or Nym.

## install

- **Chrome Web Store:** [zafu](https://chromewebstore.google.com/detail/oojfeopgoeapfgcfhmlpfgabcbhkglck)
- **From a release:** download the zip from the
  [latest release](https://github.com/rotkonetworks/zafu/releases/latest),
  unzip it, open `chrome://extensions`, turn on developer mode, and choose
  **load unpacked**.

For cold signing, install [Zigner](https://github.com/rotkonetworks/zigner/releases/latest)
on a spare Android phone that stays offline.

## getting started

1. Open zafu from the toolbar and create a wallet, or import a 24-word phrase.
   Write the phrase down offline; zafu can't recover it for you.
2. Or add a cold signer instead: scan the code Zigner or Keystone shows, or
   connect a Ledger. zafu then holds only a viewing key.
3. Receive: show a shielded address (a fresh one each time) and send yourself
   a little to see it sync.
4. Send: review in zafu. A cold signer scans the request, you confirm on the
   device, and zafu broadcasts the signed result.

More in the [user guide](docs/src/guide/getting-started.md).

## security

| property                             | protected                                                    |
| ------------------------------------ | ------------------------------------------------------------ |
| sender, receiver, amount             | yes, by the shielded pools                                   |
| spending key on a browser compromise | yes with a cold signer; no for a hot wallet                  |
| what the node learns                 | which blocks you fetch; run your own node to avoid even that |
| a leaked seed                        | no forward secrecy; chain history is permanent               |

Details: [threat model](docs/src/security/threat-model.md),
[encryption at rest](docs/src/security/encryption.md).

## build from source

Node.js 22+, pnpm (via corepack), Chrome or Chromium. Or `nix develop`.

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install
pnpm dev     # build, watch and rebuild into apps/extension/dist
pnpm build   # prod (apps/extension/dist) and beta (apps/extension/beta-dist)
```

Releases: [RELEASING.md](RELEASING.md). Contributing: [AGENTS.md](AGENTS.md).

## upstream

Forked from [prax-wallet/prax](https://github.com/prax-wallet/prax); Penumbra
packages from [@penumbra-zone/web](https://github.com/penumbra-zone/web).

## license

[MIT](LICENSE)
