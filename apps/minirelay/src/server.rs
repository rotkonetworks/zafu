//! Router, handlers and middleware - everything the wire contract touches.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::store::{Coord, Entry, Store, StoreError};

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
    pub store: Arc<Store>,
    pub max_entries_per_put: usize,
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

fn store_failure(context: &str, e: impl std::fmt::Display) -> Response {
    // The log line carries no coordinates: see `observe`.
    eprintln!("minirelay: {context} failed: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { error: "store failure".into() }))
        .into_response()
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

// -- handlers -----------------------------------------------------------------

/// Merge a padded batch into its coordinate. Never replaces the coordinate: one
/// coordinate holds one batch per publisher, so a replace would drop everyone
/// but the last writer (see `store.rs`).
async fn put_bucket(State(state): State<AppState>, body: Bytes) -> Response {
    let req: PutRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(format!("malformed JSON body: {e}")),
    };
    if let Err(res) = coord_is_sane(&req.app_scope, &req.shard) {
        return res;
    }
    if req.entries.len() > state.max_entries_per_put {
        // A whole padded batch arrives in one request; splitting it would change
        // the write shape and leak the friend count the padding hides. Too many
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
    match state.store.put(&coord, &entries) {
        Ok(_held) => StatusCode::NO_CONTENT.into_response(),
        Err(StoreError::TooManyEntries { held, incoming }) => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorBody {
                error: format!(
                    "coordinate holds {held} entries; adding {incoming} would pass the cap"
                ),
            }),
        )
            .into_response(),
        Err(e) => store_failure("put", e),
    }
}

/// The WHOLE coordinate, or an empty list when nothing is published. There is no
/// per-tag route: an operator who could answer "give me this tag" would learn
/// which tags a client cares about and could rebuild graph edges.
async fn get_bucket(State(state): State<AppState>, Query(coord): Query<GetQuery>) -> Response {
    if let Err(res) = coord_is_sane(&coord.app_scope, &coord.shard) {
        return res;
    }
    let c = Coord {
        app_scope: coord.app_scope,
        epoch: coord.epoch,
        shard: coord.shard,
    };
    match state.store.get(&c) {
        Ok(entries) => Json(GetResponse {
            entries: entries
                .into_iter()
                .map(|e| GetEntry {
                    tag: B64.encode(e.tag),
                    blob: B64.encode(e.blob),
                })
                .collect(),
        })
        .into_response(),
        Err(e) => store_failure("get", e),
    }
}

pub async fn health() -> &'static str {
    "ok"
}

async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

// -- middleware ---------------------------------------------------------------

/// CORS for browser clients, plus a log line that carries no coordinates.
///
/// The log omits the query string on purpose: writing `(app_scope, epoch)` to
/// disk would build exactly the index the protocol refuses to keep, and the
/// operator already sees those fields on the wire anyway. Bodies are never
/// logged.
async fn observe(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = Instant::now();

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
        HeaderValue::from_static("content-type"),
    );
    res.headers_mut()
        .insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));

    eprintln!(
        "{method} {path} -> {} in {}ms",
        res.status().as_u16(),
        started.elapsed().as_millis()
    );
    res
}

// -- wiring -------------------------------------------------------------------

pub fn app(state: AppState, max_body_bytes: usize) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/bucket", post(put_bucket).get(get_bucket).options(preflight))
        .fallback(any(|| async { StatusCode::NOT_FOUND }))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .layer(middleware::from_fn(observe))
        .with_state(state)
}