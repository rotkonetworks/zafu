<div align="center">

# Zafu

Multi-network browser extension for Penumbra, Zcash, Noble, Osmosis, and Celestia

Part of the [Zafu Zigner](https://zigner.rotko.net) ecosystem

</div>

## what is zafu

Zafu is a browser extension wallet forked from [Prax](https://github.com/prax-wallet/prax).
It acts as the hot wallet counterpart to [Zigner](https://github.com/rotkonetworks/zigner),
the air-gapped cold signer.

Zafu holds only viewing keys. it can build unsigned transactions and display
balances, but cannot sign without the air-gapped device. when used standalone
(without Zigner), it can also hold spending keys directly.

## supported networks

- **penumbra** - shielded transactions, DEX swaps, staking, IBC
- **zcash** - orchard shielded + transparent via PCZT
- **noble** - USDC transfers and IBC
- **osmosis** - swaps and liquidity
- **celestia** - data availability and staking

## how it works with zigner

1. zafu builds an unsigned transaction
2. displays it as a QR code
3. zigner (air-gapped phone) scans, reviews, signs
4. zafu scans the signed QR back and broadcasts

the only communication channel between hot and cold wallet is QR codes.
no bluetooth, wifi, or USB.

see [zigner.rotko.net](https://zigner.rotko.net) for setup instructions.

## wire formats

| chain | format | viewing key |
|-------|--------|-------------|
| penumbra | UR / CBOR | full viewing key (bech32m) |
| zcash | UR / PCZT / ZIP-316 | UFVK |
| substrate | UOS | public key |

## development

### prerequisites

- node.js 22+
- pnpm (via corepack)
- google chrome or chromium

or use nix: `nix develop`

### building

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install && pnpm dev
```

optionally launch a dedicated browser profile with the extension loaded:

```sh
CHROMIUM_PROFILE=chromium-profile pnpm dev
```

the extension build output is at `apps/extension/dist`. to manually load it:

1. go to `chrome://extensions`
2. enable developer mode
3. click "load unpacked" and select `apps/extension/dist`

### monorepo structure

```
apps/
  extension/          browser extension (chrome)
packages/
  context/            shared react context
  custody-chrome/     key custody in chrome storage
  encryption/         encryption utilities
  noble/              noble chain support
  query/              chain query layer
  storage-chrome/     chrome storage abstraction
  ui/                 shared UI components
  wallet/             wallet logic
  zcash-wasm/         zcash orchard derivation (WASM)
```

## upstream

forked from [prax-wallet/prax](https://github.com/prax-wallet/prax).
penumbra-specific packages from [@penumbra-zone/web](https://github.com/penumbra-zone/web).

## license

[MIT](LICENSE-MIT) / [Apache-2.0](LICENSE-APACHE)
