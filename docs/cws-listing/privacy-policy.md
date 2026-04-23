# Privacy policy — zafu wallet

_Last updated: 2026-04-23_

zafu wallet ("zafu", "the extension") is an open-source, self-custodial
cryptocurrency wallet distributed by rotko networks. This policy describes
what data the extension handles and what it does with it.

## Summary

- zafu collects no user data.
- zafu sends no telemetry, analytics, or crash reports.
- Wallet keys never leave the user's device.
- Network requests are made only to fetch public chain data.

## Data stored on your device

The extension stores the following data locally, in your browser's
extension storage. None of it is ever sent to rotko networks or any
third party:

- **Encrypted wallet vault** — your mnemonic seed phrase and derived
  private keys, encrypted with a password or passkey you choose.
- **Cached chain state** — Zcash note commitments with merkle
  witnesses, Penumbra view state, transaction history for your
  addresses. Derived from public chain data.
- **User preferences** — selected network, currency display,
  connected sites, address book entries you create, sync progress.

All of this stays within your browser's local storage and is scoped
to the extension's origin.

## Network requests

The extension makes requests to:

- **A Zcash light-server** (default: `https://zidecar.rotko.net`,
  user-configurable). Requests compact blocks, tree states, and
  commitment proofs. Requests are by block height range, not address;
  the server cannot infer which transactions belong to you because
  trial decryption happens locally.
- **A Penumbra gRPC-web endpoint** (default:
  `https://penumbra.rotko.net`, user-configurable). Requests
  block-level shielded data; again, decryption is local.
- **License server** (`https://zpro.rotko.net`) — if you subscribe to
  the pro tier. Your Zafu Identity (ZID) public key is sent to check
  license status. ZIDs are not linked to personal information.

No request contains your mnemonic, private key, or viewing key.

## Third-party services

- **rotko networks** operates the default light-server and Penumbra
  endpoint above. rotko networks sees the IP address of your requests
  (standard for any HTTPS endpoint). rotko networks does not log
  request contents beyond routine operational logging, and does not
  correlate requests to identities.
- **Zcash Foundation / Penumbra Labs** — alternative endpoints you
  can switch to in settings. Their privacy policies apply to
  requests sent to them.

## Data use

Your on-device data is used only to display balances, generate
transactions, and verify chain state within the extension. It is
never exported, sold, transferred, or used for any other purpose.

## Children

zafu is not directed at children under 13 and does not knowingly
collect information from them.

## Changes to this policy

Updates will be committed to the extension's source repository with
a new "Last updated" date above.

## Contact

Questions or concerns: `hq@rotko.net`

Issue tracker: `https://github.com/rotkonetworks/zafu/issues`
