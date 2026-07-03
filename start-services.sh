#!/bin/bash
# Start all Apsamo Panel services in true daemon mode
# Usage: bash start-services.sh

set -e

PANEL_DIR="/home/z/my-project/panel"
WORKER_DIR="$PANEL_DIR/mini-services/worker-service"
REALTIME_DIR="$PANEL_DIR/mini-services/realtime-service"
LOG_DIR="/home/z/my-project/panel-logs"
mkdir -p "$LOG_DIR"

# Read CRON_API_KEY from panel .env
CRON_KEY=$(grep '^CRON_API_KEY=' "$PANEL_DIR/.env" | cut -d'"' -f2)
export CRON_API_KEY="$CRON_KEY"

echo "=== Starting Apsamo Panel services ==="
echo "CRON_API_KEY: ${CRON_KEY:0:20}..."

# 1) Realtime service (port 3003 + 3004) — already running? check
if ! ss -ltn 2>/dev/null | grep -q ':3003 '; then
  echo "[start] launching realtime-service on port 3003..."
  cd "$REALTIME_DIR"
  setsid env CRON_API_KEY="$CRON_KEY" bun index.ts > "$LOG_DIR/realtime.log" 2>&1 < /dev/null &
  disown
else
  echo "[start] realtime-service already running on 3003"
fi

# 2) Worker service (port 3005)
if ! ss -ltn 2>/dev/null | grep -q ':3005 '; then
  echo "[start] launching worker-service on port 3005..."
  cd "$WORKER_DIR"
  setsid env CRON_API_KEY="$CRON_KEY" bun index.ts > "$LOG_DIR/worker.log" 2>&1 < /dev/null &
  disown
else
  echo "[start] worker-service already running on 3005"
fi

# Wait for services to come up
sleep 5

echo ""
echo "=== Service status ==="
ss -ltn 2>&1 | grep -E ':3000|:3003|:3004|:3005' || echo "(no listening services)"

echo ""
echo "=== Health checks ==="
echo -n "Panel (3000):      "; curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/ || echo "FAIL"
echo -n "Realtime (3003):   "; curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3003/health || echo "FAIL"
echo -n "Worker (3005):     "; curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3005/health || echo "FAIL"

echo ""
echo "Logs: $LOG_DIR/{realtime.log,worker.log,dev.log}"
