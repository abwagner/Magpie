#!/bin/bash
# ── Backfill older history for all universe symbols ────────────────
# Collects the date range BEFORE what's already stored.
# Safe to re-run — parquet merge deduplicates by date.
#
# Usage:
#   ./scripts/backfill-universe.sh

set -e
cd "$(dirname "$0")/.."

FROM="${FROM:-2021-04-10}"
TO="${TO:-2023-12-31}"
UNIVERSE_FILE="config/universe.txt"

# Load token from .env
if [ -f .env ]; then
  MD_TOKEN=$(grep '^MD_TOKEN=' .env | cut -d= -f2-)
fi
if [ -z "$MD_TOKEN" ]; then
  echo "ERROR: MD_TOKEN not set in .env"
  exit 1
fi

SYMBOLS=$(grep -v '^#' "$UNIVERSE_FILE" | grep -v '^\s*$' | tr -d '\r')
TOTAL=$(echo "$SYMBOLS" | wc -l | tr -d ' ')

echo ""
echo "  ── Backfill Collection ──"
echo "  $(date '+%Y-%m-%d %H:%M')"
echo "  Range:   $FROM → $TO"
echo "  Symbols: $TOTAL"
echo ""

COUNT=0

for SYMBOL in $SYMBOLS; do
  COUNT=$((COUNT + 1))
  echo "  [$COUNT/$TOTAL] $SYMBOL  $FROM → $TO"

  # No --resume: we want the older date range
  MD_TOKEN="$MD_TOKEN" node scripts/collect-history.js \
    --symbol "$SYMBOL" \
    --from "$FROM" \
    --to "$TO" \
    2>&1 | while IFS= read -r line; do
      echo "    $line"
      if echo "$line" | grep -q "Rate limited"; then
        echo ""
        echo "  Rate limited — stopping. Re-run to continue."
        kill $$ 2>/dev/null
        exit 1
      fi
    done || { echo "  Stopped."; break; }

  echo ""
done

echo "  ── Done ──"
echo "  $(du -sh data/chains/ | cut -f1) in $(ls data/chains/*.parquet 2>/dev/null | wc -l) files"
echo ""
