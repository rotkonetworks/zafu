# Build stage. rusqlite is used with the `bundled` feature, so SQLite itself is
# compiled here and the runtime image needs no libsqlite3.
FROM rust:1-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

# Runtime stage. Nothing but the binary and a writable data directory.
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --create-home minirelay \
 && mkdir -p /data \
 && chown minirelay /data
COPY --from=build /src/target/release/minirelay /usr/local/bin/minirelay
USER minirelay
ENV MINIRELAY_DB=/data/minirelay.sqlite
ENV MINIRELAY_PORT=8080
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/minirelay"]