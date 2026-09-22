//! Configuration, all from the environment so the container needs no config file.

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub db_path: String,
    /// Entries one coordinate may hold (see `store.rs`: a hostile client can
    /// append random tags without limit, so this bounds everyone's download).
    pub max_entries_per_coord: i64,
    /// How long published entries are kept before the GC drops them.
    pub retention_seconds: i64,
    /// Entries accepted in a single request. Must be at least the protocol's
    /// padding constant (64) - a client writes its whole padded batch in one PUT
    /// and splitting it would change the write shape, leaking friend counts.
    pub max_entries_per_put: usize,
    /// Bytes accepted in a single request body.
    pub max_body_bytes: usize,
    /// CORS origin for browser clients. `*` is the default because the protocol
    /// carries no credentials and a wallet may point at any relay.
    pub allow_origin: String,
}

fn var_i64(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn var_usize(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: var_i64("MINIRELAY_PORT", 8080).clamp(1, u16::MAX as i64) as u16,
            db_path: env::var("MINIRELAY_DB").unwrap_or_else(|_| "minirelay.sqlite".to_string()),
            max_entries_per_coord: var_i64("MINIRELAY_MAX_ENTRIES_PER_COORD", 1_000_000),
            retention_seconds: var_i64("MINIRELAY_RETENTION_SECONDS", 3_600),
            max_entries_per_put: var_usize("MINIRELAY_MAX_ENTRIES_PER_PUT", 4096),
            max_body_bytes: var_usize("MINIRELAY_MAX_BODY_BYTES", 8 * 1024 * 1024),
            allow_origin: env::var("MINIRELAY_ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_accept_a_full_padded_batch() {
        // 64 entries is the protocol's padding constant; a default that could not
        // take one whole batch would break every client.
        let c = Config::from_env();
        assert!(c.max_entries_per_put >= 64);
        assert!(c.max_body_bytes >= 64 * (16 + 64) * 2);
        assert!(c.max_entries_per_coord > c.max_entries_per_put as i64);
        assert_eq!(c.port, 8080);
    }
}