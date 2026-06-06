#!/bin/bash
# ── Nightly Automated Chain Collection ─────────────────────────────
# Runs at 8 PM ET nightly via cron. Delegates to collect-bulk.js
# which handles parallelism, dedup, and credit management.
#
# Cron:
#   CRON_TZ=America/New_York
#   0 20 * * * cd ~/Magpie && ./scripts/collect-nightly.sh >> data/chains/.nightly.log 2>&1
#
# Usage:
#   ./scripts/collect-nightly.sh              # run now
#   DRY_RUN=1 ./scripts/collect-nightly.sh    # show what would be collected

set -e
cd "$(dirname "$0")/.."

# Prevent duplicate instances
LOCK_FILE="data/chains/.nightly.lock"
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "  Another nightly collection is running (PID $LOCK_PID). Exiting."
    exit 0
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Load token
if [ -f .env ]; then
  export MD_TOKEN=$(grep '^MD_TOKEN=' .env | cut -d= -f2-)
fi
if [ -z "$MD_TOKEN" ]; then
  echo "ERROR: MD_TOKEN not set in .env"
  exit 1
fi

echo ""
echo "  ── Nightly Collection ──"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

TARGET_FROM="${TARGET_FROM:-2019-01-02}"
TARGET_TO="${TARGET_TO:-$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d')}"
CONCURRENCY="${CONCURRENCY:-8}"
RESERVE="${RESERVE:-5000}"

export CONCURRENCY RESERVE

node scripts/collect-bulk.js --from "$TARGET_FROM" --to "$TARGET_TO"

echo ""
echo "  ── Nightly Complete ──"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
