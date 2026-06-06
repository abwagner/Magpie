#!/bin/bash
# ── Batch Historical Chain Collection ──────────────────────────────
# Collects historical option chains for the full trading universe.
# Designed to be run via cron — especially on weekends when no live
# trading consumes API credits.
#
# Behavior:
#   - Reads symbol list from config/universe.txt (one symbol per line)
#   - For each symbol, uses --resume to skip already-collected dates
#   - Stops if rate-limited (429) — safe to re-run next day
#   - Logs progress to data/chains/.collect.log
#
# Usage:
#   ./scripts/collect-universe.sh                     # collect all, resume where left off
#   FROM=2024-01-02 TO=2026-04-09 ./scripts/collect-universe.sh
#
# Cron (run Saturday + Sunday at midnight ET):
#   0 4 * * 6,0 cd /path/to/Magpie && ./scripts/collect-universe.sh >> data/chains/.collect.log 2>&1

set -e
cd "$(dirname "$0")/.."

FROM="${FROM:-2024-01-02}"
TO="${TO:-2026-04-09}"
UNIVERSE_FILE="config/universe.txt"
LOG_FILE="data/chains/.collect.log"

# Load token from .env
if [ -f .env ]; then
  MD_TOKEN=$(grep '^MD_TOKEN=' .env | cut -d= -f2-)
fi
if [ -z "$MD_TOKEN" ]; then
  echo "ERROR: MD_TOKEN not set in .env"
  exit 1
fi

# Read universe
if [ ! -f "$UNIVERSE_FILE" ]; then
  echo "ERROR: $UNIVERSE_FILE not found. Create it with one symbol per line."
  exit 1
fi

SYMBOLS=$(grep -v '^#' "$UNIVERSE_FILE" | grep -v '^\s*$' | tr -d '\r')
TOTAL=$(echo "$SYMBOLS" | wc -l | tr -d ' ')

echo ""
echo "  ── Historical Chain Collection ──"
echo "  $(date '+%Y-%m-%d %H:%M')"
echo "  Range:   $FROM → $TO"
echo "  Symbols: $TOTAL (from $UNIVERSE_FILE)"
echo ""

COUNT=0
COLLECTED=0
SKIPPED=0

for SYMBOL in $SYMBOLS; do
  COUNT=$((COUNT + 1))

  echo "  [$COUNT/$TOTAL] $SYMBOL"

  # Run with --resume so it picks up where it left off
  if MD_TOKEN="$MD_TOKEN" node scripts/collect-history.js \
    --symbol "$SYMBOL" \
    --from "$FROM" \
    --to "$TO" \
    --resume 2>&1 | while IFS= read -r line; do
      # Pass through output but detect rate limiting
      echo "    $line"
      if echo "$line" | grep -q "Rate limited"; then
        echo ""
        echo "  Rate limited — stopping. Will resume on next run."
        kill $$ 2>/dev/null
        exit 1
      fi
      if echo "$line" | grep -q "Already complete"; then
        exit 2
      fi
    done
  then
    COLLECTED=$((COLLECTED + 1))
  else
    EXIT_CODE=$?
    if [ "$EXIT_CODE" = "2" ]; then
      SKIPPED=$((SKIPPED + 1))
    else
      break
    fi
  fi

  echo ""
done

echo "  ── Done ──"
echo "  Collected: $COLLECTED  Skipped: $SKIPPED  Total: $COUNT/$TOTAL"
echo "  $(du -sh data/chains/ | cut -f1) in $(ls data/chains/*.parquet 2>/dev/null | wc -l) files"
echo ""
