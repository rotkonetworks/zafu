# privacy

every default in zafu is the private one. anything faster or more convenient
is something you turn on, and the setting says what it costs.

## what zafu talks to

zafu talks only to the servers of the networks you turned on. for a new
wallet that is one server: the zcash node. nothing else is contacted until
you allow it, and onboarding contacts nothing at all.

every other destination is optional and off until a feature needs it:
another zcash or penumbra node, the zcash.me directory, contact discovery,
the people, chat and multisig relays, zcash voting, swap services (near
intents, thorchain), buying zec through peer, the gas sponsor, ibc routing,
and nym. the first time a feature needs one, zafu asks, once, naming the
destination and what it is for. no means off, and it stays off until you
turn it on.

settings > network > everything zafu talks to lists every destination,
whether it is on, and why. any of them can be turned off there, even a
network's own node.

a request zafu has not allowed is refused inside the extension, in every
part of it, before it leaves your computer.

## shielded and transparent

zcash and penumbra sync by trial decryption: zafu reads every block and finds
your notes on your computer. the node learns that someone is reading blocks,
not which notes are yours.

transparent addresses are different: asking about one tells the node that
address, and your ip with it.

- zcash transparent addresses are checked only when you ask (check now, the
  transparent view, a shield step).
- cosmos chain balances are asked only while that chain is on and cosmos
  balances are allowed (turning a cosmos chain on allows them).

## settings

| setting                            | default    | what it does                                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| cosmos balances                    | off        | ask cosmos nodes for your balances (they learn your addresses)                 |
| check zcash transparent each block | off        | check every transparent address of the pocket on each block while zafu is open |
| check penumbra deposits on open    | off        | check penumbra's transparent deposit addresses each time its balance opens     |
| transaction history                | asked once | keep a history on this computer, or show only the balance                      |
| keep penumbra syncing              | off        | keep syncing after the last zafu window closes                                 |
| explorer links                     | off        | off, copy (a link to copy), or open (the explorer sees your ip and the lookup) |
| open `zcash:` links                | on         | zafu opens payment links clicked on websites, for review                       |
| open `zafu:` links                 | on         | zafu opens its own links clicked on websites, for review                       |
| identity                           | on         | the zid layer: sign-in, encryption for sites, messaging                        |
| hide balances                      | off        | blur amounts on screen                                                         |
| transaction signing                | grace      | foilhat (password every time), grace (once per 15 minutes), unlock only        |
| sounds                             | off        | a bell for messages, a tap when money arrives                                  |

## nym

nym is a mixnet: requests sent over it reach the server without your ip.
it is optional and asked for like any other destination. once on, sends and
lookups go over nym per network (zcash: sends and your own lookups; penumbra:
sends; cosmos chains, swaps, voting, zcash.me, buying and message relays:
everything they send), while block sync stays direct. each of these can be
set to direct instead. a node on your own machine, lan or vpn is always
reached directly.

## your own proxy

settings can send zafu's traffic through a proxy of yours: http, https or
socks5. only zafu's own destinations use it; the rest of the browser is
untouched. it fails closed: if the proxy is down, zafu sends nothing rather
than going direct. a login works with http and https proxies, kept sealed;
socks5 is for a proxy without one, such as local tor.

## penumbra prices

penumbra values come from on-chain dex data zafu already syncs, priced in
numeraires from the registry bundled with zafu. no price service is asked.
