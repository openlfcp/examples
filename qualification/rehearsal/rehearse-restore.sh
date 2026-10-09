#!/usr/bin/env bash
# LFCP-02-074: rehearse a server restore from backup on the local deploy
# compose, never the public stack, and the clients' reconciliation after it.
#
#   examples/qualification/rehearsal/rehearse-restore.sh [evidence dir]
#
# Needs Docker with Compose v2, and server/ and sdk-rs/ beside examples/,
# sdk-rs at the commit in server/sdk-rs.lock (the image is built from it),
# examples installed and built. Uses its own compose project, its own
# volume and 127.0.0.1:17830, and removes the containers and the volume when
# it ends. The evidence dir keeps the vaults, the facts, the backup's file
# list and the server logs.
#
#  1. Build the image and start the server on an empty volume.
#  2. populate: A hosts a section and a legacy Resource; B joins both.
#  3. Back up: stop the server, copy the volume to a tar, start it again.
#  4. after-backup: B and A write; both accepted.
#  5. Restore: stop the server, replace the volume with the backup,
#     recreate the container from the same image and configuration.
#  6. reconcile: the clients restart from their vaults, offer what the
#     server lost, converge; a new member reads both Resources.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
examples="$(cd "$here/../.." && pwd)"
root="$(dirname "$examples")"
server="$root/server"
fail() { echo "rehearsal: $*" >&2; exit 1; }

lock="$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$server/sdk-rs.lock")"
[ "$(git -C "$root/sdk-rs" rev-parse HEAD)" = "$lock" ] ||
    fail "sdk-rs is not at $lock (server/sdk-rs.lock)"
git -C "$root/sdk-rs" diff --quiet HEAD -- Cargo.toml crates || fail "sdk-rs has uncommitted changes"

work="${1:-$(mktemp -d)}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"
export COMPOSE_PROJECT_NAME=lfcp-rehearsal
export LFCP_REHEARSAL_CONFIG="$here/server.rehearsal.toml"
compose=(docker compose -f "$server/deploy/compose.yaml" -f "$here/compose.rehearsal.yaml")
volume="${COMPOSE_PROJECT_NAME}_lfcp-state"
busybox=busybox:1.37
cleanup() {
    "${compose[@]}" logs --no-color lfcp-server >"$work/server-after-restore.log" 2>&1 || true
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

phase() {
    echo "rehearsal: phase $1"
    (cd "$examples" && LFCP_REHEARSAL_PHASE="$1" LFCP_REHEARSAL_URL=ws://127.0.0.1:17830/v1/ws \
        LFCP_REHEARSAL_DIR="$work" npx vitest run qualification/test/restore-rehearsal.test.ts)
}
healthy() {
    local id
    for _ in $(seq 1 60); do
        id="$("${compose[@]}" ps -q lfcp-server)"
        [ -n "$id" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = healthy ] && return 0
        sleep 1
    done
    fail "the server is not healthy"
}

echo "rehearsal: build and start on an empty volume ($volume)"
"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d --build --wait lfcp-server
docker image inspect --format '{{.Id}}' openlfcp/lfcp-server:dev >"$work/image-id"

phase populate

echo "rehearsal: back up the volume (server stopped)"
"${compose[@]}" stop lfcp-server
docker run --rm -v "$volume":/state:ro -v "$work":/backup "$busybox" tar -C /state -cf /backup/state.tar .
tar -tvf "$work/state.tar" >"$work/backup-files.txt"
shasum -a 256 "$work/state.tar" >"$work/backup.sha256"
"${compose[@]}" start lfcp-server
healthy

phase after-backup

echo "rehearsal: restore the volume from the backup"
"${compose[@]}" stop lfcp-server
"${compose[@]}" logs --no-color lfcp-server >"$work/server-before-restore.log" 2>&1
docker run --rm -v "$volume":/state -v "$work":/backup "$busybox" \
    sh -c 'find /state -mindepth 1 -delete && tar -C /state -xpf /backup/state.tar'
"${compose[@]}" up -d --force-recreate --wait lfcp-server
[ "$(docker image inspect --format '{{.Id}}' openlfcp/lfcp-server:dev)" = "$(cat "$work/image-id")" ] ||
    fail "the image changed during the rehearsal"

phase reconcile

echo "rehearsal: all phases passed; evidence in $work"
