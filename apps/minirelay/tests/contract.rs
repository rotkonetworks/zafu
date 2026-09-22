//! The wire contract, exercised over HTTP. These are the properties a client
//! depends on, so they are tested against the router rather than the store.
//!
//! The two that matter most are `two_publishers_share_a_coordinate` (a replacing
//! relay passes every single-publisher test and still breaks discovery) and
//! `there_is_no_per_tag_route` (the invariant that keeps the operator from
//! learning edges).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use http_body_util::BodyExt;
use minirelay::server::{app, AppState};
use minirelay::store::Store;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app_with(store: Store, max_entries_per_put: usize, max_body: usize) -> axum::Router {
    app(
        AppState {
            store: Arc::new(store),
            max_entries_per_put,
        },
        max_body,
    )
}

fn fresh(cap: i64, max_per_put: usize) -> axum::Router {
    app_with(Store::open(":memory:", cap, 3600).unwrap(), max_per_put, 8 * 1024 * 1024)
}

async fn send(router: &axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn put_request(app_scope: &str, epoch: i64, entries: &[(u8, u8)]) -> Request<Body> {
    let body = json!({
        "appScope": app_scope,
        "epoch": epoch,
        "shard": "",
        "entries": entries
            .iter()
            .map(|(tag, blob)| json!({ "tag": B64.encode([*tag; 16]), "blob": B64.encode([*blob; 64]) }))
            .collect::<Vec<_>>(),
    });
    Request::builder()
        .method("POST")
        .uri("/bucket")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn get_request(app_scope: &str, epoch: i64) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(format!("/bucket?appScope={app_scope}&epoch={epoch}&shard="))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn publish_then_fetch_round_trips_the_bytes() {
    let router = fresh(1000, 4096);
    let (status, _) = send(&router, put_request("poker", 100, &[(1, 7)])).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = send(&router, get_request("poker", 100)).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["entries"].as_array().expect("entries array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["tag"], B64.encode([1u8; 16]));
    assert_eq!(entries[0]["blob"], B64.encode([7u8; 64]));
}

#[tokio::test]
async fn two_publishers_share_a_coordinate() {
    let router = fresh(1000, 4096);
    send(&router, put_request("poker", 100, &[(1, 1)])).await;
    send(&router, put_request("poker", 100, &[(2, 2)])).await;

    let (_, body) = send(&router, get_request("poker", 100)).await;
    assert_eq!(
        body["entries"].as_array().unwrap().len(),
        2,
        "a replacing relay would have dropped the first publisher"
    );
}

#[tokio::test]
async fn an_unknown_coordinate_is_empty_not_an_error() {
    let router = fresh(1000, 4096);
    let (status, body) = send(&router, get_request("nobody", 100)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn other_coordinates_and_app_scopes_stay_isolated() {
    let router = fresh(1000, 4096);
    send(&router, put_request("poker", 100, &[(1, 1)])).await;
    send(&router, put_request("poker", 101, &[(2, 2)])).await;
    send(&router, put_request("notes", 100, &[(3, 3)])).await;

    let (_, other_epoch) = send(&router, get_request("poker", 101)).await;
    assert_eq!(other_epoch["entries"][0]["tag"], B64.encode([2u8; 16]));

    let (_, other_scope) = send(&router, get_request("notes", 100)).await;
    assert_eq!(other_scope["entries"][0]["tag"], B64.encode([3u8; 16]));
}

#[tokio::test]
async fn there_is_no_per_tag_route() {
    // The invariant: a relay that could answer "give me this tag" would let its
    // operator watch which tags a client asks for and rebuild graph edges.
    let router = fresh(1000, 4096);
    send(&router, put_request("poker", 100, &[(1, 1)])).await;
    let tag = B64.encode([1u8; 16]);
    let req = Request::builder()
        .method("GET")
        .uri(format!("/bucket/{tag}"))
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(&router, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejects_malformed_requests() {
    let router = fresh(1000, 4096);

    let not_json = Request::builder()
        .method("POST")
        .uri("/bucket")
        .header("content-type", "application/json")
        .body(Body::from("not json at all"))
        .unwrap();
    assert_eq!(send(&router, not_json).await.0, StatusCode::BAD_REQUEST);

    let bad_b64 = Request::builder()
        .method("POST")
        .uri("/bucket")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "appScope": "poker", "epoch": 1, "entries": [{ "tag": "!!", "blob": "AA==" }] })
                .to_string(),
        ))
        .unwrap();
    assert_eq!(send(&router, bad_b64).await.0, StatusCode::BAD_REQUEST);

    let short_tag = Request::builder()
        .method("POST")
        .uri("/bucket")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "appScope": "poker", "epoch": 1, "entries": [{ "tag": B64.encode([1u8; 4]), "blob": B64.encode([1u8; 64]) }] })
                .to_string(),
        ))
        .unwrap();
    assert_eq!(send(&router, short_tag).await.0, StatusCode::BAD_REQUEST);

    let empty_scope = Request::builder()
        .method("POST")
        .uri("/bucket")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "appScope": "", "epoch": 1, "entries": [] }).to_string(),
        ))
        .unwrap();
    assert_eq!(send(&router, empty_scope).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn refuses_more_entries_in_one_request_than_the_protocol_uses() {
    // A conforming client sends one padded batch (64 entries); more means the
    // caller is not one, so it is a client error rather than a storage decision.
    let router = fresh(1000, 64);
    let entries: Vec<(u8, u8)> = (0..65u8).map(|i| (i, i)).collect();
    let (status, body) = send(&router, put_request("poker", 100, &entries)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("at most 64"));
}

#[tokio::test]
async fn refuses_growth_past_the_coordinate_cap() {
    let router = fresh(2, 4096);
    send(&router, put_request("poker", 100, &[(1, 1), (2, 2)])).await;
    // a retry of existing tags is not growth
    let (status, _) = send(&router, put_request("poker", 100, &[(1, 9)])).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // a new tag past the cap is refused
    let (status, _) = send(&router, put_request("poker", 100, &[(3, 3)])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn health_answers() {
    let router = fresh(1000, 4096);
    let req = Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn cors_preflight_is_allowed() {
    // Browser clients POST JSON, which always preflights.
    let router = fresh(1000, 4096);
    let req = Request::builder()
        .method("OPTIONS")
        .uri("/bucket")
        .header("origin", "https://poker.example")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        res.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("*")
    );
}