#!/bin/bash
# Pull portfolio.duckdb from S3/MinIO into the local CATALOG_DB_PATH.
# Counterpart to the upload step inside server/signals/rebuild-catalog.ts
# (gated by CATALOG_S3_PUSH=1 on the canonical writer).
#
# Usage:
#   ./scripts/fetch-catalog.sh
#   CATALOG_DB_PATH=./data/portfolio.duckdb ./scripts/fetch-catalog.sh
#
# Resolves config from (in order): explicit env, config/storage.json.
# Required: S3_BUCKET (or s3Bucket in config/storage.json).
# Optional: ENDPOINT_URL / S3_ENDPOINT_URL (or s3Endpoint in config).
# Writes to: $CATALOG_DB_PATH or ./data/portfolio.duckdb by default.

set -e
cd "$(dirname "$0")/.."

CATALOG_DB_PATH="${CATALOG_DB_PATH:-./data/portfolio.duckdb}"

if [ -n "$S3_BUCKET" ]; then
  BUCKET="$S3_BUCKET"
elif command -v jq >/dev/null && [ -f config/storage.json ]; then
  BUCKET=$(jq -r '.s3Bucket // ""' config/storage.json)
fi

if [ -z "$ENDPOINT_URL" ]; then
  if [ -n "$S3_ENDPOINT_URL" ]; then
    ENDPOINT_URL="$S3_ENDPOINT_URL"
  elif command -v jq >/dev/null && [ -f config/storage.json ]; then
    ENDPOINT_URL=$(jq -r '.s3Endpoint // ""' config/storage.json)
  fi
fi

if [ -z "$BUCKET" ]; then
  echo "ERROR: Set S3_BUCKET env var or s3Bucket in config/storage.json"
  exit 1
fi

ENDPOINT_FLAG=""
[ -n "$ENDPOINT_URL" ] && ENDPOINT_FLAG="--endpoint-url $ENDPOINT_URL"

SOURCE="s3://$BUCKET/duckdb/portfolio.duckdb"
mkdir -p "$(dirname "$CATALOG_DB_PATH")"

echo "Fetching $SOURCE → $CATALOG_DB_PATH ${ENDPOINT_URL:+via $ENDPOINT_URL}"
# shellcheck disable=SC2086
aws s3 cp "$SOURCE" "$CATALOG_DB_PATH" $ENDPOINT_FLAG

echo "Done."
ls -lh "$CATALOG_DB_PATH"
