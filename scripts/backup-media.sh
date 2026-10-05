#!/bin/sh
# Paired backups require a short write freeze; run only in a scheduled maintenance window.
set -eu
umask 077
cd "$(dirname "$0")/.."
wrapper=${1:?Provide scripts/prod.sh, scripts/trial.sh, scripts/cloud.sh or scripts/next-version.sh}
case "$wrapper" in scripts/prod.sh|scripts/trial.sh|scripts/cloud.sh|scripts/next-version.sh) ;; *) exit 1 ;; esac
directory=${2:-.local/media-backups}
case "$directory" in .local/*) ;; *) printf '%s\n' 'Backup directory must be inside .local.' >&2; exit 1 ;; esac
mkdir -p "$directory"
chmod 700 "$directory"
lock="$directory/.backup-lock"
mkdir "$lock" || { printf '%s\n' 'Another backup owns the lock; investigate before retrying.' >&2; exit 1; }
file="$directory/$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
resume_api=0
resume_worker=0
complete=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$complete" = 0 ]; then rm -f "$file" "$file.media.tar"; fi
  rm -f "$file.partial" "$file.media.tar.partial"
  if [ "$complete" != 1 ] || [ "${YISHU_BACKUP_KEEP_STOPPED:-0}" != 1 ]; then
    if [ "$resume_api" = 1 ]; then sh "$wrapper" start api || result=1; fi
    if [ "$resume_worker" = 1 ]; then sh "$wrapper" start worker || result=1; fi
  fi
  rmdir "$lock" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
running=$(sh "$wrapper" ps --services --status running | tr '\n' ' ')
if [ "${YISHU_BACKUP_PRE_MEDIA:-0}" = 1 ]; then
  test "$wrapper" = scripts/cloud.sh
  sh "$wrapper" exec -T api node -e 'if (require("node:fs").existsSync("/media")) process.exit(1)'
fi
case " $running " in *" api "*) resume_api=1; sh "$wrapper" stop api ;; esac
case " $running " in *" worker "*) resume_worker=1; sh "$wrapper" stop worker ;; esac
container=$(sh "$wrapper" ps --all --quiet api)
test -n "$container"
database=yishu
if [ "$wrapper" = scripts/next-version.sh ]; then database=yishu_test; fi
sh "$wrapper" exec -T postgres pg_dump --username yishu --dbname "$database" \
  --format custom --no-owner --no-acl > "$file.partial"
if [ "${YISHU_BACKUP_PRE_MEDIA:-0}" = 1 ]; then
  # First upgrade only: refuse an empty image backup once media tables exist.
  absent=$(sh "$wrapper" exec -T postgres psql --username yishu --dbname "$database" \
    --no-psqlrc --tuples-only --no-align --command 'SELECT to_regclass('\''public."MediaAsset"'\'') IS NULL')
  test "$absent" = t
  tar -cf "$file.media.tar.partial" --files-from /dev/null
  printf '%s\n' 'Pre-media database: image archive intentionally empty.' >&2
else
  docker cp "$container:/media/." - > "$file.media.tar.partial"
fi
test -s "$file.partial"
test -s "$file.media.tar.partial"
mv "$file.media.tar.partial" "$file.media.tar"
mv "$file.partial" "$file"
complete=1
printf '%s\n' "$file" "$file.media.tar"
