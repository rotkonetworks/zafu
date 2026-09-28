---
'zafu': patch
---

Route and tab gates read the per-network capability table (`hasFeature`)
instead of ad-hoc `=== 'zcash'` / `isIbcNetwork(n)` literals, so a chain's
capabilities are declared in one place. Rendered behaviour is unchanged for the
swap, vote, multisig, stake and privacy surfaces - the swap flag, which named
only unlaunched ethereum, now names the chains the swap page really serves, so
the side menu's swap entry appears on zcash/penumbra, and chains that never had
a working stake page no longer show a dead stake tab.
