#!/bin/bash
# Download Parquet data files from an S3-compatible bucket (AWS S3 or MinIO).
# Mirrors the layout written by scripts/sync-to-s3.ts.
#
# Usage:
#   ./scripts/sync-from-s3.sh                          # all known subdirs
#   ./scripts/sync-from-s3.sh --only chains            # one subdir
#   ./scripts/sync-from-s3.sh --no-fills               # all except fills
#   ENDPOINT_URL=https://s3.example.com ./scripts/sync-from-s3.sh
#   S3_BUCKET=my-bucket ./scripts/sync-from-s3.sh

set -e
cd "$(dirname "$0")/.."

KNOWN_SUBDIRS=(chains signals macro futures etfs fills results databento)

# Determine S3 bucket: env > config/storage.json > error
if [ -n "$S3_BUCKET" ]; then
  BUCKET="$S3_BUCKET"
elif command -v jq >/dev/null && [ -f config/storage.json ]; then
  BUCKET=$(jq -r '.s3Bucket // ""' config/storage.json)
fi

# Endpoint URL: env > config/storage.json
if [ -z "$ENDPOINT_URL" ] && command -v jq >/dev/null && [ -f config/storage.json ]; then
  ENDPOINT_URL=$(jq -r '.s3Endpoint // ""' config/storage.json)
fi
[ -n "$S3_ENDPOINT_URL" ] && ENDPOINT_URL="$S3_ENDPOINT_URL"

if [ -z "$BUCKET" ]; then
  echo "ERROR: Set S3_BUCKET env var or s3Bucket in config/storage.json"
  exit 1
fi

# Parse args (--only X, --no-X)
ONLY=""
EXCLUDES=()
while [ $# -gt 0 ]; do
  case "$1" in
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

echo "Syncing from s3://$BUCKET/ ${ENDPOINT_URL:+via $ENDPOINT_URL}"
echo "  subdirs: ${SUBDIRS[*]}"

for sub in "${SUBDIRS[@]}"; do
  mkdir -p "data/$sub"
  echo "  s3://$BUCKET/$sub/ → data/$sub/"
  # shellcheck disable=SC2086
  aws s3 sync "s3://$BUCKET/$sub/" "data/$sub/" $ENDPOINT_FLAG
done

echo "Done."
echo "Sizes:"
du -sh data/*/ 2>/dev/null
