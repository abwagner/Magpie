#!/bin/bash
# Install (or refresh) the Magpie systemd user units on your-server.example.com.
# Idempotent — safe to re-run after editing a unit. Run as the user that
# owns /srv/quantfoundry/Magpie (NOT root).
#
# Usage:
#   ./deploy/systemd/install.sh           # install + enable all timers
#   ./deploy/systemd/install.sh --dry-run # preview what would change

set -e
cd "$(dirname "$0")"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

run() {
  if [ $DRY_RUN -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# Copy every .service / .timer in this directory into the user unit dir.
echo "Installing units → $UNIT_DIR"
for f in *.service *.timer; do
  [ -f "$f" ] || continue
  run cp "$f" "$UNIT_DIR/$f"
done

run systemctl --user daemon-reload

# Enable + start every timer (services are oneshot, triggered by their timer).
echo "Enabling timers"
for t in *.timer; do
  [ -f "$t" ] || continue
  run systemctl --user enable --now "$t"
done

echo
echo "Active timers:"
systemctl --user list-timers --no-pager | head -30
