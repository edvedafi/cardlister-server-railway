#!/usr/bin/env bash
# start-services.sh
# Starts Ollama (if not already running) as a background service.
# The card extractor Python worker is managed automatically by the TypeScript
# wrapper (card-extractor.ts) and does not need to be pre-started here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.services.pid"
LOG_DIR="$PROJECT_DIR/log"

mkdir -p "$LOG_DIR"

echo "[services] Starting background services..."

# ── Ollama ────────────────────────────────────────────────────────────────────

if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "[services] Ollama already running at http://localhost:11434"
else
  echo "[services] Starting Ollama..."
  nohup ollama serve >> "$LOG_DIR/ollama.log" 2>&1 &
  OLLAMA_PID=$!
  echo "$OLLAMA_PID" > "$PID_FILE"
  echo "[services] Ollama started (PID $OLLAMA_PID), waiting for ready..."

  # Wait up to 30 seconds for Ollama to be ready
  for i in $(seq 1 30); do
    sleep 1
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo "[services] Ollama ready after ${i}s"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "[services] WARNING: Ollama did not become ready after 30s — check log/ollama.log"
    fi
  done
fi

echo ""
echo "[services] Ready. Set the following in your environment to use Ollama:"
echo "  export OLLAMA_HOST=http://localhost:11434"
echo ""
echo "[services] Or add to your .env file:"
echo "  OLLAMA_HOST=http://localhost:11434"
echo ""
echo "[services] To stop: npm run services:stop"
