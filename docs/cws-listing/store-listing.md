# Store listing — zafu wallet BETA

Paste-ready content for the CWS "Store listing" tab.

---

## Title

Set by manifest: `zafu wallet BETA`

## Summary

Set by manifest description (127 chars):
> Zcash + Penumbra privacy wallet. Cold signing, FROST multisig,
> client-side proving, ed25519 app identity, verified lightclient.

## Description (paste into dashboard)

```
zafu is an open-source privacy wallet for Zcash and Penumbra, built on a verified light-client architecture. Everything cryptographically sensitive — trial decryption, merkle witness maintenance, spend proving — runs client-side in your browser. No view key ever leaves your device.

BETA BUILD. This is the rolling development channel. Expect occasional UX rough edges; production users should install the stable "zafu wallet" listing instead.

Key features:

• Zcash shielded pool — send and receive in the orchard pool, per-note witnesses kept in sync as you browse
• Penumbra — shielded transfers, staking, and swaps with full client-side proving (under 15s on modern hardware)
• Air-gapped cold signing — pair with zigner (Android) for offline key custody; signs over QR codes, seed never touches the browser
• FROST 2-of-3 multisig — threshold signatures for shielded Zcash, no single point of compromise
• ed25519 app identity — sites opt-in to receive a per-site pubkey for login/signing; one keypair per domain, nothing cross-correlates
• Verified light-client — block headers and note commitment proofs are cross-checked against independent indexer proofs; no trusted server

Source: https://github.com/rotkonetworks/zafu
```

Length: 1,152 characters. Limit: 16,000.

## Category

**Productivity**

(Wallets generally land here on CWS; the alternative `Social &
Communication` doesn't fit and there's no "Finance" or "Crypto"
category.)

## Language

**English (United States)**

## Graphic assets (NOT scriptable — upload manually)

- **Store icon**: 128×128 PNG/JPEG. Use `apps/extension/public/favicon/icon128.png`.
- **Screenshots**: 1280×800 or 640×400, 24-bit PNG (no alpha), at
  least 1 required, up to 5. Capture from the running extension.
  Suggested shots:
  1. Wallet home (balance view, assets list)
  2. Send flow (amount + recipient)
  3. Receive (QR + address)
  4. Zigner cold-signing QR flow
  5. Settings / multi-network switcher
- **Small promo tile** (optional): 440×280
- **Marquee promo tile** (optional): 1400×560
- **YouTube promo video** (optional): link to a demo walkthrough

## URLs

| Field | Value |
|---|---|
| Official URL | None (unless you own + verify in Search Console) |
| Homepage URL | `https://zafu.rotko.net` |
| Support URL | `https://github.com/rotkonetworks/zafu/issues` |

If `zafu.rotko.net` isn't live yet, use
`https://github.com/rotkonetworks/zafu` as the homepage until the
site stands up.

## Mature content

**No.**

## Item support visibility

**On** — routes "Support" tab clicks to the GitHub issues URL above.
