#!/bin/bash
# ── Parallel Historical Chain Collection ───────────────────────────
# Runs N concurrent collect-history.js processes to maximize credit
# throughput. Each worker handles one symbol at a time from the queue.
#
# Usage:
#   ./scripts/collect-parallel.sh              # 8 workers (default)
#   WORKERS=16 ./scripts/collect-parallel.sh   # 16 workers
#   DRY_RUN=1 ./scripts/collect-parallel.sh    # show work list only

set -e
cd "$(dirname "$0")/.."

WORKERS="${WORKERS:-8}"
TARGET_FROM="${TARGET_FROM:-2019-01-02}"
TARGET_TO="${TARGET_TO:-$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d')}"
UNIVERSE_FILE="config/universe.txt"
DRY_RUN="${DRY_RUN:-0}"
LOG_DIR="data/chains/.parallel"

# Load token
if [ -f .env ]; then
  export MD_TOKEN=$(grep '^MD_TOKEN=' .env | cut -d= -f2-)
fi
if [ -z "$MD_TOKEN" ]; then
  echo "ERROR: MD_TOKEN not set in .env"
  exit 1
fi

# Read symbols
SYMBOLS=$(grep -v '^#' "$UNIVERSE_FILE" | grep -v '^\s*$' | tr -d '\r')
TOTAL=$(echo "$SYMBOLS" | wc -l | tr -d ' ')

echo ""
echo "  ── Parallel Collection ──"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Range:   $TARGET_FROM → $TARGET_TO"
echo "  Symbols: $TOTAL"
echo "  Workers: $WORKERS"
echo ""

# Build work queue (symbols that need data)
QUEUE_FILE=$(mktemp)
for SYMBOL in $SYMBOLS; do
  echo "$SYMBOL" >> "$QUEUE_FILE"
done

if [ "$DRY_RUN" = "1" ]; then
  echo "  Would collect $TOTAL symbols with $WORKERS workers."
  echo "  Symbols: $(head -10 "$QUEUE_FILE" | tr '\n' ' ')..."
  rm -f "$QUEUE_FILE"
  exit 0
fi

# Create log dir
mkdir -p "$LOG_DIR"

# Worker function: pull symbols from queue file one at a time
worker() {
  local WORKER_ID=$1
  while true; do
    # Atomically grab next symbol from queue
    local SYMBOL
    SYMBOL=$(flock "$QUEUE_FILE.lock" bash -c '
      head -1 "'"$QUEUE_FILE"'" 2>/dev/null
      sed -i "1d" "'"$QUEUE_FILE"'" 2>/dev/null
    ')
    SYMBOL=$(echo "$SYMBOL" | tr -d '[:space:]')
    if [ -z "$SYMBOL" ]; then
      break
    fi

    echo "  [W$WORKER_ID] $SYMBOL  $TARGET_FROM → $TARGET_TO"

    MD_TOKEN="$MD_TOKEN" node scripts/collect-history.js \
      --symbol "$SYMBOL" \
      --from "$TARGET_FROM" \
      --to "$TARGET_TO" \
      > "$LOG_DIR/$SYMBOL.log" 2>&1

    # Check for rate limiting
    if grep -q "Rate limited" "$LOG_DIR/$SYMBOL.log" 2>/dev/null; then
      echo "  [W$WORKER_ID] Rate limited on $SYMBOL — stopping worker."
      break
    fi

    # Log summary line
    local SUMMARY
    SUMMARY=$(grep "^Done!" "$LOG_DIR/$SYMBOL.log" 2>/dev/null || echo "error")
    echo "  [W$WORKER_ID] $SYMBOL: $SUMMARY"
  done
}

# Launch workers
PIDS=()
for i in $(seq 1 "$WORKERS"); do
  worker "$i" &
  PIDS+=($!)
done

echo "  Launched $WORKERS workers (PIDs: ${PIDS[*]})"
echo ""

# Wait for all workers
for PID in "${PIDS[@]}"; do
  wait "$PID" 2>/dev/null || true
done

# Summary
rm -f "$QUEUE_FILE" "$QUEUE_FILE.lock"

echo ""
echo "  ── Complete ──"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Storage: $(du -sh data/chains/ | cut -f1) in $(ls data/chains/*.parquet 2>/dev/null | wc -l) files"
echo "  Per-symbol logs: $LOG_DIR/"
echo ""
