//! Named strategies: the one stack of layers this configuration asks for.
//!
//! The pattern doc is explicit that callers bind to a *strategy*, not to a pile
//! of filters they can reorder into combinations nobody tested. Here that means
//! the operator turns policy on through configuration, and this stacks the
//! matching layers - bare when nothing is configured, gated when the operator has
//! claimed a namespace.
//!
//! The stack SHAPE never changes: every layer is present and no-ops when its
//! configuration is absent. That keeps `RelayService` a concrete type (axum's
//! `State` must be `Sync`, and tower's boxed services are only `Send`) and makes
//! "policy off" a no-op rather than a different composition.

use std::sync::Arc;
use std::time::Duration;

use tower::ServiceBuilder;

use crate::config::Config;
use crate::service::{
    AllowScopesLayer, ObserveLayer, RateLimitLayer, RelayService, RequireTokenLayer, StoreService,
};
use crate::store::Store;

/// What the running relay is actually enforcing, for the startup log - so an
/// operator can see the policy that took effect instead of inferring it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enforced {
    /// every layer in the stack, outermost first
    pub layers: Vec<&'static str>,
    pub max_entries_per_put: usize,
    pub retention_seconds: i64,
    pub max_entries_per_coord: i64,
}

/// Build the service for this configuration.
///
/// Layer order is application order in `ServiceBuilder`, so `ObserveLayer` is
/// outermost and measures everything below it, then the policy layers, then the
/// store. There is no ordering to guess at: this is the strategy.
pub fn build(config: &Config, store: Arc<Store>) -> (RelayService, Enforced) {
    let mut names: Vec<&'static str> = vec!["observe"];
    if config.token.is_some() {
        names.push("require_token");
    }
    if !config.allowed_scopes.is_empty() {
        names.push("allow_scopes");
    }
    if config.rate_limit_per_minute > 0 {
        names.push("rate_limit");
    }

    let service = ServiceBuilder::new()
        .layer(ObserveLayer)
        .layer(RequireTokenLayer::new(config.token.clone()))
        .layer(AllowScopesLayer::new(config.allowed_scopes.clone()))
        .layer(RateLimitLayer::new(
            config.rate_limit_per_minute,
            Duration::from_secs(60),
        ))
        .service(StoreService::new(store));

    let enforced = Enforced {
        layers: names,
        max_entries_per_put: config.max_entries_per_put,
        retention_seconds: config.retention_seconds,
        max_entries_per_coord: config.max_entries_per_coord,
    };
    (service, enforced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            port: 0,
            db_path: ":memory:".into(),
            max_entries_per_coord: 1000,
            retention_seconds: 3600,
            max_entries_per_put: 64,
            max_body_bytes: 1024,
            allow_origin: "*".into(),
            token: None,
            allowed_scopes: Vec::new(),
            rate_limit_per_minute: 0,
        }
    }

    fn store() -> Arc<Store> {
        Arc::new(Store::open(":memory:", 1000, 3600).unwrap())
    }

    #[test]
    fn an_unconfigured_relay_reports_only_observation() {
        let (_, enforced) = build(&config(), store());
        assert_eq!(enforced.layers, vec!["observe"]);
    }

    #[test]
    fn configured_policy_reports_every_active_layer_in_order() {
        let mut c = config();
        c.token = Some("t".into());
        c.allowed_scopes = vec!["poker".into()];
        c.rate_limit_per_minute = 120;

        let (_, enforced) = build(&c, store());
        assert_eq!(
            enforced.layers,
            vec!["observe", "require_token", "allow_scopes", "rate_limit"],
            "the stack is a strategy: same order every time, not a set"
        );
    }
}