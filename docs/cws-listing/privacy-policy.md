# Privacy policy — zafu wallet

_Last updated: 2026-10-24_

zafu wallet ("zafu", "the extension") is an open-source, self-custodial
wallet for Zcash and Penumbra, distributed by rotko networks. This policy
describes what data the extension handles, where it goes, and why.

## Summary

- Your keys never leave your device.
- zafu sends no telemetry, analytics or crash reports.
- zafu asks before it contacts a server for the first time, and lists every
  server it talks to, and why, in settings.
- Some features send data off the device by their nature: a transaction to
  the network, a message to its recipient through a relay, a swap to the swap
  service, proof of a cash payment to Peer. Each is described below.

## Data stored on your device

Kept in your browser's extension storage, scoped to the extension:

- **Encrypted wallet vault** — your seed phrase and derived keys, encrypted
  with the password you choose.
- **Chain state** — Zcash notes with their merkle witnesses, the Penumbra view
  database, and your transaction history, derived from public chain data.
- **People and messages** — contacts and cards you save, and the messages you
  send and receive.
- **Passkeys and passwords** — derived from your seed phrase when a site asks,
  never stored. zafu keeps only an encrypted list of which sites have one, so
  it can offer it again.
- **Preferences** — networks, servers, connected sites, display settings,
  sync progress.

## Data that leaves your device

Only when you use the feature, and only to the server shown in settings:

- **Chain data** — zafu reads blocks and broadcasts your transactions through
  the Zcash light server (default `https://zcash.rotko.net`) and the Penumbra
  node (default `https://penumbra.rotko.net`) you choose; you can switch to
  another server or your own. Requests are by block range, not by address:
  decryption happens on your device, so the server does not learn which
  transactions are yours. A transaction you send is public to the network in
  the way the protocol defines (shielded transactions hide sender, recipient
  and amount).
- **Messages** — chat messages between people who hold each other's cards go
  through a relay (default `relay.zafu.pro`), encrypted end to end so the
  relay cannot read them. Other messages travel as encrypted memos inside a
  shielded transaction.
- **Swaps** — a swap sends the amounts and the addresses it needs to the swap
  service you pick (NEAR Intents `1click.chaindefuser.com`, THORChain nodes,
  Skip for IBC routes).
- **Buying ZEC with cash** — Peer's service receives your order. To confirm a
  cash payment, zafu opens your payment app in a tab, reads only the one
  request that lists the payment, and sends proof of that payment to Peer's
  verifier. Nothing from your payment app is stored.
- **Optional services** — only if you turn them on: contact discovery, the
  zcash.me directory, Zcash governance voting, penumbra registry updates, the
  nym mixnet, and the pro license check (your zafu identity public key, which
  is not linked to personal information).

No request contains your seed phrase, spending key or viewing key.

## Third parties

- **rotko networks** runs the default Zcash and Penumbra servers and the zafu
  relay. Like any HTTPS server they see the IP address of a request; rotko
  networks keeps only routine operational logs and does not link requests to
  people.
- **Other services** — alternative chain servers, NEAR Intents, THORChain,
  Skip and Peer have their own privacy policies, which apply to what you send
  them.

## Data use

Data on your device is used only to run the wallet: show balances, build and
sign transactions, send and show messages. zafu does not sell or transfer user
data, and does not use it for advertising, creditworthiness or any purpose
outside the wallet.

## Children

zafu is not directed at children under 13 and does not knowingly collect
information from them.

## Changes to this policy

Updates are committed to the extension's source repository with a new
"Last updated" date above.

## Contact

Questions or concerns: `hq@rotko.net`

Issue tracker: `https://github.com/rotkonetworks/zafu/issues`
