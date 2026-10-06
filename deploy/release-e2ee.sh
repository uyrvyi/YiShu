#!/bin/sh
set -eu
umask 077
directory=/opt/yishu/releases/e2ee-20261005
cd "$directory"
test "${YISHU_E2EE_RELEASE_APPROVED:-0}" = 1
test ! -e release-started
sha256sum -c artifacts.sha256
test "$(docker inspect yishu-cloud-api-1 --format '{{.Image}}')" = sha256:889da669c7d58c0e8ff804d27601f7b02f43847881c568bbe27b941d7e6c7f64
test "$(docker inspect yishu-cloud-worker-1 --format '{{.Image}}')" = sha256:8d65d5a5d251a36f83dc4d067cb58a8f6a60c74aaed030188a6388f82b571318
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = sha256:2739035517bdf5ccab26a0985a5def5948331323fd5de6826172b9051addd9a9
test "$(docker inspect yishu-cloud-api-1 --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect yishu-cloud-worker-1 --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.State.Health.Status}}')" = healthy
docker image inspect yishu-server:e2ee-20261005-reviewed-r1 yishu-migrate:e2ee-20261005 yishu-cloud-preview:preview-20261005-e2ee-reviewed-r1 --format '{{.RepoTags}} {{.Id}}'
cp -p /opt/yishu/.local/cloud/cloud.env cloud.env.before
cp -p /opt/yishu-preview/preview.env preview.env.before
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > infrastructure.before
touch release-started
failed() {
  code=$?
  trap - EXIT HUP INT TERM
  docker rm -f yishu-e2ee-backup-check >/dev/null 2>&1 || true
  absent=$(docker exec yishu-cloud-postgres-1 psql -U yishu -d yishu -Atc 'SELECT to_regclass($$public."EncryptionIdentity"$$) IS NULL' 2>/dev/null) || absent=unknown
  if [ "$absent" = t ]; then enrolled=0; else
    enrolled=$(docker exec yishu-cloud-postgres-1 psql -U yishu -d yishu -Atc 'SELECT count(*) FROM "EncryptionIdentity"' 2>/dev/null) || enrolled=unknown
  fi
  if [ "$enrolled" = 0 ]; then
    cp -p "$directory/cloud.env.before" /opt/yishu/.local/cloud/cloud.env
    cp -p "$directory/preview.env.before" /opt/yishu-preview/preview.env
    sh /opt/yishu/scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api worker
    docker compose --project-directory /opt/yishu-preview --env-file /opt/yishu-preview/preview.env -f /opt/yishu-preview/docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
    printf 'ROLLED_BACK_BINARIES_SCHEMA_RETAINED\n'
  else
    # Never revert to a server that cannot read newly enrolled identities/envelopes.
    sh /opt/yishu/scripts/cloud.sh --next start api worker || true
    printf 'ROLLBACK_BLOCKED_ENROLLMENT_PRESENT_OR_SCHEMA_UNCONFIRMED\n'
  fi
  exit "$code"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
cd /opt/yishu
YISHU_BACKUP_KEEP_STOPPED=1 sh scripts/backup-media.sh scripts/cloud.sh .local/e2ee-backups > "$directory/backup-paths.txt"
dump=$(sed -n '1p' "$directory/backup-paths.txt")
media=$(sed -n '2p' "$directory/backup-paths.txt")
test -s "$dump"
test -s "$media"
sha256sum "$dump" "$media" > "$directory/backup.sha256"
tar -tf "$media" > "$directory/media-archive-files.txt"
docker exec yishu-cloud-postgres-1 psql -U yishu -d yishu -Atc 'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Letter"), (SELECT count(*) FROM "MediaAsset")' > "$directory/counts.before"
docker run -d --name yishu-e2ee-backup-check --init --network none --read-only --memory 384m --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,size=536870912 --tmpfs /var/run/postgresql:rw,size=16777216 --tmpfs /tmp:rw,size=16777216 \
  -e POSTGRES_USER=yishu -e POSTGRES_DB=yishu -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "/opt/yishu/$dump:/backup.dump:ro" -v "$directory/migration.sql:/migration.sql:ro" \
  yishu-postgres:cloud-amd64-20261002173948 >/dev/null
ready=0
for attempt in $(seq 1 40); do
  # The initialization server listens only on a Unix socket; wait for the final server.
  if docker exec yishu-e2ee-backup-check pg_isready -h 127.0.0.1 -U yishu -d yishu >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
docker exec yishu-e2ee-backup-check pg_restore -h 127.0.0.1 -U yishu -d yishu --no-owner --no-acl --exit-on-error /backup.dump
docker exec yishu-e2ee-backup-check psql -h 127.0.0.1 -U yishu -d yishu -v ON_ERROR_STOP=1 -1 -f /migration.sql
docker exec yishu-e2ee-backup-check psql -h 127.0.0.1 -U yishu -d yishu -Atc 'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Letter"), (SELECT count(*) FROM "MediaAsset")' > "$directory/counts.restored"
cmp "$directory/counts.before" "$directory/counts.restored"
docker rm -f yishu-e2ee-backup-check >/dev/null
printf 'PAIRED_BACKUP_RESTORE_AND_ADDITIVE_MIGRATION_PASS\n'
# Change only application image tags; infrastructure, routes and secrets stay unchanged.
# Schema and migration code are unchanged by the client/session review fixes.
docker tag yishu-migrate:e2ee-20261005 yishu-migrate:e2ee-20261005-reviewed-r1
sed -i 's/^NEXT_RELEASE_TAG=.*/NEXT_RELEASE_TAG=e2ee-20261005-reviewed-r1/;s/^API_RELEASE_TAG=.*/API_RELEASE_TAG=e2ee-20261005-reviewed-r1/' .local/cloud/cloud.env
grep -qx 'NEXT_RELEASE_TAG=e2ee-20261005-reviewed-r1' .local/cloud/cloud.env
grep -qx 'API_RELEASE_TAG=e2ee-20261005-reviewed-r1' .local/cloud/cloud.env
sh scripts/cloud.sh --next run --rm --no-deps migrate
docker exec yishu-cloud-postgres-1 psql -U yishu -d yishu -Atc 'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Letter"), (SELECT count(*) FROM "MediaAsset")' > "$directory/counts.migrated"
cmp "$directory/counts.before" "$directory/counts.migrated"
sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api worker
sed -i 's/^PREVIEW_TAG=.*/PREVIEW_TAG=preview-20261005-e2ee-reviewed-r1/' /opt/yishu-preview/preview.env
docker compose --project-directory /opt/yishu-preview --env-file /opt/yishu-preview/preview.env -f /opt/yishu-preview/docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/infrastructure.after"
cmp "$directory/infrastructure.before" "$directory/infrastructure.after"
docker exec -i -e YISHU_E2EE_SMOKE=1 yishu-cloud-api-1 node --input-type=module < "$directory/cloud-e2ee-smoke.mjs" > "$directory/smoke.log" 2>&1
cat "$directory/smoke.log"
grep -q CLOUD_E2EE_HTTP_SMOKE_PASS "$directory/smoke.log"
grep -q E2EE_FIXTURES_REMOVED "$directory/smoke.log"
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.Health.Status}} {{.RestartCount}}' > "$directory/applications.after"
cat "$directory/applications.after"
trap - EXIT HUP INT TERM
touch "$directory/release-pass"
printf 'E2EE_SERVER_RELEASE_PASS_REAL_DEVICE_GATE_PENDING\n'
