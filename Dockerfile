# syntax=docker/dockerfile:1

# --- Builder: build the web UI, bundle it into the server, compile the CLI ---
FROM oven/bun:1.4.2 AS builder
WORKDIR /build

COPY web/package.json web/bun.lock ./web/
COPY web/ ./web/
RUN cd web && bun install --frozen-lockfile && bun run build

COPY server/package.json server/bun.lock ./server/
COPY server/ ./server/
RUN cd server && bun install --frozen-lockfile && bun run build:ui && bun run build:cli

# --- Runtime: self-contained compiled CLI + embedded UI, no build deps ---
FROM oven/bun:1.4.2
WORKDIR /app

COPY --from=builder /build/server/dist ./dist
COPY --from=builder /build/server/ui ./ui

RUN mkdir -p /data

ENV ALMADEL_HOST=0.0.0.0 \
    ALMADEL_DB=/data/almadel.db \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 1213

ENTRYPOINT ["bun", "dist/cli.js", "serve"]
