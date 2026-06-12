#!/usr/bin/env bash
# Create the gitignored `strategies` symlink that lets QF discover
# strategies living in the sibling `magpie-strategies` repo.
#
# Strategies live in their own repo so QF's history isn't churned by
# per-strategy iteration. The symlink is a per-checkout convenience:
# it lets `ls strategies/<name>/` from inside QF resolve, but the link
# itself is gitignored (see .gitignore: "strategies").
#
# Idempotent: re-running is safe.
#
# Usage:
#   ./scripts/setup-strategies-symlink.sh
#
# Prereq:
#   ~/GitHub/magpie-strategies/ checked out (clone it first).

set -euo pipefail

QF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRATEGIES_REPO="$(cd "${QF_ROOT}/.." && pwd)/magpie-strategies"

if [[ ! -d "${STRATEGIES_REPO}" ]]; then
  echo "ERROR: ${STRATEGIES_REPO} does not exist." >&2
  echo "       Clone it first:" >&2
  echo "         cd $(dirname "${STRATEGIES_REPO}")" >&2
  echo "         git clone git@github.com:your-org/magpie-strategies.git" >&2
  exit 1
fi

LINK="${QF_ROOT}/strategies"

if [[ -L "${LINK}" ]]; then
  current=$(readlink "${LINK}")
  if [[ "${current}" == "../magpie-strategies" ]]; then
    echo "OK: ${LINK} -> ../magpie-strategies (already correct)"
    exit 0
  fi
  echo "WARN: ${LINK} exists and points elsewhere (-> ${current}). Removing." >&2
  rm "${LINK}"
elif [[ -e "${LINK}" ]]; then
  echo "ERROR: ${LINK} exists and is not a symlink. Remove it manually." >&2
  exit 1
fi

ln -s ../magpie-strategies "${LINK}"
echo "OK: created ${LINK} -> ../magpie-strategies"
echo "    Run a strategy via:"
echo "      cd strategies/soxx-rotation && uv sync --extra test && uv run pytest"
