# On memo-fetch privacy in Zcash light wallets

Most Zcash light wallets I've checked have a metadata leak in the memo-fetch
phase of sync. The fix is straightforward, works on any lightwalletd/zaino
today, and adopts an idea the Penumbra docs explain well as **Fuzzy Message
Detection**.

## The leak

Compact-block sync is fine — the server streams 52-byte compact ciphertexts
to everyone, the wallet trial-decrypts locally, the server learns nothing.

But memos are 512 bytes and are deliberately excluded from compact blocks
to save bandwidth. So wallets fetch the full transaction afterward:

```
for note in owned_notes:
    raw_tx = client.GetTransaction(note.txid)   # ← leak
    decrypt_memo(raw_tx)
```

After this loop, the server has a precise list of `(client_ip, owned_txid)`
pairs. Diversified addresses correlate by IP. Combined with ISP records,
deanonymization is trivial.

This is **not** the compact-block-scan problem people usually discuss.
It's the second phase, after notes are already found.

## What we want

From [Penumbra's design docs](https://protocol.penumbra.zone/main/crypto/fmd.html):

> "it would be useful to be able to delegate only a probabilistic
> detection capability. Analogous to a Bloom filter, this would allow
> a detector to identify all transactions related to a particular
> address (no false negatives), while also identifying unrelated
> transactions with some false positive probability."

Penumbra solves this cryptographically with Sender-Receiver Fuzzy Message
Detection (S-FMD), a variant of Beck-Len-Miers-Green's FMD scheme
([CCS 2021](https://eprint.iacr.org/2021/089)). It needs protocol support.

On Zcash we can't change the protocol. But we can get the **same privacy
property** at the fetch layer with no protocol changes.

## What zafu does

For each owned note, group its block height into a 100-block bucket. Then:

1. Take the union of buckets containing your notes (received + spend heights).
2. Generate **2× as many random decoy buckets** in the same height range.
3. Shuffle real + decoy together.
4. Fetch each bucket's full blocks via `GetBlockRange` — **not** individual txids.
5. Decrypt memos locally.
6. Cache processed buckets so we never re-fetch.

From the server's view: the wallet downloaded `3N` random 100-block windows
in random order. The server cannot distinguish real from decoy, and every
action in a real bucket is fetched whether the wallet owns it or not. The
server learns *approximate activity windows*, not transaction membership.

## Mapping to FMD

| | Penumbra S-FMD | zafu bucket+decoy |
|---|---|---|
| Mechanism | Cryptographic clue keys | Random extra fetches |
| Server role | Scans with detection key | Dumb block server |
| Server learns | Superset of relevant txs | Superset of relevant blocks |
| No false negatives | ✓ | ✓ |
| FP rate tunable | ✓ (precision param) | ✓ (`NOISE_BUCKET_RATIO`) |
| Requires protocol changes | yes | no |
| Works on Zcash today | no | yes |

Same privacy shape — Penumbra does it with crypto at the protocol layer,
zafu does it ad-hoc at the wallet layer. The bucket+decoy approach is the
"no-crypto-required" cousin of FMD.

## What it isn't

Not PIR. A network adversary still sees the exact block ranges requested.
The change is against the **server's** ability to map clients to
transactions: from "complete tx graph by IP" to "approximate activity
windows by IP." Combined with Tor or VPN, the deanonymization story gets
much harder.

## Tradeoffs

- 3× bandwidth on memo sync (runs rarely, wall-clock cost is small)
- Cache-and-don't-refetch (trades a one-time bucket disclosure for not
  letting the server narrow down across many syncs)
- New-wallet fingerprint (mitigated by wider adoption)
- `NOISE_BUCKET_RATIO = 2` is the knob; higher = more privacy + more bandwidth

## Code

[apps/extension/src/workers/zcash-worker.ts — sync-memos handler](https://github.com/rotkonetworks/zafu/blob/main/apps/extension/src/workers/zcash-worker.ts#L1886-L2080)
(private repo — extract available on request)

## Why post

Standard wallets should adopt this. The change is local to the memo-fetch
loop. No server changes, no protocol changes, small bandwidth cost, real
privacy gain. If every Zcash light wallet did this, the existing
lightwalletd infrastructure would become meaningfully more
privacy-preserving overnight.

Critique welcome on three points:
- Uniform-random vs activity-weighted decoy distribution
- Cache-and-don't-refetch policy across multiple syncs
- Does `2×` decoy ratio give meaningful indistinguishability or is it
  security theater?

## Credit

- The privacy property is FMD — Beck, Len, Miers, Green (CCS 2021)
- The protocol-level realization is S-FMD — Penumbra
- The Zcash-side adaptation is what zafu does: same goal, plain
  `GetBlockRange` calls, ships on existing servers today

## References

- Beck, Len, Miers, Green. *Fuzzy Message Detection.* CCS 2021.
  https://eprint.iacr.org/2021/089
- Penumbra Protocol — Fuzzy Message Detection design.
  https://protocol.penumbra.zone/main/crypto/fmd.html
- ZIP-302 — Zcash memo format.
  https://zips.z.cash/zip-0302
- lightwalletd RPC reference — `GetCompactBlockRange`, `GetBlockRange`,
  `GetTransaction`
