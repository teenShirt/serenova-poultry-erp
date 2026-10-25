#!/usr/bin/env bash
# Installs a release on a server and switches to it, with a health check and automatic rollback
# of the code (never of the database). Run by the deployment workflow over SSH:
#
#   remote-deploy.sh <release-id> <release-tarball> [<base-dir>] [<service-name>] [<port>]
#
# Layout under <base-dir> (default /opt/serenova):
#   releases/<release-id>/   each release, unpacked (the last 5 are kept)
#   current -> releases/<id> the release being served
#   shared/.env              settings and secrets (written once by the administrator, never in git)
#   shared/data/             backups and other files that outlive releases
#
# Database upgrades are applied by the new release when it starts, after it has written a full
# backup of the database. Upgrades only add to the schema, so the previous release keeps working
# if the code has to be rolled back. A database is never "downgraded" automatically: to undo data
# changes, restore the pre-migration backup (see docs/RECOVERY.md).
set -euo pipefail

RELEASE_ID="${1:?release id (commit) required}"
TARBALL="${2:?release tarball required}"
BASE="${3:-/opt/serenova}"
SERVICE="${4:-serenova}"
PORT="${5:-3000}"
RELEASE_DIR="$BASE/releases/$RELEASE_ID"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

[[ "$RELEASE_ID" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Release id must be a commit hash" >&2; exit 2; }
[[ -f "$BASE/shared/.env" ]] || { echo "Missing $BASE/shared/.env (see docs/DEPLOYMENT.md)" >&2; exit 2; }

PREVIOUS=""
if [[ -L "$BASE/current" ]]; then PREVIOUS="$(readlink -f "$BASE/current")"; fi

log "Unpacking $RELEASE_ID"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR"
ln -sfn "$BASE/shared/.env" "$RELEASE_DIR/.env"
mkdir -p "$BASE/shared/data"
rm -rf "$RELEASE_DIR/data"
ln -sfn "$BASE/shared/data" "$RELEASE_DIR/data"
# The release records which commit it is (shown in the platform console's release history).
echo "RELEASE_SHA=$RELEASE_ID" > "$RELEASE_DIR/.release"

log "Installing dependencies"
(cd "$RELEASE_DIR" && npm ci --no-audit --no-fund --loglevel=error)

switch_to() {
  ln -sfn "$1" "$BASE/current.tmp"
  mv -Tf "$BASE/current.tmp" "$BASE/current"
  sudo systemctl restart "$SERVICE"
}

wait_ready() {
  # Ready = the server answers and its database is at this release's schema (upgrades included).
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/readyz" > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

log "Switching to $RELEASE_ID"
switch_to "$RELEASE_DIR"
if wait_ready; then
  log "Healthy: $(curl -fsS "http://127.0.0.1:$PORT/readyz")"
  # Keep the last five releases for quick rollback.
  ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf
  exit 0
fi

log "The new release did not become healthy. Recent log:"
sudo journalctl -u "$SERVICE" -n 60 --no-pager || true
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  log "Rolling the code back to $(basename "$PREVIOUS") (the database is not changed)"
  switch_to "$PREVIOUS"
  if wait_ready; then log "Previous release is serving again"; else log "Previous release is not healthy either: manual recovery needed (docs/RECOVERY.md)"; fi
fi
exit 1
