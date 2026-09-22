//! The relay as a server-as-a-function, in tower's terms.
//!
//! `docs/services-pattern.md` describes the shape this repo builds everything
//! around and `@zafu/service` is its TypeScript form; in Rust that shape already
//! exists as tower's `Service` + `Layer` + `ServiceBuilder`, so policy here is
//! written in the standard vocabulary rather than a private one:
//!
//! ```text
//! Service   - one request in, one response out
//! Layer     - wraps a Service in another Service (our "filter")
//! strategy  - a named ServiceBuilder stack around one base Service
//! ```
//!
//! `ServiceBuilder::layer` applies outermost-first, matching `@zafu/service`'s
//! `compose` and the extension's signer filters.
//!
//! Two deliberate differences from the TypeScript side, both because this is a
//! server rather than a client:
//!
//!   - The request is a DOMAIN type ([`RelayRequest`]) instead of an HTTP one.
//!     Policy needs the parsed operation (`appScope` for scope rules, the token
//!     for auth), and a layer that had to re-parse a body to see them would do the
//!     work twice. HTTP concerns stay at the edge (`server.rs`).
//!   - Every layer exists in the stack and no-ops when it is not configured, so
//!     the composed type never varies with configuration: `RelayService` is a
//!     concrete type, which is what lets it live in axum's `State` (that state
//!     must be `Sync`, and tower's boxed services are not - hence no boxing).
//!
//! The base service is the ONLY I/O leaf: it talks to SQLite and nothing else.
//! Layers never touch the store; they decide what reaches it. That is what makes
//! operator policy injectable without forking the server - and it is also the
//! honest limit of what a relay can enforce:
//!
//!   - a layer can decide WHO MAY USE THIS RELAY (a bearer token), WHICH SCOPES it
//!     serves, and HOW FAST anyone may ask. That is real authority, and the only
//!     kind a relay can have;
//!   - a layer CANNOT moderate people. It cannot ban a user, count someone's
//!     friends, or attribute an entry to an identity, because the relay never
//!     learns any of that: tags are unlinkable across epochs and blobs are sealed
//!     under pairwise secrets it never holds. Anything IRC-like (ops, modes, bans)
//!     belongs in an application on top, where identities exist - see the design
//!     note in the README.

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tower::{Layer, Service};

use crate::store::{Coord, Entry, Store, StoreError};

/// A boxed future: tower services name their future type, and a layer that may
/// short-circuit cannot hand the inner service's future back directly.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What a request is, independent of HTTP.
#[derive(Debug, Clone)]
pub enum Op {
    Put { coord: Coord, entries: Vec<Entry> },
    Get { coord: Coord },
}

impl Op {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Put { .. } => "put",
            Self::Get { .. } => "get",
        }
    }

    /// The coordinate, for layers whose policy is per-namespace.
    pub fn coord(&self) -> &Coord {
        match self {
            Self::Put { coord, .. } | Self::Get { coord } => coord,
        }
    }
}

/// Where a request came from - deliberately only what the transport already
/// shows any server, plus the credential the caller presented. There is no
/// identity field because the relay cannot have one.
#[derive(Debug, Clone)]
pub struct Source {
    pub ip: IpAddr,
    /// The bearer token presented on this request, if any.
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RelayRequest {
    pub op: Op,
    pub source: Source,
}

#[derive(Debug)]
pub enum RelayResponse {
    Stored { held: i64 },
    Entries(Vec<Entry>),
}

#[derive(Debug)]
pub enum RelayError {
    /// No token, or the wrong one.
    Unauthorized,
    /// The relay does not serve this app scope.
    ScopeNotServed(String),
    /// This source is over its request budget.
    RateLimited { limit: usize, window_seconds: u64 },
    /// The coordinate would grow past the operator's cap.
    CoordinateFull { held: i64, incoming: i64 },
    /// The store refused (disk, lock, corruption).
    Store(String),
}

// -- the base service: the only I/O leaf --------------------------------------

#[derive(Clone)]
pub struct StoreService {
    store: Arc<Store>,
}

impl StoreService {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }
}

impl Service<RelayRequest> for StoreService {
    type Response = RelayResponse;
    type Error = RelayError;
    type Future = BoxFuture<Result<RelayResponse, RelayError>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // The store is always ready: a block of SQLite work has no backpressure to
        // signal, and pretending otherwise would only add a queue nobody sized.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: RelayRequest) -> Self::Future {
        let store = Arc::clone(&self.store);
        Box::pin(async move {
            match req.op {
                Op::Put { coord, entries } => match store.put(&coord, &entries) {
                    Ok(held) => Ok(RelayResponse::Stored { held }),
                    Err(StoreError::TooManyEntries { held, incoming }) => {
                        Err(RelayError::CoordinateFull { held, incoming })
                    }
                    Err(e) => Err(RelayError::Store(e.to_string())),
                },
                Op::Get { coord } => store
                    .get(&coord)
                    .map(RelayResponse::Entries)
                    .map_err(|e| RelayError::Store(e.to_string())),
            }
        })
    }
}

// -- layers (the filters) -----------------------------------------------------

/// Require a bearer token when one is configured; pass through when not.
///
/// Authority over who may use this relay - the only kind a relay can hold, and
/// the reason an operator can host one for a community without hosting it for
/// the internet.
#[derive(Clone, Default)]
pub struct RequireTokenLayer {
    expected: Option<Arc<String>>,
}

impl RequireTokenLayer {
    pub fn new(expected: Option<String>) -> Self {
        Self {
            expected: expected.map(Arc::new),
        }
    }
}

impl<S> Layer<S> for RequireTokenLayer {
    type Service = RequireToken<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RequireToken {
            inner,
            expected: self.expected.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RequireToken<S> {
    inner: S,
    expected: Option<Arc<String>>,
}

impl<S> Service<RelayRequest> for RequireToken<S>
where
    S: Service<RelayRequest, Response = RelayResponse, Error = RelayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = RelayResponse;
    type Error = RelayError;
    type Future = BoxFuture<Result<RelayResponse, RelayError>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: RelayRequest) -> Self::Future {
        let mut inner = self.inner.clone();
        let expected = self.expected.clone();
        Box::pin(async move {
            match expected {
                None => inner.call(req).await,
                Some(expected) => match req.source.token.as_deref() {
                    Some(presented) if constant_time_eq(presented, &expected) => {
                        inner.call(req).await
                    }
                    _ => Err(RelayError::Unauthorized),
                },
            }
        })
    }
}

/// Serve only the configured app scopes; serve everything when none are
/// configured. A scope is a public string chosen by the app, so without this
/// every client may write to every namespace - with it, an operator hosts one
/// community's relay and nothing else.
#[derive(Clone, Default)]
pub struct AllowScopesLayer {
    allowed: Option<Arc<Vec<String>>>,
}

impl AllowScopesLayer {
    pub fn new(allowed: Vec<String>) -> Self {
        Self {
            allowed: if allowed.is_empty() {
                None
            } else {
                Some(Arc::new(allowed))
            },
        }
    }
}

impl<S> Layer<S> for AllowScopesLayer {
    type Service = AllowScopes<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AllowScopes {
            inner,
            allowed: self.allowed.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AllowScopes<S> {
    inner: S,
    allowed: Option<Arc<Vec<String>>>,
}

impl<S> Service<RelayRequest> for AllowScopes<S>
where
    S: Service<RelayRequest, Response = RelayResponse, Error = RelayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = RelayResponse;
    type Error = RelayError;
    type Future = BoxFuture<Result<RelayResponse, RelayError>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: RelayRequest) -> Self::Future {
        let mut inner = self.inner.clone();
        let allowed = self.allowed.clone();
        Box::pin(async move {
            match allowed {
                None => inner.call(req).await,
                Some(allowed) => {
                    let scope = req.op.coord().app_scope.clone();
                    if allowed.iter().any(|s| *s == scope) {
                        inner.call(req).await
                    } else {
                        Err(RelayError::ScopeNotServed(scope))
                    }
                }
            }
        })
    }
}

/// A per-source sliding-window budget when configured; unlimited when not.
/// Honest usage is one publish and one fetch per epoch; anything far above that
/// is abuse, not use. Kept here rather than at the proxy so the relay can say WHY
/// it refused, and so a self-hoster with no proxy still has a limit.
#[derive(Clone, Default)]
pub struct RateLimitLayer {
    cfg: Option<(usize, Duration)>,
    hits: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
}

impl RateLimitLayer {
    pub fn new(max_requests: usize, window: Duration) -> Self {
        Self {
            cfg: if max_requests == 0 {
                None
            } else {
                Some((max_requests, window))
            },
            hits: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimit<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimit {
            inner,
            cfg: self.cfg,
            hits: Arc::clone(&self.hits),
        }
    }
}

#[derive(Clone)]
pub struct RateLimit<S> {
    inner: S,
    cfg: Option<(usize, Duration)>,
    hits: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
}

impl<S> Service<RelayRequest> for RateLimit<S>
where
    S: Service<RelayRequest, Response = RelayResponse, Error = RelayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = RelayResponse;
    type Error = RelayError;
    type Future = BoxFuture<Result<RelayResponse, RelayError>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: RelayRequest) -> Self::Future {
        let mut inner = self.inner.clone();
        let cfg = self.cfg;
        let hits = Arc::clone(&self.hits);
        Box::pin(async move {
            if let Some((limit, window)) = cfg {
                let now = Instant::now();
                let mut guard = hits.lock();
                let window_hits = guard.entry(req.source.ip).or_default();
                window_hits.retain(|t| now.duration_since(*t) < window);
                if window_hits.len() >= limit {
                    return Err(RelayError::RateLimited {
                        limit,
                        window_seconds: window.as_secs(),
                    });
                }
                window_hits.push(now);
            }
            inner.call(req).await
        })
    }
}

/// One line per call, carrying the operation and outcome but never a coordinate:
/// writing `(app_scope, epoch)` to disk would build the index the protocol
/// refuses to keep, and the operator already sees those fields on the wire.
#[derive(Clone, Default)]
pub struct ObserveLayer;

impl<S> Layer<S> for ObserveLayer {
    type Service = Observe<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Observe { inner }
    }
}

#[derive(Clone)]
pub struct Observe<S> {
    inner: S,
}

impl<S> Service<RelayRequest> for Observe<S>
where
    S: Service<RelayRequest, Response = RelayResponse, Error = RelayError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = RelayResponse;
    type Error = RelayError;
    type Future = BoxFuture<Result<RelayResponse, RelayError>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: RelayRequest) -> Self::Future {
        let mut inner = self.inner.clone();
        let method = req.op.method();
        Box::pin(async move {
            let started = Instant::now();
            let result = inner.call(req).await;
            let millis = started.elapsed().as_millis();
            match &result {
                Ok(_) => eprintln!("minirelay: {method} ok in {millis}ms"),
                Err(e) => eprintln!("minirelay: {method} refused ({e:?}) in {millis}ms"),
            }
            result
        })
    }
}

/// The composed stack, as a NAMEABLE type - which is the point: axum's state must
/// be `Sync`, and tower's boxed services are only `Send`.
pub type RelayService = Observe<RequireToken<AllowScopes<RateLimit<StoreService>>>>;

/// Compare without leaking the compared length or an early-exit position. A relay
/// token is not a high-value secret, but a layer that compares secrets should not
/// teach a bad habit.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().min(b.len());
    for i in 0..n {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use tower::{ServiceBuilder, ServiceExt};

    use super::*;

    fn store() -> Arc<Store> {
        Arc::new(Store::open(":memory:", 1000, 3600).unwrap())
    }

    fn coord(scope: &str) -> Coord {
        Coord {
            app_scope: scope.to_string(),
            epoch: 1,
            shard: String::new(),
        }
    }

    fn put(scope: &str) -> RelayRequest {
        RelayRequest {
            op: Op::Put {
                coord: coord(scope),
                entries: vec![Entry {
                    tag: vec![1; 16],
                    blob: vec![2; 64],
                }],
            },
            source: Source {
                ip: "127.0.0.1".parse().unwrap(),
                token: None,
            },
        }
    }

    fn with_token(mut req: RelayRequest, token: &str) -> RelayRequest {
        req.source.token = Some(token.to_string());
        req
    }

    #[tokio::test]
    async fn the_base_service_stores_and_reads() {
        let store = store();
        let mut service = StoreService::new(Arc::clone(&store));

        assert!(matches!(
            service
                .ready()
                .await
                .unwrap()
                .call(put("poker"))
                .await
                .unwrap(),
            RelayResponse::Stored { held: 1 }
        ));
        let got = service
            .ready()
            .await
            .unwrap()
            .call(RelayRequest {
                op: Op::Get { coord: coord("poker") },
                source: put("poker").source,
            })
            .await
            .unwrap();
        match got {
            RelayResponse::Entries(entries) => assert_eq!(entries.len(), 1),
            other => panic!("expected entries, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unconfigured_layers_pass_through() {
        // The stack never changes shape, so "policy off" is a no-op, not a
        // different composition.
        let service = ServiceBuilder::new()
            .layer(ObserveLayer)
            .layer(RequireTokenLayer::new(None))
            .layer(AllowScopesLayer::new(Vec::new()))
            .layer(RateLimitLayer::new(0, Duration::from_secs(60)))
            .service(StoreService::new(store()));

        assert!(service.clone().oneshot(put("anything")).await.is_ok());
        assert!(service
            .clone()
            .oneshot(put("anything"))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn layers_apply_outermost_first() {
        // ServiceBuilder applies in the order listed: the first layer is the
        // outermost, the same rule as TS `compose` and the extension's filters.
        let service = ServiceBuilder::new()
            .layer(RequireTokenLayer::new(Some("s3cret".into())))
            .layer(AllowScopesLayer::new(vec!["poker".into()]))
            .service(StoreService::new(store()));

        // No token: the OUTER layer refuses before the scope layer is consulted.
        assert!(matches!(
            service.clone().oneshot(put("elsewhere")).await,
            Err(RelayError::Unauthorized)
        ));
        // With a token, the inner layer's refusal is the one that surfaces.
        assert!(matches!(
            service
                .clone()
                .oneshot(with_token(put("elsewhere"), "s3cret"))
                .await,
            Err(RelayError::ScopeNotServed(_))
        ));
        assert!(service
            .oneshot(with_token(put("poker"), "s3cret"))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn require_token_refuses_missing_and_wrong_tokens() {
        let service = ServiceBuilder::new()
            .layer(RequireTokenLayer::new(Some("s3cret".into())))
            .service(StoreService::new(store()));

        assert!(matches!(
            service.clone().oneshot(put("poker")).await,
            Err(RelayError::Unauthorized)
        ));
        assert!(matches!(
            service
                .clone()
                .oneshot(with_token(put("poker"), "nope"))
                .await,
            Err(RelayError::Unauthorized)
        ));
        assert!(service
            .oneshot(with_token(put("poker"), "s3cret"))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn allow_scopes_serves_the_listed_namespace_only() {
        let service = ServiceBuilder::new()
            .layer(AllowScopesLayer::new(vec!["poker".into()]))
            .service(StoreService::new(store()));

        assert!(service.clone().oneshot(put("poker")).await.is_ok());
        match service.oneshot(put("somewhere-else")).await {
            Err(RelayError::ScopeNotServed(scope)) => assert_eq!(scope, "somewhere-else"),
            other => panic!("expected the scope refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rate_limit_counts_per_source_and_lets_windows_expire() {
        let service = ServiceBuilder::new()
            .layer(RateLimitLayer::new(2, Duration::from_millis(50)))
            .service(StoreService::new(store()));

        assert!(service.clone().oneshot(put("poker")).await.is_ok());
        assert!(service.clone().oneshot(put("poker")).await.is_ok());
        match service.clone().oneshot(put("poker")).await {
            Err(RelayError::RateLimited { limit, .. }) => assert_eq!(limit, 2),
            other => panic!("expected the budget to run out, got {other:?}"),
        }

        std::thread::sleep(Duration::from_millis(60));
        assert!(
            service.oneshot(put("poker")).await.is_ok(),
            "the window should have drained"
        );
    }

    #[tokio::test]
    async fn rate_limit_is_per_source_not_global() {
        let service = ServiceBuilder::new()
            .layer(RateLimitLayer::new(1, Duration::from_secs(60)))
            .service(StoreService::new(store()));

        assert!(service.clone().oneshot(put("poker")).await.is_ok());
        let mut other = put("poker");
        other.source.ip = "10.0.0.2".parse().unwrap();
        assert!(
            service.oneshot(other).await.is_ok(),
            "another source has its own budget"
        );
    }

    #[tokio::test]
    async fn layers_do_not_replace_the_store() {
        // the whole point: policy wraps the I/O leaf, it never becomes one
        let store = store();
        let service = ServiceBuilder::new()
            .layer(RequireTokenLayer::new(Some("t".into())))
            .service(StoreService::new(Arc::clone(&store)));

        service
            .oneshot(with_token(put("poker"), "t"))
            .await
            .unwrap();
        assert_eq!(store.count().unwrap(), 1);
    }
}