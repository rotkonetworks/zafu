# networks

a new wallet starts with zcash only. more networks are turned on in
settings > networks, and zafu contacts a network's servers only while it is
on (see [privacy](privacy.md)).

| network       | kind                 | on by default |
| ------------- | -------------------- | ------------- |
| zcash         | shielded             | yes           |
| zcash testnet | shielded, no value   | no            |
| penumbra      | shielded             | no            |
| noble         | cosmos, via penumbra | no            |
| cosmos hub    | cosmos, via penumbra | no            |
| osmosis       | cosmos, via penumbra | no            |
| injective     | cosmos, via penumbra | no            |

## shielded networks

zafu downloads compact blocks and trial-decrypts them on your computer with
your viewing key. the node sees that someone is reading blocks, not which
notes are yours.

### zcash

- shielded pools: orchard and ironwood (nu6.3)
- node: `https://zcash.rotko.net` (zidecar) by default. any zidecar or
  lightwalletd can be used instead, in settings > zcash > node
- chain check: a zidecar running flyclient proves its chain against
  zcash's proof of work, and zafu checks the proof and compares its own note
  trees with the proven roots. a node that cannot prove (lightwalletd, a
  zidecar without flyclient, testnet) still works; zafu says the chain is not
  verified
- scanning never starts before orchard activation (height 1,687,104)
- **pockets**: separate balances in one wallet, each a zip 32 account with
  its own addresses and its own sync
- **transparent addresses** are checked only when you ask (check now, the
  transparent view, a shield step). an opt-in setting checks every
  transparent address of the pocket on each new block while zafu is open;
  the node then sees those addresses together
- also: encrypted inbox (memos), FROST multisig, voting, swaps

zcash swaps go to other chains through NEAR intents or THORChain, third-party
services zafu does not run. the swap screen says who holds the funds on each
route before anything is sent.

zcash testnet is a separate network with coins of no value, for trying
things. while it is on, a seed wallet's zcash uses testnet.

### penumbra

- node: `https://penumbra.rotko.net` by default
- staking, governance voting, encrypted inbox, private dex swaps in the
  wallet

a wallet made in zafu starts syncing at the tip. any earlier start reads
every block from genesis and only skips trial decryption before the
birthday, because the node serves the note tree only at its tip.

## cosmos chains

cosmos chains are reached through penumbra: they appear only while the
penumbra node reports a live ibc route to them. they are transparent:
balance queries name your address to the chain's rpc node, which can link it
to your ip. turning a cosmos chain on also allows these balance queries
(settings > privacy).

all use secp256k1 keys at `m/44'/118'/0'/0/0` with the chain's own bech32
prefix.

noble is winding down: circle ends usdc on noble (the bridge halts on
2026-12-01, the contract pauses on 2027-01-12), so move usdc off noble
before then.

## custom endpoints

every network's endpoint can be changed in settings; your choice is kept
apart from the defaults.

### your own zcash node

zafu speaks the light-client protocol, not zebra's json-rpc, so it cannot
talk to zebra (`:8232`) directly. run
[zidecar](https://github.com/rotkonetworks/zcli/tree/master/bin/zidecar) next
to zebra and point zafu at it:

```sh
zidecar --zebrad-rpc http://127.0.0.1:8232 --zidecar-rpc --flyclient nu6.3
# zafu: settings > zcash > node > your own node > http://localhost:50051
```

zidecar answers grpc-web over plain http, so `http://` works on this
machine, your lan or a vpn. lightwalletd and zaino answer native grpc only,
which a browser speaks over https alone: put them behind https or use
zidecar. a node on this machine, your lan or a vpn is always reached
directly: nym's exits are on the internet and cannot reach it.
