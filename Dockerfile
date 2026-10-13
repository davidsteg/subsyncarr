# === Frontend ===
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# === Backend (the UI is embedded into the binary) ===
FROM rust:1-bookworm AS server
WORKDIR /src
# Cache dependency builds separately from the source.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
    && mkdir -p web/dist && echo '<!doctype html>' > web/dist/index.html \
    && cargo build --release && rm -rf src web
COPY build.rs CHANGELOG.md ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN touch src/main.rs src/lib.rs && cargo build --release

# === Python sync engines, built against the runtime's own Python ===
FROM debian:bookworm-slim AS engines
ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/opt/pipx/bin
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv pipx build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*
RUN pipx install ffsubsync \
    && pipx inject ffsubsync 'setuptools<82' \
    && pipx install autosubsync \
    && pipx inject autosubsync 'setuptools<82' \
    && find /opt/pipx -type f -name "*.pyc" -delete \
    && find /opt/pipx -type d -name "__pycache__" -prune -exec rm -rf {} +

# === Runtime ===
FROM debian:bookworm-slim

ENV PUID=1000 \
    PGID=1000 \
    CRON_SCHEDULE="0 0 * * *" \
    DB_PATH=/app/data/subsyncarr-plus.db \
    PATH="/opt/pipx/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && dpkgArch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/tianon/gosu/releases/download/1.17/gosu-$dpkgArch" -o /usr/local/bin/gosu \
    && chmod +x /usr/local/bin/gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 subsyncarr \
    && useradd -m -u 1000 -g 1000 -s /bin/bash subsyncarr \
    && mkdir -p /app/data && chown subsyncarr:subsyncarr /app/data

COPY --chmod=755 bin/alass /usr/local/bin/alass
COPY --from=engines /opt/pipx /opt/pipx
COPY --from=server /src/target/release/subsyncarr /usr/local/bin/subsyncarr
COPY --chmod=755 entrypoint.sh /entrypoint.sh

WORKDIR /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["subsyncarr"]
