#!/usr/bin/env bash
# stop-services.sh
# Stops background services started by start-services.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.services.pid"

echo "[services] Stopping background services..."

if [ -f "$PID_FILE" ]; then
  while IFS= read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[services] Killing PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "[services] Done."
else
  echo "[services] No PID file found — nothing to stop."
fi

# Also kill any Ollama processes we may have started (pkill is a no-op if none found)
pkill -f "ollama serve" 2>/dev/null && echo "[services] Stopped ollama serve" || true
