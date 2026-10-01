//! The store: one SQLite table, three statements.
//!
//! A coordinate is `(app_scope, epoch, shard)` and holds one padded batch per
//! publisher. Two properties are load-bearing and neither is obvious:
//!
//!   - **Merge keyed by tag, never replace.** A publisher's batch must not evict
//!     anyone else's - see the wire contract in
//!     `packages/zid/src/relay-http.ts`. `INSERT .. ON CONFLICT DO UPDATE` gives
//!     merge and makes a retry idempotent for real tags (a tag is unique per
//!     publisher+epoch by construction).
//!   - **Reads are whole-coordinate.** There is deliberately no per-tag lookup;
//!     a relay that could answer "give me this tag" would let its operator watch
//!     which tags a client asks for and rebuild social-graph edges, which is the
//!     one thing the bucket design exists to prevent.
//!
//! Nothing here interprets tag or blob bytes: the relay is a store, and any
//! meaning they carry is between two clients.

use parking_lot::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

/// Where a batch of entries lives. `shard` is `""` when sharding is off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coord {
    pub app_scope: String,
    pub epoch: i64,
    pub shard: String,
}

/// One published entry: opaque tag, opaque blob. Bytes in, bytes out.
#[derive(Debug, Clone)]
pub struct Entry {
    pub tag: Vec<u8>,
    pub blob: Vec<u8>,
}

#[derive(Debug)]
pub enum StoreError {
    /// The coordinate would grow past the operator's cap. `held` is what it has
    /// now, `incoming` what the request tried to add.
    TooManyEntries { held: i64, incoming: i64 },
    /// SQLite said no (disk, corruption, lock timeout).
    Sql(rusqlite::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyEntries { held, incoming } => write!(
                f,
                "coordinate holds {held} entries; adding {incoming} would pass the cap"
            ),
            Self::Sql(e) => write!(f, "sqlite: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Escape `%`/`_` (SQL LIKE wildcards) in a literal prefix, then append `%` -
/// so a prefix rule only ever matches a literal prefix, never a pattern an
/// operator's scope string happened to contain.
fn like_prefix_pattern(prefix: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + 1);
    for c in prefix.chars() {
        if c == '%' || c == '_' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

/// How an `app_scope` is matched against a {@link ScopeRetention} rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeMatch {
    /// the scope string, exactly.
    Exact(String),
    /// any scope starting with this string (the config's trailing `*`).
    Prefix(String),
}

/// One per-scope retention override. Rules are tried in the order given; the
/// first match wins, and a scope matching none of them gets the store's
/// default retention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeRetention {
    pub matches: ScopeMatch,
    pub retention_seconds: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
    /// Entries a single coordinate may hold. A hostile client can append random
    /// tags without limit, so this is a floor on everyone's download size, not a
    /// quota for any one client.
    max_entries_per_coord: i64,
    /// How long a published entry is kept, for any `app_scope` not matched by
    /// `scope_retention`. Tags rotate every epoch, so older rows are unreadable
    /// to clients and useless to readers - and this layer has no forward secrecy
    /// by design, so keeping history only lengthens the window in which a later
    /// key compromise reconstructs who was online when.
    default_retention_seconds: i64,
    /// Overrides for specific scopes or prefixes (e.g. a zirc group room, kept
    /// ~25h instead of the 1h default). See `config.rs` for the cap every entry
    /// here is already clamped to before it reaches the store.
    scope_retention: Vec<ScopeRetention>,
}

impl Store {
    pub fn open(
        path: &str,
        max_entries_per_coord: i64,
        default_retention_seconds: i64,
        scope_retention: Vec<ScopeRetention>,
    ) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        // WAL: reads do not block the writer. busy_timeout: a concurrent publish
        // waits instead of failing the request.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS entries (
                 app_scope   TEXT    NOT NULL,
                 epoch       INTEGER NOT NULL,
                 shard       TEXT    NOT NULL,
                 tag         BLOB    NOT NULL,
                 blob        BLOB    NOT NULL,
                 inserted_at INTEGER NOT NULL,
                 PRIMARY KEY (app_scope, epoch, shard, tag)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS entries_inserted_at ON entries (inserted_at);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            max_entries_per_coord,
            default_retention_seconds,
            scope_retention,
        })
    }

    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Merge a batch into its coordinate. Returns how many entries the
    /// coordinate holds afterwards.
    pub fn put(&self, coord: &Coord, entries: &[Entry]) -> Result<i64, StoreError> {
        let mut conn = self.conn.lock();

        let held: i64 = conn.query_row(
            "SELECT COUNT(*) FROM entries WHERE app_scope = ?1 AND epoch = ?2 AND shard = ?3",
            params![coord.app_scope, coord.epoch, coord.shard],
            |row| row.get(0),
        )?;

        // Count only tags that are NOT already present: a retry re-publishes its
        // own entries and must not be treated as growth.
        let mut fresh = 0i64;
        {
            let mut probe = conn.prepare_cached(
                "SELECT 1 FROM entries WHERE app_scope = ?1 AND epoch = ?2 AND shard = ?3 AND tag = ?4",
            )?;
            for e in entries {
                let exists: Option<i64> = probe
                    .query_row(
                        params![coord.app_scope, coord.epoch, coord.shard, e.tag],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    fresh += 1;
                }
            }
        }
        if held + fresh > self.max_entries_per_coord {
            return Err(StoreError::TooManyEntries {
                held,
                incoming: fresh,
            });
        }

        let now = self.now();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO entries (app_scope, epoch, shard, tag, blob, inserted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (app_scope, epoch, shard, tag) DO UPDATE SET blob = excluded.blob",
            )?;
            for e in entries {
                stmt.execute(params![
                    coord.app_scope,
                    coord.epoch,
                    coord.shard,
                    e.tag,
                    e.blob,
                    now
                ])?;
            }
        }
        tx.commit()?;

        let after: i64 = conn.query_row(
            "SELECT COUNT(*) FROM entries WHERE app_scope = ?1 AND epoch = ?2 AND shard = ?3",
            params![coord.app_scope, coord.epoch, coord.shard],
            |row| row.get(0),
        )?;
        Ok(after)
    }

    /// The WHOLE coordinate. There is no single-tag read by design (see the
    /// module note); callers intersect locally.
    pub fn get(&self, coord: &Coord) -> Result<Vec<Entry>, StoreError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT tag, blob FROM entries WHERE app_scope = ?1 AND epoch = ?2 AND shard = ?3",
        )?;
        let rows = stmt.query_map(params![coord.app_scope, coord.epoch, coord.shard], |row| {
            Ok(Entry {
                tag: row.get(0)?,
                blob: row.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Drop entries older than the retention window, honouring each scope rule's
    /// own retention. Returns how many rows went.
    ///
    /// Built as one `DELETE ... WHERE inserted_at < CASE WHEN ... END` rather
    /// than one query per rule: every row is visited once, the first matching
    /// rule (in configured order) decides its cutoff, and anything matching no
    /// rule falls through to `default_retention_seconds` - the same priority a
    /// human reading the config top to bottom would expect.
    pub fn gc(&self) -> Result<usize, StoreError> {
        let now = self.now();
        let conn = self.conn.lock();

        if self.scope_retention.is_empty() {
            let cutoff = now - self.default_retention_seconds;
            let removed = conn.execute(
                "DELETE FROM entries WHERE inserted_at < ?1",
                params![cutoff],
            )?;
            return Ok(removed);
        }

        let mut sql = String::from("DELETE FROM entries WHERE inserted_at < CASE ");
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for rule in &self.scope_retention {
            let cutoff = now - rule.retention_seconds;
            match &rule.matches {
                ScopeMatch::Exact(scope) => {
                    sql.push_str("WHEN app_scope = ? THEN ? ");
                    values.push(Box::new(scope.clone()));
                    values.push(Box::new(cutoff));
                }
                ScopeMatch::Prefix(prefix) => {
                    sql.push_str("WHEN app_scope LIKE ? ESCAPE '\\' THEN ? ");
                    values.push(Box::new(like_prefix_pattern(prefix)));
                    values.push(Box::new(cutoff));
                }
            }
        }
        sql.push_str("ELSE ? END");
        values.push(Box::new(now - self.default_retention_seconds));

        let refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let removed = conn.execute(&sql, refs.as_slice())?;
        Ok(removed)
    }

    pub fn count(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock();
        let n = conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open(":memory:", 1000, 3600, Vec::new()).expect("open")
    }

    fn coord(scope: &str, epoch: i64) -> Coord {
        Coord {
            app_scope: scope.to_string(),
            epoch,
            shard: String::new(),
        }
    }

    fn entry(tag: u8, blob: u8) -> Entry {
        Entry {
            tag: vec![tag; 16],
            blob: vec![blob; 64],
        }
    }

    #[test]
    fn merge_keeps_both_publishers() {
        // The contract-critical property: two batches at one coordinate coexist.
        let s = store();
        s.put(&coord("poker", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("poker", 100), &[entry(2, 2)]).unwrap();

        let got = s.get(&coord("poker", 100)).unwrap();
        assert_eq!(
            got.len(),
            2,
            "a replacing store would have dropped the first publisher"
        );
    }

    #[test]
    fn republishing_the_same_tag_overwrites_instead_of_duplicating() {
        let s = store();
        s.put(&coord("poker", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("poker", 100), &[entry(1, 9)]).unwrap();

        let got = s.get(&coord("poker", 100)).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].blob, vec![9u8; 64], "the retry's blob should win");
    }

    #[test]
    fn coordinates_are_isolated() {
        let s = store();
        s.put(&coord("poker", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("poker", 101), &[entry(2, 2)]).unwrap();
        s.put(&coord("notes", 100), &[entry(3, 3)]).unwrap();

        assert_eq!(s.get(&coord("poker", 100)).unwrap().len(), 1);
        assert_eq!(s.get(&coord("poker", 101)).unwrap().len(), 1);
        assert_eq!(s.get(&coord("notes", 100)).unwrap().len(), 1);
        assert_eq!(s.get(&coord("other", 100)).unwrap().len(), 0);
    }

    #[test]
    fn cap_refuses_growth_but_allows_retries() {
        let s = Store::open(":memory:", 2, 3600, Vec::new()).unwrap();
        s.put(&coord("poker", 100), &[entry(1, 1), entry(2, 2)])
            .unwrap();
        // A retry of what is already there is not growth.
        s.put(&coord("poker", 100), &[entry(1, 7), entry(2, 7)])
            .unwrap();
        match s.put(&coord("poker", 100), &[entry(3, 3)]) {
            Err(StoreError::TooManyEntries { held, incoming }) => {
                assert_eq!((held, incoming), (2, 1));
            }
            other => panic!("expected the cap to refuse, got {other:?}"),
        }
    }

    #[test]
    fn gc_drops_entries_past_retention() {
        let s = Store::open(":memory:", 1000, 0, Vec::new()).unwrap();
        s.put(&coord("poker", 100), &[entry(1, 1)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let removed = s.gc().unwrap();
        assert_eq!(removed, 1);
        assert_eq!(s.count().unwrap(), 0);
    }

    #[test]
    fn gc_honours_a_longer_retention_for_a_specific_scope() {
        // a long-retention scope and a default-retention scope, swept together -
        // exactly the mixed shape a group-purse room (kept ~25h) and discovery
        // (kept 1h) share on one relay.
        let s = Store::open(
            ":memory:",
            1000,
            0, // default: anything not "zafu-group-v1" is swept immediately
            vec![ScopeRetention {
                matches: ScopeMatch::Exact("zafu-group-v1".to_string()),
                retention_seconds: 3600, // the group scope is kept an hour
            }],
        )
        .unwrap();
        s.put(&coord("zafu-group-v1", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("zid-discovery", 100), &[entry(2, 2)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let removed = s.gc().unwrap();

        assert_eq!(
            removed, 1,
            "only the default-retention scope's row is past its cutoff"
        );
        assert_eq!(
            s.get(&coord("zafu-group-v1", 100)).unwrap().len(),
            1,
            "the group row survives"
        );
        assert_eq!(
            s.get(&coord("zid-discovery", 100)).unwrap().len(),
            0,
            "the default-retention row is gone"
        );
    }

    #[test]
    fn gc_matches_a_prefix_rule_across_several_scopes() {
        let s = Store::open(
            ":memory:",
            1000,
            0,
            vec![ScopeRetention {
                matches: ScopeMatch::Prefix("zafu-group-".to_string()),
                retention_seconds: 3600,
            }],
        )
        .unwrap();
        s.put(&coord("zafu-group-v1", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("zafu-group-v2", 100), &[entry(2, 2)]).unwrap();
        s.put(&coord("other", 100), &[entry(3, 3)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let removed = s.gc().unwrap();

        assert_eq!(removed, 1);
        assert_eq!(s.get(&coord("zafu-group-v1", 100)).unwrap().len(), 1);
        assert_eq!(s.get(&coord("zafu-group-v2", 100)).unwrap().len(), 1);
        assert_eq!(s.get(&coord("other", 100)).unwrap().len(), 0);
    }

    #[test]
    fn a_prefix_rule_does_not_match_a_scope_that_merely_contains_it() {
        // "zafu-group-v1-evil" must not be swept by a rule that only names the
        // literal prefix "zafu-group-v1" without a trailing '*' of its own - the
        // config layer is what turns "scope*" into a Prefix rule at all.
        let s = Store::open(
            ":memory:",
            1000,
            0,
            vec![ScopeRetention {
                matches: ScopeMatch::Exact("zafu-group-v1".to_string()),
                retention_seconds: 3600,
            }],
        )
        .unwrap();
        s.put(&coord("zafu-group-v1-evil", 100), &[entry(1, 1)])
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let removed = s.gc().unwrap();
        assert_eq!(
            removed, 1,
            "an exact rule must not accidentally act as a prefix"
        );
    }

    #[test]
    fn a_literal_sql_wildcard_in_a_prefix_rule_is_escaped() {
        let s = Store::open(
            ":memory:",
            1000,
            0,
            vec![ScopeRetention {
                matches: ScopeMatch::Prefix("a_b".to_string()),
                retention_seconds: 3600,
            }],
        )
        .unwrap();
        // "a_b..." should match (real prefix); "axbyc" must NOT match just
        // because unescaped '_' is a SQL LIKE wildcard for "any one character".
        s.put(&coord("a_bcde", 100), &[entry(1, 1)]).unwrap();
        s.put(&coord("axbyc", 100), &[entry(2, 2)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));

        s.gc().unwrap();

        assert_eq!(
            s.get(&coord("a_bcde", 100)).unwrap().len(),
            1,
            "real prefix kept"
        );
        assert_eq!(
            s.get(&coord("axbyc", 100)).unwrap().len(),
            0,
            "unrelated scope swept by default"
        );
    }
}
