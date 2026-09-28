---
'zafu': patch
---

`zafu` now asks before it talks to a host it did not ship.

- Every outbound request passes one gate. A device on your own machine passes
  silently (there is nothing to consent to), an endpoint zafu ships for a network
  you enabled passes silently, and an endpoint you typed yourself passes silently
  - asking you to approve your own node would be theatre. Anything else, such as
    an RPC endpoint a site advertised, raises one question naming the host, why
    zafu wants it, and which app asked.
- The question is asked once per host and cannot be stacked: a request that
  arrives while the question is open is refused rather than opening a second
  window, and closing the window undecided is not recorded as a refusal - it can
  be asked again.
- A refusal now says why ("zafu is not allowed to connect to …", "… is not an
  endpoint zafu ships or you configured") instead of surfacing as a bare
  `TypeError: Failed to fetch`.
- Settings gains a **Networks** directory: the chains zafu can reach over IBC
  with the endpoint it uses for each, the networks you added yourself (name,
  chain id, rpc, optional rest), and per-host allow/block with the reason a host
  is trusted. Removing a network forgets the hosts it covered, so nothing stays
  trusted because of a network that is gone.
- Adding a network is a statement about reachability, not a new chain: it points
  zafu at a node for a chain it already supports.
