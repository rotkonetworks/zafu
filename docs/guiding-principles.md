# Guiding principles

## All code should be typesafe

That means there should be _almost zero_ use of `any` within the repo.
The most important step is ensuring `strict: true` is enabled in [tsconfig.json](../packages/tsconfig/base.json).
There should be no condition on which that is switched off. This will help
future developers from being able to easily add/change code given the whole system
will have type safety guarantees. This, plus extensive testing, will make our code
more resilient. We should only disable the type-checker/linter when we have no choice,
not because it's easier.

## CI/CD enforces best practices

We should treat the master branch with as much respect as possible. This means that our
CI/CD pipeline `/.github/workflows` should actively enforce the best practices:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [ESLint](https://eslint.org/) for code linting
- [Prettier](https://prettier.io) for code formatting
- [Vitest](https://vitest.dev/) for unit testing
- [Turborepo](https://turbo.build/) for builds

It should not be possible to ship code that hasn't gone through the fire. Further, the use of `eslint`
with [quite high standards](https://github.com/penumbra-zone/web/tree/main/packages/configs) is necessary to keep the
codebase
code quality high. See [CI/CD guide](ci-cd.md) for running commands locally.

## Modularity from the beginning

We should attempt to be liberal about adding packages if we think it can get re-use from another
app in this repo or even outside. This will allow us to expose critical functionality
that can make developing further apps easier.

## Ongoingly document

We should attempt to _document as we go_. That should commonly come in two forms:

1. **Code comments** - When there is code that starts to require domain knowledge to understand, we should be quite
   liberal about adding in-line code comments to explain variables, functions, decisions, etc.
2. **Architecture docs** - This directory holds the documentation on larger technical decisions and system designs.

## Ship composed constructions, never raw primitives

Our crypto surface offers **prebatched compositions**, not primitives. Callers get one key,
one `sign`, one `seal` - never a bare KEM, a bare signature scheme, or two halves they are
expected to combine themselves:

- **Hybrid by default.** X25519 + ML-KEM-768 for encryption, ed25519 + FALCON-512 for
  signatures. The composition carries the argument: the hybrid is no weaker than its
  strongest surviving component, so a break in either half is not a break in the whole.
- **The primitive choice is ours, not the caller's.** A caller who is handed a primitive has
  to get the combiner, the transcript binding and the domain separation right - and that is
  where hybrid deployments actually fail. Exposing the composition moves that work behind one
  reviewed API.
- **Standards live at the primitive layer.** We take NIST-selected primitives (ML-KEM/ FIPS
  203, FN-DSA/FIPS 206) and well-studied combiners (X-Wing-style concatenation). We do not
  invent a new primitive, and we do not invent a new combiner.
- **Document the composition as a composition.** State plainly what is standardised, what is a
  composed choice, and what the construction does _not_ prove (e.g. static-static sealing
  proves pair membership, not authorship).
