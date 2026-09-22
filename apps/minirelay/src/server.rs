//! Router and handlers - the HTTP edge.
//!
//! The edge does exactly two things: turn an HTTP request into a
//! [`RelayRequest`] (parsing, base64, shape checks - protocol concerns), and turn
//! a [`RelayResponse`] or [`RelayError`] back into a status code (transport
//! concerns). Policy lives in filters (`service.rs`), storage lives in
//! `store.rs`, and neither knows about HTTP.


use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use std::net::SocketAddr;

use crate::service::{Op, RelayError, RelayRequest, RelayResponse, RelayService, Source};
use crate::store::{Coord, Entry};

/// Tag and blob shapes are only bounded, never interpreted: the protocol's own
/// constants live on the clients, and this store must not become the place that
/// decides what a tag may be.
const TAG_MIN_BYTES: usize = 16;
const TAG_MAX_BYTES: usize = 64;
const BLOB_MAX_BYTES: usize = 4096;
const SCOPE_MAX_CHARS: usize = 256;
const SHARD_MAX_CHARS: usize = 128;

#[derive(Clone)]
pub struct AppState {
    pub service: RelayService,
    pub max_entries_per_put: usize,
    pub max_body_bytes: usize,
}

// -- wire types ---------------------------------------------------------------

#[derive(Deserialize)]
struct PutEntry {
    tag: String,
    blob: String,
}

/// The coordinate travels in the BODY for a write, matching the client
/// (`createHttpRelayTransport`): `{ appScope, epoch, shard, entries }`.
#[derive(Deserialize)]
struct PutRequest {
    #[serde(rename = "appScope")]
    app_scope: String,
    epoch: i64,
    #[serde(default)]
    shard: String,
    entries: Vec<PutEntry>,
}

/// ...and in the QUERY for a read, matching the client too.
#[derive(Deserialize)]
struct GetQuery {
    #[serde(rename = "appScope")]
    app_scope: String,
    epoch: i64,
    #[serde(default)]
    shard: String,
}

#[derive(Serialize)]
struct GetEntry {
    tag: String,
    blob: String,
}

#[derive(Serialize)]
struct GetResponse {
    entries: Vec<GetEntry>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

fn bad_request(message: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, Json(ErrorBody { error: message.into() })).into_response()
}

fn coord_is_sane(app_scope: &str, shard: &str) -> Result<(), Response> {
    if app_scope.is_empty() || app_scope.chars().count() > SCOPE_MAX_CHARS {
        return Err(bad_request("appScope must be 1..=256 characters"));
    }
    if shard.chars().count() > SHARD_MAX_CHARS {
        return Err(bad_request("shard must be at most 128 characters"));
    }
    Ok(())
}

/// What a policy filter is allowed to know about the caller. The IP comes from
/// the socket (absent in in-process tests), the token from the header.
fn source_of(req: &Request, peer: ConnectInfo<SocketAddr>) -> Source {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    Source {
        ip: peer.0.ip(),
        token,
    }
}

/// A refusal from the stack, as HTTP. The mapping is the only place that knows
/// both worlds.
fn refusal(e: RelayError) -> Response {
    match e {
        RelayError::Unauthorized => (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"))],
            Json(ErrorBody {
                error: "a bearer token is required for this relay".into(),
            }),
        )
            .into_response(),
        RelayError::ScopeNotServed(scope) => (
            StatusCode::FORBIDDEN,
            Json(ErrorBody {
                error: format!("this relay does not serve the scope {scope:?}"),
            }),
        )
            .into_response(),
        RelayError::RateLimited {
            limit,
            window_seconds,
        } => (
            StatusCode::TOO_MANY_REQUESTS,
            [(
                header::RETRY_AFTER,
                HeaderValue::from_str(&window_seconds.to_string())
                    .unwrap_or(HeaderValue::from_static("60")),
            )],
            Json(ErrorBody {
                error: format!("at most {limit} requests per {window_seconds}s from this source"),
            }),
        )
            .into_response(),
        RelayError::CoordinateFull { held, incoming } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorBody {
                error: format!(
                    "coordinate holds {held} entries; adding {incoming} would pass the cap"
                ),
            }),
        )
            .into_response(),
        RelayError::Store(e) => {
            // No coordinates in the log: see the note on the service's observe filter.
            eprintln!("minirelay: store failure: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "store failure".into(),
                }),
            )
                .into_response()
        }
    }
}

// -- handlers -----------------------------------------------------------------

/// Merge a padded batch into its coordinate. The stack decides whether this
/// caller may; the base service never replaces a coordinate (see `store.rs`),
/// because one coordinate holds one batch per publisher.
async fn put_bucket(
    State(state): State<AppState>,
    peer: ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    let source = source_of(&request, peer);
    let body: Bytes = match axum::body::to_bytes(request.into_body(), state.max_body_bytes).await {
        Ok(b) => b,
        Err(_) => return bad_request("body too large"),
    };

    let req: PutRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(format!("malformed JSON body: {e}")),
    };
    if let Err(res) = coord_is_sane(&req.app_scope, &req.shard) {
        return res;
    }
    if req.entries.len() > state.max_entries_per_put {
        // A whole padded batch arrives in one request; splitting it would change
        // the write shape and leak the friend count the padding hides. More
        // entries means the caller is not a conforming client.
        return bad_request(format!(
            "at most {} entries per request, got {}",
            state.max_entries_per_put,
            req.entries.len()
        ));
    }

    let mut entries = Vec::with_capacity(req.entries.len());
    for e in &req.entries {
        let tag = match B64.decode(&e.tag) {
            Ok(t) => t,
            Err(_) => return bad_request("tag is not base64"),
        };
        let blob = match B64.decode(&e.blob) {
            Ok(b) => b,
            Err(_) => return bad_request("blob is not base64"),
        };
        if tag.len() < TAG_MIN_BYTES || tag.len() > TAG_MAX_BYTES {
            return bad_request("tag length out of range");
        }
        if blob.is_empty() || blob.len() > BLOB_MAX_BYTES {
            return bad_request("blob length out of range");
        }
        entries.push(Entry { tag, blob });
    }

    let coord = Coord {
        app_scope: req.app_scope,
        epoch: req.epoch,
        shard: req.shard,
    };
    match service_call(&state.service, Op::Put { coord, entries }, source).await {
        Ok(RelayResponse::Stored { .. }) => StatusCode::NO_CONTENT.into_response(),
        Ok(other) => {
            eprintln!("minirelay: unexpected response for a write: {other:?}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => refusal(e),
    }
}

/// The WHOLE coordinate, or an empty list when nothing is published. There is no
/// per-tag route: an operator who could answer "give me this tag" would learn
/// which tags a client cares about and could rebuild graph edges.
async fn get_bucket(
    State(state): State<AppState>,
    peer: ConnectInfo<SocketAddr>,
    Query(coord): Query<GetQuery>,
    request: Request,
) -> Response {
    let source = source_of(&request, peer);
    if let Err(res) = coord_is_sane(&coord.app_scope, &coord.shard) {
        return res;
    }
    let c = Coord {
        app_scope: coord.app_scope,
        epoch: coord.epoch,
        shard: coord.shard,
    };
    match service_call(&state.service, Op::Get { coord: c }, source).await {
        Ok(RelayResponse::Entries(entries)) => Json(GetResponse {
            entries: entries
                .into_iter()
                .map(|e| GetEntry {
                    tag: B64.encode(e.tag),
                    blob: B64.encode(e.blob),
                })
                .collect(),
        })
        .into_response(),
        Ok(other) => {
            eprintln!("minirelay: unexpected response for a read: {other:?}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => refusal(e),
    }
}

/// One call through the composed stack. Cloning a service is how tower is driven:
/// a `Service` is `&mut self`, so each request takes its own handle.
async fn service_call(
    service: &RelayService,
    op: Op,
    source: Source,
) -> Result<RelayResponse, RelayError> {
    use tower::ServiceExt;
    service.clone().oneshot(RelayRequest { op, source }).await
}

pub async fn health() -> &'static str {
    "ok"
}

async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

// -- middleware ---------------------------------------------------------------

/// CORS for browser clients. Logging is not here: the service's `observe` filter
/// owns it, so what gets logged is a policy decision rather than an HTTP one.
async fn cors(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;

    let allow = std::env::var("MINIRELAY_ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string());
    if let Ok(value) = HeaderValue::from_str(&allow) {
        res.headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    res.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    res.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization"),
    );
    res.headers_mut()
        .insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    res
}

// -- wiring -------------------------------------------------------------------

pub fn app(state: AppState) -> Router {
    let max_body_bytes = state.max_body_bytes;
    Router::new()
        .route("/health", get(health))
        .route(
            "/bucket",
            post(put_bucket).get(get_bucket).options(preflight),
        )
        .fallback(any(|| async { StatusCode::NOT_FOUND }))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}