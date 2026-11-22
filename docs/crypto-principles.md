# crypto principles

How zafu's code is written (less code, compact reactive code, services as
functions, no unnecessary network calls) is in [AGENTS.md](../AGENTS.md). This
page keeps the one principle that is about cryptography.

## ship composed constructions, never raw primitives

Our crypto surface offers **prebatched compositions**, not primitives. Callers get one key,
one `sign`, one `seal` - never a bare KEM, a bare signature scheme, or two halves they are
expected to combine themselves:

- **Hybrid where it matters.** Key agreement and sealing are X-Wing (X25519 +
  ML-KEM-768): the hybrid is no weaker than its strongest surviving component, so a break
  in either half is not a break in the whole. Signatures stay ed25519: a signature cannot
  be forged after it was verified, so authentication has no harvest-now exposure. FALCON
  derivation paths are reserved for when post-quantum signatures are needed.
- **The primitive choice is ours, not the caller's.** A caller who is handed a primitive has
  to get the combiner, the transcript binding and the domain separation right - and that is
  where hybrid deployments actually fail. Exposing the composition moves that work behind one
  reviewed API.
- **Standards live at the primitive layer.** We take NIST-selected primitives (ML-KEM / FIPS
  203, FN-DSA/FIPS 206) and well-studied combiners (X-Wing-style concatenation). We do not
  invent a new primitive, and we do not invent a new combiner.
- **Document the composition as a composition.** State plainly what is standardised, what is a
  composed choice, and what the construction does _not_ prove (e.g. static-static sealing
  proves pair membership, not authorship).
