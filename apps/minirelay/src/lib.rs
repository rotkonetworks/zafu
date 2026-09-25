//! minirelay - the presence relay for zafu's private contact discovery.
//!
//! Deliberately the dumbest thing that satisfies the wire contract in
//! `packages/zid/src/relay-http.ts`: two routes over one SQLite table, no crypto,
//! no identities, no per-tag lookup. Everything that makes the protocol private
//! happens on the clients - this stores opaque tags and sealed blobs and answers
//! whole coordinates.
//!
//! What the operator can and cannot see, stated plainly because it decides who
//! should run this: it sees source addresses, timings, and which
//! `(app_scope, epoch)` is read or written. It cannot read a blob (AEAD under a
//! pairwise secret it never holds) and cannot forge one, but it can withhold
//! entries, and a client cannot detect that. So: run your own, or run one you
//! would trust to be merely unavailable rather than hostile.

pub mod config;
pub mod server;
pub mod service;
pub mod store;
pub mod strategy;
