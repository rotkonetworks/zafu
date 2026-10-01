//! Configuration, all from the environment so the container needs no config file.

use std::env;

use crate::store::{ScopeMatch, ScopeRetention};

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub db_path: String,
    /// Entries one coordinate may hold (see `store.rs`: a hostile client can
    /// append random tags without limit, so this bounds everyone's download).
    pub max_entries_per_coord: i64,
    /// How long published entries are kept before the GC drops them, for any
    /// `app_scope` not matched by `scope_retention` below.
    pub retention_seconds: i64,
    /// Per-scope (or per-prefix) retention overrides, from
    /// `MINIRELAY_SCOPE_RETENTION` - see that variable's doc below. Every
    /// entry here is already clamped to `max_scope_retention_seconds`.
    pub scope_retention: Vec<ScopeRetention>,
    /// Ceiling any `MINIRELAY_SCOPE_RETENTION` entry is clamped to, so a
    /// mistyped (or malicious) config cannot turn a bounded relay into an
    /// unbounded archive for one scope. See `MINIRELAY_MAX_SCOPE_RETENTION_SECONDS`.
    pub max_scope_retention_seconds: i64,
    /// Entries accepted in a single request. Must be at least the protocol's
    /// padding constant (64) - a client writes its whole padded batch in one PUT
    /// and splitting it would change the write shape, leaking friend counts.
    pub max_entries_per_put: usize,
    /// Bytes accepted in a single request body.
    pub max_body_bytes: usize,
    /// CORS origin for browser clients. `*` is the default because the protocol
    /// carries no credentials and a wallet may point at any relay.
    pub allow_origin: String,
    /// When set, every request must present `authorization: Bearer <token>`.
    /// Operator policy, not user auth: the relay can only decide who may use it.
    pub token: Option<String>,
    /// When non-empty, only these app scopes are served. A scope is a public
    /// string, so this is how an operator hosts a relay for one community.
    pub allowed_scopes: Vec<String>,
    /// Per-source request budget (0 = unlimited). Honest usage is a publish plus
    /// a fetch per epoch.
    pub rate_limit_per_minute: usize,
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

/// Parse `MINIRELAY_SCOPE_RETENTION`: `scope=seconds,scope2*=seconds2,...`.
///
/// A trailing `*` on the scope marks a PREFIX rule (`zafu-group-*=90000`
/// matches `zafu-group-v1`, `zafu-group-v2`, ...); without it the match is
/// exact. Rules keep the order they were written in - `store::gc` tries them
/// in that order and the first match wins - and each `seconds` value is
/// clamped to `cap` (a warning is printed when clamping actually changes a
/// value, so a misconfigured deployment is loud about it rather than silently
/// capped forever).
fn parse_scope_retention(raw: &str, cap: i64) -> Vec<ScopeRetention> {
    let mut rules = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((scope, seconds)) = entry.split_once('=') else {
            eprintln!(
                "minirelay: MINIRELAY_SCOPE_RETENTION entry {entry:?} is not `scope=seconds`, ignoring it"
            );
            continue;
        };
        let scope = scope.trim();
        let Ok(mut seconds) = seconds.trim().parse::<i64>() else {
            eprintln!(
                "minirelay: MINIRELAY_SCOPE_RETENTION entry {entry:?} has a non-numeric retention, ignoring it"
            );
            continue;
        };
        if seconds > cap {
            eprintln!(
                "minirelay: MINIRELAY_SCOPE_RETENTION for {scope:?} asked for {seconds}s, clamped to the {cap}s cap (MINIRELAY_MAX_SCOPE_RETENTION_SECONDS)"
            );
            seconds = cap;
        }
        let matches = match scope.strip_suffix('*') {
            Some(prefix) if !prefix.is_empty() => ScopeMatch::Prefix(prefix.to_string()),
            Some(_) => {
                eprintln!(
                    "minirelay: MINIRELAY_SCOPE_RETENTION entry {entry:?} has an empty prefix, ignoring it"
                );
                continue;
            }
            None if !scope.is_empty() => ScopeMatch::Exact(scope.to_string()),
            None => {
                eprintln!(
                    "minirelay: MINIRELAY_SCOPE_RETENTION entry {entry:?} names no scope, ignoring it"
                );
                continue;
            }
        };
        rules.push(ScopeRetention {
            matches,
            retention_seconds: seconds,
        });
    }
    rules
}

impl Config {
    pub fn from_env() -> Self {
        let max_scope_retention_seconds = var_i64("MINIRELAY_MAX_SCOPE_RETENTION_SECONDS", 172_800); // 48h
        let scope_retention = env::var("MINIRELAY_SCOPE_RETENTION")
            .ok()
            .map(|raw| parse_scope_retention(&raw, max_scope_retention_seconds))
            .unwrap_or_default();
        Self {
            port: var_i64("MINIRELAY_PORT", 8080).clamp(1, u16::MAX as i64) as u16,
            db_path: env::var("MINIRELAY_DB").unwrap_or_else(|_| "minirelay.sqlite".to_string()),
            max_entries_per_coord: var_i64("MINIRELAY_MAX_ENTRIES_PER_COORD", 1_000_000),
            retention_seconds: var_i64("MINIRELAY_RETENTION_SECONDS", 3_600),
            scope_retention,
            max_scope_retention_seconds,
            max_entries_per_put: var_usize("MINIRELAY_MAX_ENTRIES_PER_PUT", 4096),
            max_body_bytes: var_usize("MINIRELAY_MAX_BODY_BYTES", 8 * 1024 * 1024),
            allow_origin: env::var("MINIRELAY_ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string()),
            token: env::var("MINIRELAY_TOKEN").ok().filter(|t| !t.is_empty()),
            allowed_scopes: env::var("MINIRELAY_ALLOWED_SCOPES")
                .ok()
                .map(|list| {
                    list.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            rate_limit_per_minute: var_usize("MINIRELAY_RATE_LIMIT_PER_MINUTE", 0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_token_env_var_is_treated_as_unset() {
        // MINIRELAY_TOKEN= (present but empty) must not lock the relay behind a
        // token nobody can present.
        std::env::set_var("MINIRELAY_TOKEN", "");
        let c = Config::from_env();
        std::env::remove_var("MINIRELAY_TOKEN");
        assert!(c.token.is_none());
    }

    #[test]
    fn scope_lists_split_and_drop_blank_entries() {
        std::env::set_var("MINIRELAY_ALLOWED_SCOPES", "poker, , notes ");
        let c = Config::from_env();
        std::env::remove_var("MINIRELAY_ALLOWED_SCOPES");
        assert_eq!(c.allowed_scopes, vec!["poker", "notes"]);
    }

    #[test]
    fn defaults_accept_a_full_padded_batch() {
        // 64 entries is the protocol's padding constant; a default that could not
        // take one whole batch would break every client.
        let c = Config::from_env();
        assert!(c.max_entries_per_put >= 64);
        assert!(c.max_body_bytes >= 64 * (16 + 64) * 2);
        assert!(c.max_entries_per_coord > c.max_entries_per_put as i64);
        assert_eq!(c.port, 8080);
        // not asserting scope_retention here: MINIRELAY_SCOPE_RETENTION is
        // process-global env state and cargo test runs this file's tests
        // concurrently by default - env_wiring_reads_scope_retention_and_its_cap
        // below exercises that plumbing on its own, with its own set/remove.
    }

    #[test]
    fn scope_retention_parses_the_zirc_group_example_from_the_design() {
        let rules = parse_scope_retention("zafu-group-v1=90000", 172_800);
        assert_eq!(
            rules,
            vec![ScopeRetention {
                matches: ScopeMatch::Exact("zafu-group-v1".to_string()),
                retention_seconds: 90_000,
            }]
        );
    }

    #[test]
    fn scope_retention_parses_several_entries_and_a_prefix_rule() {
        let rules = parse_scope_retention("zafu-group-v1=90000, zafu-poker-*=7200", 172_800);
        assert_eq!(
            rules,
            vec![
                ScopeRetention {
                    matches: ScopeMatch::Exact("zafu-group-v1".to_string()),
                    retention_seconds: 90_000,
                },
                ScopeRetention {
                    matches: ScopeMatch::Prefix("zafu-poker-".to_string()),
                    retention_seconds: 7_200,
                },
            ]
        );
    }

    #[test]
    fn scope_retention_is_clamped_to_the_cap() {
        // a scope cannot buy unbounded storage growth by asking for a year of
        // retention - it is silently (but loudly, via the log line) clamped.
        let rules = parse_scope_retention("zafu-group-v1=31536000", 172_800);
        assert_eq!(rules[0].retention_seconds, 172_800);
    }

    #[test]
    fn a_malformed_entry_is_skipped_rather_than_panicking_the_relay() {
        let rules = parse_scope_retention("not-a-pair, zafu-group-v1=notanumber, =5, *=5", 172_800);
        assert!(rules.is_empty());
    }

    #[test]
    fn env_wiring_reads_scope_retention_and_its_cap() {
        std::env::set_var("MINIRELAY_SCOPE_RETENTION", "zafu-group-v1=90000");
        std::env::set_var("MINIRELAY_MAX_SCOPE_RETENTION_SECONDS", "100000");
        let c = Config::from_env();
        std::env::remove_var("MINIRELAY_SCOPE_RETENTION");
        std::env::remove_var("MINIRELAY_MAX_SCOPE_RETENTION_SECONDS");

        assert_eq!(c.max_scope_retention_seconds, 100_000);
        assert_eq!(
            c.scope_retention,
            vec![ScopeRetention {
                matches: ScopeMatch::Exact("zafu-group-v1".to_string()),
                retention_seconds: 90_000,
            }]
        );
    }
}
