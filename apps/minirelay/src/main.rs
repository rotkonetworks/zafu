//! The binary: configuration, retention sweep, listener. All behaviour lives in
//! the library so the wire contract can be tested without a socket.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use minirelay::config::Config;
use minirelay::server::{app, AppState};
use minirelay::store::Store;
use minirelay::strategy;

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    let store = match Store::open(
        &config.db_path,
        config.max_entries_per_coord,
        config.retention_seconds,
    ) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("minirelay: cannot open {}: {e}", config.db_path);
            std::process::exit(1);
        }
    };

    // Retention sweep: the only thing that keeps storage bounded, and the reason a
    // relay is not also an archive of who was online when.
    let gc_store = Arc::clone(&store);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            ticker.tick().await;
            match gc_store.gc() {
                Ok(0) => {}
                Ok(n) => eprintln!("minirelay: retention dropped {n} entries"),
                Err(e) => eprintln!("minirelay: retention failed: {e}"),
            }
        }
    });

    // Policy is a strategy: a named, pre-composed stack of filters around the one
    // base service. Nothing below this line knows what the stack contains.
    let (service, enforced) = strategy::build(&config, store);
    eprintln!(
        "minirelay: policy {:?} (entries/put {}, entries/coordinate {}, retention {}s)",
        enforced.layers,
        enforced.max_entries_per_put,
        enforced.max_entries_per_coord,
        enforced.retention_seconds
    );

    let router = app(AppState {
        service,
        max_entries_per_put: config.max_entries_per_put,
        max_body_bytes: config.max_body_bytes,
    });

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("minirelay: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "minirelay: listening on {addr} (db {}, retention {}s, cap {}/coordinate, origin {})",
        config.db_path, config.retention_seconds, config.max_entries_per_coord, config.allow_origin
    );

    // Connect info so a policy filter can do per-source rate limiting; without it
    // every request would look like it came from the same address.
    if let Err(e) = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
    .await
    {
        eprintln!("minirelay: server error: {e}");
        std::process::exit(1);
    }
}