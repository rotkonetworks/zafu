# Store listing - zafu

Paste-ready content for the Chrome Web Store "Store listing" tab, for both
listings. Images are in `images/beta/` and `images/prod/`.

|                         | beta                                         | prod                                        |
| ----------------------- | -------------------------------------------- | ------------------------------------------- |
| Title (from manifest)   | `zafu beta - private zcash wallet`           | `zafu - private zcash wallet`               |
| Summary (from manifest) | see below                                    | same                                        |
| Store icon              | `images/beta/store-icon-128.png` (gold seal) | `images/prod/store-icon-128.png` (red seal) |

Title and summary come from the uploaded package and are not editable in the
dashboard. Summary (manifest `description`):

> shielded zcash and penumbra wallet. private chat, shared wallets, cold
> signing with zigner. your keys never leave your device.

## Description - beta

```
zafu is an open-source wallet for private money: Zcash and Penumbra, shielded by default.

BETA BUILD. This is the rolling test channel and updates often. For everyday use, install the stable "zafu - private zcash wallet" listing.

• Shielded by default. Your Zcash balance and sends stay in the shielded pool, with a fresh address for every sender. Penumbra transfers, staking and swaps are private too.
• Proofs on your computer. Notes are decrypted and transactions are proved in your browser; your keys and viewing keys never leave this device.
• Private chat. Message the people you know. Once you have each other's cards, messages travel free over an encrypted relay; anyone else gets a shielded memo on chain.
• Cold signing with zigner. Pair the zigner app on an offline phone and keep your spending keys off this computer. Every transaction is shown and signed on the phone, by QR code.
• Shared wallets. Hold Zcash together with FROST threshold signatures: any k of n can spend, no one can spend alone.
• Swaps and buying. Swap in and out of ZEC across NEAR Intents and THORChain, and buy ZEC with cash, with every fee shown before you confirm.
• One identity per site. Sites that ask get their own key, so nothing links you across them.
• Asks before it connects. zafu asks before it contacts a new server, and settings show who it talks to and why.

Open source: https://github.com/rotkonetworks/zafu
```

## Description - prod

```
zafu is an open-source wallet for private money: Zcash and Penumbra, shielded by default.

• Shielded by default. Your Zcash balance and sends stay in the shielded pool, with a fresh address for every sender. Penumbra transfers, staking and swaps are private too.
• Proofs on your computer. Notes are decrypted and transactions are proved in your browser; your keys and viewing keys never leave this device.
• Private chat. Message the people you know. Once you have each other's cards, messages travel free over an encrypted relay; anyone else gets a shielded memo on chain.
• Cold signing with zigner. Pair the zigner app on an offline phone and keep your spending keys off this computer. Every transaction is shown and signed on the phone, by QR code.
• Shared wallets. Hold Zcash together with FROST threshold signatures: any k of n can spend, no one can spend alone.
• Swaps and buying. Swap in and out of ZEC across NEAR Intents and THORChain, and buy ZEC with cash, with every fee shown before you confirm.
• One identity per site. Sites that ask get their own key, so nothing links you across them.
• Asks before it connects. zafu asks before it contacts a new server, and settings show who it talks to and why.

Open source: https://github.com/rotkonetworks/zafu
```

## Category

**Privacy & Security**

## Language

**English**

## Graphic assets

Same files in `images/beta/` and `images/prod/`; only the seal differs
(beta gold, prod red). All screenshots and tiles are 24-bit PNG, no alpha.

| Field                         | File                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Store icon (128x128)          | `store-icon-128.png` - 96px seal, 16px transparent margin                       |
| Screenshot 1 (1280x800)       | `1-welcome.png` - the welcome page                                              |
| Screenshot 2                  | `2-wallet.png` - "shielded by default": home and receive                        |
| Screenshot 3                  | `3-people.png` - "private chat": identity and people                            |
| Screenshot 4                  | `4-zigner.png` - "keys off this computer": zigner and tools                     |
| Screenshot 5                  | `5-privacy.png` - "asks before it connects": settings and the connection prompt |
| Small promo tile (440x280)    | `small-promo-440x280.png`                                                       |
| Marquee promo tile (1400x560) | `marquee-1400x560.png`                                                          |

Regenerate after a UI change (repo root, after a build):

```
node docs/cws-listing/tools/capture.cjs <unpacked build> docs/cws-listing/images/raw
python3 docs/cws-listing/tools/compose.py
```

The screens come from the real build on the public bip39 test vector
(`abandon ... art`, no funds).

## URLs

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Official URL | `zafu.pro`                                     |
| Homepage URL | `https://zafu.pro`                             |
| Support URL  | `https://github.com/rotkonetworks/zafu/issues` |

## Mature content

**No.**

## Item support visibility

**On** - support goes to the GitHub issues URL above.
