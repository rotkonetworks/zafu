# threat model

zafu is a client wallet. the privacy of zcash and penumbra is a property of
those chains, not of zafu. zafu's job is to not weaken it through its own
choices, and to give you honest tools for your own operational privacy. this
page says what zafu defends against and, just as plainly, what it does not.

## custody modes

where your spending keys live decides most of your threat model.

- **paired with zigner** (recommended): spending keys stay on an offline phone
  running [zigner](zigner.md). zafu holds viewing keys only. the channel is QR
  codes, no bluetooth, usb or wifi. you check the destination on zigner's
  screen before signing.
- **hot wallet**: the seed is stored in the browser, sealed at rest with a
  password-derived key (see [encryption at rest](encryption.md)), and opened in
  memory when zafu signs. choose this only if you accept that a compromised
  browser can read it at that moment.

keystone and ledger devices sign the same way as zigner, on their own screens.
a viewing-key wallet has no signer at all and is never offered a send.

## what zafu protects

1. **network observers.** zcash orchard and ironwood and penumbra are shielded:
   amounts, sender, recipient and memo are hidden from the network. not every
   network is shielded: zcash transparent addresses and the cosmos chains
   (noble, osmosis and others) are public ledgers.
2. **light-client servers.** zafu fetches compact blocks, which are public chain
   data. the server never receives your viewing keys, balances or history;
   scanning happens on your computer. zcash chain data is checked with a
   flyclient proof before it is trusted.
3. **everyone else on the internet.** network access is default-deny: zafu
   contacts only the servers of networks you enabled. prices, directories,
   relays and swap routes stay off until you allow them, each on its own, and
   you can block any destination again (settings › privacy).
4. **a stolen computer while locked.** wallet data is sealed at rest with
   AES-256-GCM under a key derived from your password (PBKDF2-SHA512, 210,000
   iterations). the key lives only in session storage while unlocked.
5. **website tracking.** every site sees its own zid key, so sites cannot link
   you by comparing keys. see [sign in with zafu](../identity/sign-in.md).
6. **address comparison on zcash.** every time a shielded address is shown or
   copied it is a fresh, random one (88 random bits of diversifier), so no two
   senders are handed the same string. all of them reach the same wallet.
7. **a malicious multisig coordinator.** a FROST aggregator cannot produce a
   signature without `t` real shares, cannot replay a nonce commitment across
   sessions (each is bound to its session id and a deadline), and gains no
   extra power by coordinating. it can still refuse to forward messages or show
   different messages to different signers: those are liveness failures, not
   theft.
8. **a lost or compromised zigner.** the spending key is gone with it, but a
   spending key cannot read past shielded history any better than the chain
   already allows.

## what zafu does not protect against

1. **a compromised computer or browser.** malware, a malicious extension or a
   browser exploit can read memory and keystrokes. a hot wallet's seed is in
   memory while it signs; with zigner the spending key is not, but viewing keys
   are.
2. **a leaked viewing key.** for a privacy wallet, a viewing key is as sensitive
   as a spending key in a different way: it decrypts every shielded note sent to
   you, past and future. treat viewing keys as secrets, not as "watch-only".
3. **a leaked seed phrase.** every key derived from it (spending, viewing, zid)
   follows it.
4. **address substitution before the QR.** malware on the computer can swap the
   recipient before zafu draws the signing QR. the signer's own screen is the
   last trustworthy place to check the address.
5. **query metadata.** the light-client server learns when you sync and from
   which ip. flyclient proofs catch fabricated chain data but not this. the
   remedies are your own server, the optional proxy (http, https or socks5,
   for zafu's own hosts, failing closed if it is down) or the nym mixnet for
   destinations that support it.
6. **a server that withholds.** a malicious or broken server can serve stale
   blocks or refuse to serve recent ones. proofs stop it from lying about what
   it serves, not from serving less. run your own if this matters.
7. **an attacker with a trusted root certificate.** tls does not hold against a
   corporate or state ca in your trust store: it can read queries, though
   chain proofs still catch tampering.
8. **airplane mode is discipline, not a guarantee.** zafu and zigner cannot
   enforce it, and it does not close usb, camera or microphone side channels.
9. **side channels.** proving runs in the browser; zafu makes no constant-time
   guarantee beyond its crypto libraries.
10. **cross-chain swaps.** a swap route is a third party. near intents (1click)
    may hold your funds at a custodial deposit address while it swaps, and may
    delay or freeze them; thorchain vaults are run by bonded nodes, and a zcash
    swap over thorchain leaves the shielded pool through a transparent address,
    which is public. the swap screen says who holds the funds on each route.

## relays

each relay sees a different amount. none sees keys, balances or amounts.

- **people relay** (relay.zafu.pro by default, changeable): carries chats and
  pair rooms, sealed end to end with room keys. it sees that you are online,
  which rooms you post to, and when.
- **contact discovery relay** (opt-in): stores opaque tags and sealed blobs so
  contacts can find each other. it sees the tags, not who they belong to.
- **frost multisig relay**: carries key generation and signing messages, sealed
  per peer with Noise_K. it sees ciphertext, session membership and timing. see
  [frost](frost.md).
- **nym** (opt-in): a mixnet transport. its gateways see that you use nym, not
  what you send.

## post-quantum identity layer

the zid noise channel that `@zafu/zid` offers apps is hybrid post-quantum: the
noise IK handshake mixes ML-KEM-768 into the classical X25519 agreement.
`@zafu/pq` also provides X-Wing (X25519 + ML-KEM-768) for one-shot sealed boxes.
this protects confidentiality against harvest-now-decrypt-later. signatures and
the ed25519 zid stay classical: a signature cannot be forged after it verified.

## penumbra voting

penumbra reuses a voting note's nullifier across votes on the same proposal,
so a note used to vote twice, or spent after voting, is linkable. the penumbra
planner zafu uses rolls the note over in the vote transaction (a spend and an
output of the same value), so later votes and spends use a fresh note.

## summary

| property                              | preserved                                     |
| ------------------------------------- | --------------------------------------------- |
| sender, receiver, amount (shielded)   | yes, by the chain                             |
| address comparison on zcash           | yes, a fresh random address each time         |
| unrequested network traffic           | yes, default-deny                             |
| query metadata vs the server          | no: your own server, proxy or nym             |
| viewing-key leak                      | no: all shielded receipts become readable     |
| host compromise, hot wallet           | no: pair with a signer                        |
| host compromise, with zigner          | spending yes, viewing no                      |
| tls against a trusted rogue ca        | partial: proofs catch tampering, reads leak   |

where each kind of data is stored, and whether it is sealed, is listed in
[encryption at rest](encryption.md).
