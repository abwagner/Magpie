#!/bin/bash
# Upload Parquet data files to an S3-compatible bucket (AWS S3 or MinIO).
# Bash counterpart to scripts/sync-to-s3.ts; same subdir set + flags.
#
# Usage:
#   ./scripts/sync-to-s3.sh                          # all known subdirs
#   ./scripts/sync-to-s3.sh --watch                  # continuous re-sync loop
#   ./scripts/sync-to-s3.sh --only chains            # one subdir
#   ./scripts/sync-to-s3.sh --no-fills               # all except fills
#   ENDPOINT_URL=https://s3.example.com ./scripts/sync-to-s3.sh

set -e
cd "$(dirname "$0")/.."

KNOWN_SUBDIRS=(chains signals macro futures etfs fills results databento)

if [ -n "$S3_BUCKET" ]; then
  BUCKET="$S3_BUCKET"
elif command -v jq >/dev/null && [ -f config/storage.json ]; then
  BUCKET=$(jq -r '.s3Bucket // ""' config/storage.json)
fi

if [ -z "$ENDPOINT_URL" ] && command -v jq >/dev/null && [ -f config/storage.json ]; then
  ENDPOINT_URL=$(jq -r '.s3Endpoint // ""' config/storage.json)
fi
[ -n "$S3_ENDPOINT_URL" ] && ENDPOINT_URL="$S3_ENDPOINT_URL"

if [ -z "$BUCKET" ]; then
  echo "ERROR: Set S3_BUCKET env var or s3Bucket in config/storage.json"
  exit 1
fi

WATCH=0
ONLY=""
EXCLUDES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --no-*) EXCLUDES+=("${1#--no-}"); shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [ -n "$ONLY" ]; then
  SUBDIRS=("$ONLY")
else
  SUBDIRS=()
  for sub in "${KNOWN_SUBDIRS[@]}"; do
    skip=0
    for e in "${EXCLUDES[@]}"; do
      [ "$e" = "$sub" ] && skip=1 && break
    done
    [ $skip -eq 0 ] && SUBDIRS+=("$sub")
  done
fi

ENDPOINT_FLAG=""
[ -n "$ENDPOINT_URL" ] && ENDPOINT_FLAG="--endpoint-url $ENDPOINT_URL"

sync_once() {
  local quiet="${1:-}"
  for sub in "${SUBDIRS[@]}"; do
    if [ -d "data/$sub" ]; then
      [ -z "$quiet" ] && echo "  data/$sub/ → s3://$BUCKET/$sub/"
      # shellcheck disable=SC2086
      aws s3 sync "data/$sub/" "s3://$BUCKET/$sub/" \
        --exclude "*.tmp.*" --exclude ".gitkeep" --exclude ".manifest.json" \
        $ENDPOINT_FLAG ${quiet:+--quiet}
    fi
  done
}

echo "Syncing to s3://$BUCKET/ ${ENDPOINT_URL:+via $ENDPOINT_URL}"
echo "  subdirs: ${SUBDIRS[*]}"
sync_once
echo "Done."

if [ $WATCH -eq 1 ]; then
  echo "Watching for changes (every 60s)..."
  while true; do
    sleep 60
    sync_once "quiet"
  done
fi
