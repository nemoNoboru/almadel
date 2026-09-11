#!/usr/bin/env bash
#
# Full end-to-end test: Almadel server + opencode plugin (real model) + Playwright.
#
# Spins up a real almadel server, a real opencode instance (with the almadel
# plugin bundled in and a real model configured), enlists the agent, then drives
# the web UI with Playwright to push a dummy feature through the board and
# verifies the agent actually produced the artifact in a throwaway git repo.
#
# LOCAL ONLY — not for CI. Requires: bun, git, curl, python3, ~/.opencode/bin/opencode
# (with a model + auth configured) and Playwright chromium (bundled via the
# e2e/ package.json). Model defaults to deepseek/deepseek-v4-flash.
#
# Overridable env:
#   ALMADEL_E2E_MODEL          model id passed to opencode (default deepseek/deepseek-v4-flash)
#   ALMADEL_E2E_OPENCODE_VERSION  version reported to almadel (default 1.18.30)
#   ALMADEL_E2E_SERVER_PORT    almadel server port (default 18840)
#   ALMADEL_E2E_OPENCODE_PORT  opencode port (default 18841)
#   ALMADEL_E2E_DIR            work dir; leave set to inspect artifacts after a run
#   ALMADEL_E2E_SKIP_BUILD      skip web/plugin rebuild (faster iteration)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
SERVER_DIR="$ROOT/server"
WEB_DIR="$ROOT/web"
PLUGIN_DIR="$ROOT/plugin"

MODEL="${ALMADEL_E2E_MODEL:-deepseek/deepseek-v4-flash}"
OPENCODE_VERSION="${ALMADEL_E2E_OPENCODE_VERSION:-1.18.30}"
SERVER_PORT="${ALMADEL_E2E_SERVER_PORT:-18840}"
OPENCODE_PORT="${ALMADEL_E2E_OPENCODE_PORT:-18841}"
PROJECT="almadel-api"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
OPENCODE_URL="http://127.0.0.1:$OPENCODE_PORT"

OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode 2>/dev/null || echo "$HOME/.opencode/bin/opencode")}"

WORK_DIR="${ALMADEL_E2E_DIR:-$(mktemp -d /tmp/almadel-e2e.XXXXXX)}"
FEATURE_REPO="$WORK_DIR/feature-repo"
BUNDLE_DIR="$WORK_DIR/plugin-bundle"
DB_PATH="$WORK_DIR/almadel.db"
SERVER_LOG="$WORK_DIR/server.log"
OPENCODE_LOG="$WORK_DIR/opencode.log"

SERVER_PID=""
OPENCODE_PID=""

cleanup() {
  echo
  echo "==> cleaning up"
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$OPENCODE_PID" ]] && kill "$OPENCODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [[ -z "${ALMADEL_E2E_DIR:-}" ]]; then
    rm -rf "$WORK_DIR"
  else
    echo "==> artifacts kept in $WORK_DIR"
  fi
}
trap cleanup EXIT

log_failure() {
  echo "----- almadel server log (tail) -----"
  tail -n 40 "$SERVER_LOG" 2>/dev/null || true
  echo "----- opencode log (tail) -----"
  tail -n 60 "$OPENCODE_LOG" 2>/dev/null || true
}

wait_http() {
  local url="$1" tries="$2" delay="$3"
  for _ in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep "$delay"
  done
  return 1
}

echo "==> work dir: $WORK_DIR"
mkdir -p "$FEATURE_REPO/.opencode/plugins" "$FEATURE_REPO/test" "$BUNDLE_DIR"

if [[ -z "${ALMADEL_E2E_SKIP_BUILD:-}" ]]; then
  echo "==> building web UI"
  ( cd "$WEB_DIR" && bun run build >/dev/null 2>&1 )
  echo "==> bundling UI into server"
  ( cd "$SERVER_DIR" && bun run build:ui >/dev/null 2>&1 )
fi

echo "==> bundling plugin"
( cd "$PLUGIN_DIR" && bun build src/index.ts --outdir "$BUNDLE_DIR" --target bun >/dev/null 2>&1 )
cp "$BUNDLE_DIR/index.js" "$FEATURE_REPO/.opencode/plugins/almadel.js"

echo "==> creating feature repo"
cat > "$FEATURE_REPO/package.json" <<'EOF'
{
  "name": "almadel-feature",
  "type": "module",
  "scripts": { "test": "bun test" }
}
EOF

cat > "$FEATURE_REPO/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "$MODEL",
  "permission": { "edit": "allow", "bash": "allow", "read": "allow" }
}
EOF

cat > "$FEATURE_REPO/test/hello.test.ts" <<'EOF'
import { test, expect } from "bun:test";

test("hello feature is implemented", async () => {
  const text = await Bun.file(new URL("../hello.txt", import.meta.url)).text();
  expect(text.trim()).toBe("hello world");
});
EOF

cat > "$FEATURE_REPO/README.md" <<'EOF'
# Almadel E2E feature repo

The ticket "Add a hello feature" expects `hello.txt` at the repo root containing
exactly `hello world`. The test suite in `test/` verifies it.
EOF

( cd "$FEATURE_REPO" \
  && git init -q -b main \
  && git add -A \
  && git -c user.email=e2e@example.com -c user.name=e2e commit -q -m "initial" )

echo "==> starting almadel server on :$SERVER_PORT"
(
  cd "$SERVER_DIR"
  ALMADEL_DB="$DB_PATH" \
  ALMADEL_PORT="$SERVER_PORT" \
  ALMADEL_STATIC="$WEB_DIR/dist" \
    exec bun run src/cli.ts serve
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

if ! wait_http "$SERVER_URL/api/roster" 50 0.2; then
  echo "server failed to start" >&2; log_failure; exit 1
fi
echo "==> server is up"

echo "==> starting opencode (model=$MODEL) on :$OPENCODE_PORT"
(
  cd "$FEATURE_REPO"
  ALMADEL_SERVER="$SERVER_URL" \
  ALMADEL_JOIN="$PROJECT" \
  ALMADEL_TOKEN="e2e-token" \
  ALMADEL_LABEL="e2e-agent" \
  OPENCODE_VERSION="$OPENCODE_VERSION" \
    exec "$OPENCODE_BIN" serve --port "$OPENCODE_PORT" --print-logs
) >"$OPENCODE_LOG" 2>&1 &
OPENCODE_PID=$!

if ! wait_http "$OPENCODE_URL/config" 120 0.5; then
  echo "opencode failed to start" >&2; log_failure; exit 1
fi
echo "==> opencode is up; bootstrapping a session so the plugin loads"

curl -sf -X POST "$OPENCODE_URL/session" \
  -H 'content-type: application/json' \
  -d '{"body":{"title":"e2e-bootstrap"}}' >/dev/null || {
    echo "bootstrap POST /session failed" >&2; log_failure; exit 1
  }

echo "==> waiting for the agent to register"
for _ in $(seq 1 120); do
  agents=$(curl -sf "$SERVER_URL/api/roster" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(p["agents"]) for p in d["projects"]))' 2>/dev/null || echo 0)
  if [[ "${agents:-0}" -gt 0 ]]; then echo "==> agent registered"; break; fi
  sleep 1
done

echo "==> running Playwright E2E"
if ( cd "$E2E_DIR" \
  && ALMADEL_E2E_SERVER_URL="$SERVER_URL" \
     ALMADEL_E2E_PROJECT="$PROJECT" \
     ALMADEL_E2E_FEATURE_REPO="$FEATURE_REPO" \
     ./node_modules/.bin/playwright test ); then
  echo
  echo "E2E PASSED"
else
  log_failure
  echo
  echo "E2E FAILED — logs above"
  exit 1
fi
