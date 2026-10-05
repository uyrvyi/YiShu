#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
directory=.local/production
mkdir -p "$directory"
chmod 700 "$directory"
for file in local.env source.dump source.json source.dump.partial snapshot.id dump.ready dump.abort; do
  if [ -e "$directory/$file" ]; then
    printf '%s\n' 'Existing import evidence found; refusing to overwrite.' >&2
    exit 1
  fi
done
sh scripts/dev.sh exec -T dev node scripts/prod-import-snapshot.mjs > "$directory/snapshot.log" 2>&1 &
snapshot_pid=$!
finish() {
  if kill -0 "$snapshot_pid" 2>/dev/null; then
    touch "$directory/dump.abort"
    wait "$snapshot_pid" || true
  fi
}
trap finish EXIT INT TERM
attempt=0
while [ ! -f "$directory/snapshot.id" ]; do
  if ! kill -0 "$snapshot_pid" 2>/dev/null; then
    wait "$snapshot_pid" || true
    printf '%s\n' 'Source snapshot failed; inspect the private snapshot.log.' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    printf '%s\n' 'Source snapshot initialization timed out.' >&2
    exit 1
  fi
  sleep 1
done
snapshot=$(cat "$directory/snapshot.id")
sh scripts/dev.sh exec -T postgres sh -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format custom --no-owner --no-acl --snapshot="$1"' \
  sh "$snapshot" > "$directory/source.dump.partial"
touch "$directory/dump.ready"
wait "$snapshot_pid"
trap - EXIT INT TERM
cat "$directory/snapshot.log"
