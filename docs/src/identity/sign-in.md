# sign in with zafu

short answers to the questions people ask about logging in with a zcash
wallet. the details of the keys are in [zid](zid.md).

## does signing in need a transaction?

no. a site sends a challenge, zafu shows which site is asking, and on
approval signs the challenge with that site's own key. nothing touches the
chain, nothing is paid, and the node never hears about it.

some "sign in with zcash" designs in the community prove control by
sending a small payment on every login (for example a 0.002 zec payment
that returns a one-time code in a memo). that costs a fee and a block
each time, and leaves an on-chain trace of every login. zafu does not do
this, and does not need to: a signature proves control of a key just as
well, instantly and privately.

| question                       | payment-per-login designs | zafu                        |
| ------------------------------ | ------------------------- | --------------------------- |
| transaction per login          | yes                       | no                          |
| cost                           | fee + payment             | none                        |
| time                           | a block, often more       | one approval                |
| what proves control            | a payment from an address | a signature from a site key |
| does the site learn an address | usually                   | no                          |
| can two sites link you         | if they compare addresses | no (one key per site)       |

## which key signs?

a key made for that one site, derived from your seed (see
[zid](zid.md#derivation)). every site sees a different public key, so
sites cannot link your accounts by comparing keys. the key is not your
zcash spending key and not your viewing key; a sign-in can never move
funds.

you can rotate a site's key, or switch to a new generation of your whole
identity; both are reversible.

## why not randomize the spend key (RedDSA)?

zcash's spend authorization already randomizes a key per spend
(`rk = ak + [alpha]G`), and the same trick could make many identities
from one authorizing key. it has one property zafu's per-site keys lack:
you could later prove two identities are the same person, or that an
identity controls certain funds, by revealing `alpha`.

it also has a catch. `ak` is part of your viewing key. anyone you ever
gave a viewing key to (an auditor, a tax tool, an exchange) could link
every identity whose `alpha` they can work out, and an `alpha` derived
from the site's name is easy to work out. so zafu keeps hashed per-site
keys for sign-in, which no viewing key can link, and treats randomized
spend keys as a tool for one job: proving control of funds without a
transaction. that is not built yet.

## what exactly is signed? (erc-4361)

today (protocol v1), the raw challenge bytes the site sends. zafu shows
the requesting origin but does not put it into the signed bytes, so the
site has to make its challenge fresh and bound to itself. a careless site
that signs a fixed string can be replayed. this is the main gap.

the next version signs a message zafu writes itself, in the spirit of
erc-4361 (sign in with ethereum), with the domain taken from the
browser's real origin, never from the site:

```
example.com wants you to sign in with your zafu identity:
zid8a3f72b1e9c04d5a

URI: https://example.com/login
Version: 2
Nonce: 8f3kq2...
Issued At: 2026-11-22T10:00:00Z
Expiration Time: 2026-11-22T10:05:00Z
```

zafu refuses a request whose domain does not match the page asking, and
a site checks the domain, nonce and expiry. app sessions (the
`zid:delegate` message the sdk signs) get the same treatment, with an
expiry. v1 keeps working for sites that already use it.

## what does zafu pro reveal?

pro is the one place an identity meets a transaction. today you pay with
a memo carrying your cross-site zid public key, so the license server
can tie your subscription to one stable key. it learns no address and no
balance, but that key is the same everywhere you share it. replacing it
with a payment that proves membership without a stable key (a randomized
key, or an anonymous credential) is planned.

## what can a site learn?

- the site's own public key for you, and a signature on its challenge
- nothing about your addresses, balances or other sites
- with cross-site mode on (opt-in, per site, with a warning), the same
  key every cross-site site sees

## status

| piece                                     | status  |
| ----------------------------------------- | ------- |
| sign in without a transaction             | shipped |
| one unlinkable key per site, rotation     | shipped |
| passkeys bound to the site (webauthn)     | shipped |
| erc-4361 style signed message (v2)        | next    |
| expiring app sessions                     | next    |
| pro without a stable key in the memo      | planned |
| proving funds with a randomized spend key | planned |
