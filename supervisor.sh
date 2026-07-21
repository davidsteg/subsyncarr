#!/bin/bash
# Two-process supervisor (one container). Runs the sync worker and the public
# API as separate Node processes so a heavy dashboard query can never block the
# engine's event loop (better-sqlite3 is synchronous).
#
#   worker : the unchanged single-process server (index-server.js), bound to
#            127.0.0.1:$WORKER_PORT — sole DB writer, owns the engine, cron and
#            cleanup, and the internal control/WebSocket endpoints. Not exposed.
#   api    : index-api.js on the public $WEB_PORT — serves heavy reads from its
#            own read-only DB connection, proxies control + WS to the worker.
#
# To revert to the original single process, set the container command back to
#   node dist/index-server.js
set -uo pipefail

WEB_PORT="${WEB_PORT:-3000}"
WORKER_PORT="${WORKER_PORT:-3001}"
# The internal worker port must not collide with the public API port.
if [ "$WORKER_PORT" = "$WEB_PORT" ]; then
  WORKER_PORT=$((WEB_PORT + 1))
fi
# Export so the API child (index-api.js) proxies to the right internal port.
export WORKER_PORT

# Worker: reuse the existing entrypoint verbatim, just on the internal port.
WEB_PORT="$WORKER_PORT" WEB_HOST=127.0.0.1 node dist/index-server.js &
WORKER_PID=$!

# Wait for the worker to be accepting connections (so it has run migrations and
# the DB schema exists) before starting the API reader. Bash /dev/tcp avoids a
# curl dependency (curl is purged from the runtime image).
for _ in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$WORKER_PORT") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  # Bail early if the worker already died during startup.
  kill -0 "$WORKER_PID" 2>/dev/null || break
  sleep 0.5
done

# API: public-facing reader + proxy.
node dist/index-api.js &
API_PID=$!

terminate() {
  kill -TERM "$WORKER_PID" "$API_PID" 2>/dev/null || true
}
# Graceful stop (docker stop / SIGTERM): tear both down and exit 0.
trap 'terminate; wait; exit 0' TERM INT

# Otherwise, if either process exits on its own it's a crash — take the whole
# container down non-zero so the orchestrator restarts it cleanly rather than
# running half-up.
wait -n
terminate
wait
exit 1
