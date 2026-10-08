#!/bin/sh
set -eu
umask 077
stage=/opt/yishu/releases/transport-1.1-20261006-r1
backend=/opt/yishu
preview=/opt/yishu-preview
tag=transport-1.1-20261006-r1
preview_tag=preview-20261006-transport-1-1-r1
restore=yishu-transport-restore-check
cd "$stage"
test "${YISHU_TRANSPORT_RELEASE_APPROVED:-0}" = 1
test ! -e release-started
sha256sum -c artifacts.sha256
test "$(docker inspect yishu-cloud-api-1 --format '{{.Image}}')" = sha256:bd19a13c7cf17eb49c4acc0e3ccef889d8ab69a9cb48e6bb3616039e2e2e5d18
test "$(docker inspect yishu-cloud-worker-1 --format '{{.Image}}')" = sha256:bd19a13c7cf17eb49c4acc0e3ccef889d8ab69a9cb48e6bb3616039e2e2e5d18
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = sha256:868277b582064dff1f5bebf0c159f4a6e8fec7b925cf8f48e21895b8514dfd37
docker image inspect "yishu-server:$tag" "yishu-cloud-preview:$preview_tag" >/dev/null
cp -p "$backend/.local/cloud/cloud.env" cloud.env.before
cp -p "$backend/docker-compose.cloud.yml" compose.before
cp -p "$preview/preview.env" preview.env.before
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > infrastructure.before
failed() {
  result=$?
  trap - EXIT HUP INT TERM
  docker rm -f "$restore" >/dev/null 2>&1 || true
  if [ ! -e "$stage/applications-started" ]; then
    cp -p "$stage/cloud.env.before" "$backend/.local/cloud/cloud.env"
    cp -p "$stage/compose.before" "$backend/docker-compose.cloud.yml"
    cp -p "$stage/preview.env.before" "$preview/preview.env"
    sh "$backend/scripts/cloud.sh" --next start api worker || true
    printf 'PRE_SWITCH_FAILURE_OLD_SERVICES_RESUMED\n'
  else
    # Once new writes are possible, retain code and assets that understand 1.1.
    printf 'POST_SWITCH_FAILURE_COMPATIBLE_IMAGES_RETAINED_FORWARD_FIX_REQUIRED\n'
  fi
  exit "$result"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
touch release-started
cd "$backend"
YISHU_BACKUP_KEEP_STOPPED=1 sh scripts/backup-media.sh scripts/cloud.sh .local/transport-1.1-backups > "$stage/backup-paths.txt"
dump=$(sed -n '1p' "$stage/backup-paths.txt")
media=$(sed -n '2p' "$stage/backup-paths.txt")
sha256sum "$dump" "$media" > "$stage/backup.sha256"
docker exec yishu-cloud-postgres-1 psql -U yishu -d yishu -Atc "SELECT format('SELECT %L, count(*)::bigint, md5(COALESCE(string_agg(row_to_json(t)::text, %L ORDER BY row_to_json(t)::text), %L)) FROM %I AS t;', tablename, '', '', tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename" > "$stage/fingerprints.sql"
docker exec -i yishu-cloud-postgres-1 psql -U yishu -d yishu -At -v ON_ERROR_STOP=1 < "$stage/fingerprints.sql" > "$stage/database.before"
docker run -d --name "$restore" --init --network none --read-only --memory 384m --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,size=536870912 --tmpfs /var/run/postgresql:rw,size=16777216 --tmpfs /tmp:rw,size=16777216 \
  -e POSTGRES_USER=yishu -e POSTGRES_DB=yishu -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$backend/$dump:/backup.dump:ro" yishu-postgres:cloud-amd64-20261002173948 >/dev/null
ready=0
for attempt in $(seq 1 40); do
  if docker exec "$restore" pg_isready -h 127.0.0.1 -U yishu -d yishu >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
docker exec "$restore" pg_restore -h 127.0.0.1 -U yishu -d yishu --no-owner --no-acl --exit-on-error /backup.dump
docker exec -i "$restore" psql -h 127.0.0.1 -U yishu -d yishu -At -v ON_ERROR_STOP=1 < "$stage/fingerprints.sql" > "$stage/database.restored"
cmp "$stage/database.before" "$stage/database.restored"
docker rm -f "$restore" >/dev/null
mkdir "$stage/media-source" "$stage/media-restored"
docker cp yishu-cloud-api-1:/media/. "$stage/media-source"
tar -xf "$backend/$media" -C "$stage/media-restored"
docker run --rm -i --network none --read-only --entrypoint node --user 0 \
  -v "$stage:/check:ro" "yishu-server:$tag" --input-type=module > "$stage/media-check.log" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
function inventory(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink());
    return entry.isDirectory() ? inventory(root, file) : [[file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]];
  }).sort((a,b)=>a[0].localeCompare(b[0]));
}
const original = inventory('/check/media-source');
assert.deepEqual(inventory('/check/media-restored'), original);
console.log(JSON.stringify({status:'PAIRED_MEDIA_RESTORE_PASS',files:original.length}));
JS
printf 'PAIRED_DATABASE_ALL_TABLES_AND_MEDIA_RESTORE_PASS\n'
cp "$stage/docker-compose.cloud.yml" "$backend/docker-compose.cloud.yml"
sed -i "s/^NEXT_RELEASE_TAG=.*/NEXT_RELEASE_TAG=$tag/;s/^API_RELEASE_TAG=.*/API_RELEASE_TAG=$tag/;s/^NEW_LETTER_RULES_VERSION=.*/NEW_LETTER_RULES_VERSION=1.1/" .local/cloud/cloud.env
grep -q '^NEW_LETTER_RULES_VERSION=' .local/cloud/cloud.env || printf '\nNEW_LETTER_RULES_VERSION=1.1\n' >> .local/cloud/cloud.env
grep -qx "NEXT_RELEASE_TAG=$tag" .local/cloud/cloud.env
grep -qx "API_RELEASE_TAG=$tag" .local/cloud/cloud.env
sed -i "s/^PREVIEW_TAG=.*/PREVIEW_TAG=$preview_tag/" "$preview/preview.env"
touch "$stage/applications-started"
sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api worker
docker compose --project-directory "$preview" --env-file "$preview/preview.env" -f "$preview/docker-compose.cloud-preview.yml" up -d --no-deps --wait --wait-timeout 240 preview
docker exec -i yishu-cloud-preview-preview-1 node --input-type=module < "$stage/prewarm.mjs" > "$stage/preview-prewarm.log" 2>&1
docker exec -i -e YISHU_TRANSPORT_SMOKE=1 yishu-cloud-api-1 node --input-type=module < "$stage/smoke.mjs" > "$stage/smoke.log" 2>&1
grep -q TRANSPORT_1_1_HTTPS_E2EE_SMOKE_PASS "$stage/smoke.log"
grep -q TRANSPORT_FIXTURES_REMOVED "$stage/smoke.log"
docker exec -i yishu-cloud-preview-preview-1 node --input-type=module - https://8.136.121.71 < "$stage/check-expo-preview.mjs" > "$stage/preview-check.log" 2>&1
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$stage/infrastructure.after"
cmp "$stage/infrastructure.before" "$stage/infrastructure.after"
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.Health.Status}}' > "$stage/applications.after"
trap - EXIT HUP INT TERM
touch "$stage/release-pass"
printf 'TRANSPORT_1_1_SERVER_RELEASE_PASS_DEVICE_GATE_PENDING_MAP_APPROVAL_UNVERIFIED\n'
