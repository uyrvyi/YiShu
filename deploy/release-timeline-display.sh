#!/bin/sh
set -eu
umask 077
stage=/opt/yishu/releases/timeline-display-20261008
backend=/opt/yishu
api_base=sha256:86db45a9c81de44c6ff780a77a8e0d854c4d0bef84ef7b4af1f93e880ea8e59b
worker_base=sha256:53e5962df9090c5db346641cdb858e9d1d8146cc177c0c943971dee1f317841e
old_module=1617605fd76b8c38ce4b2ccb2ce503f649309e3ecf790e28b85aa8d1ad22803c
api_tag=timeline-display-20261008-api-r1
worker_tag=timeline-display-20261008-worker-r1
cd "$stage"
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = "$1"
test ! -e cloud.env.before
test "$(docker inspect yishu-cloud-api-1 --format '{{.Image}}')" = "$api_base"
test "$(docker inspect yishu-cloud-worker-1 --format '{{.Image}}')" = "$worker_base"
test "$(docker image inspect yishu-server:self-letter-policy-20261007-r1 --format '{{.Id}}')" = "$api_base"
test "$(docker image inspect yishu-server:transport-1.1-20261006-r1 --format '{{.Id}}')" = "$worker_base"
test "$(sha256sum "$backend/docker-compose.next-release.yml" | cut -d' ' -f1)" = 4e61f05d5535f4c2a16cedda03893dad3672567493f7b3cb8b8c0209ccf0f9a8
mkdir -p context
tar -xzf patch.tgz -C context
test "$(find context -type f | wc -l)" -eq 5
test -z "$(find context -name '.env*' -o -name '._*')"
for service in yishu-cloud-api-1 yishu-cloud-worker-1; do
  test "$(docker exec "$service" node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync("/workspace/packages/domain/dist/timeline.js")).digest("hex"))')" = "$old_module"
done
docker build --network none --build-arg TIMELINE_BASE_IMAGE=yishu-server:self-letter-policy-20261007-r1 -f context/deploy/Dockerfile.cloud-timeline-display -t "yishu-server:$api_tag" context
docker build --network none --build-arg TIMELINE_BASE_IMAGE=yishu-server:transport-1.1-20261006-r1 -f context/deploy/Dockerfile.cloud-timeline-display -t "yishu-server:$worker_tag" context
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > other-services.before
cp -p "$backend/.local/cloud/cloud.env" cloud.env.before
cp -p "$backend/docker-compose.next-release.yml" compose.before.yml
failed() {
  code=$?
  trap - EXIT HUP INT TERM
  cp -p "$stage/cloud.env.before" "$backend/.local/cloud/cloud.env"
  cp -p "$stage/compose.before.yml" "$backend/docker-compose.next-release.yml"
  (cd "$backend" && sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api worker)
  exit "$code"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
cp context/docker-compose.next-release.yml "$backend/docker-compose.next-release.yml"
sed -i "s/^API_RELEASE_TAG=.*/API_RELEASE_TAG=$api_tag/" "$backend/.local/cloud/cloud.env"
if grep -q '^WORKER_RELEASE_TAG=' "$backend/.local/cloud/cloud.env"; then
  sed -i "s/^WORKER_RELEASE_TAG=.*/WORKER_RELEASE_TAG=$worker_tag/" "$backend/.local/cloud/cloud.env"
else
  printf '\nWORKER_RELEASE_TAG=%s\n' "$worker_tag" >> "$backend/.local/cloud/cloud.env"
fi
grep -qx "API_RELEASE_TAG=$api_tag" "$backend/.local/cloud/cloud.env"
grep -qx "WORKER_RELEASE_TAG=$worker_tag" "$backend/.local/cloud/cloud.env"
(cd "$backend" && sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api worker)
docker exec -i -e YISHU_TIMELINE_DISPLAY_SMOKE=1 yishu-cloud-api-1 node --input-type=module < context/scripts/cloud-timeline-display-smoke.mjs
docker inspect yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > other-services.after
cmp other-services.before other-services.after
for service in yishu-cloud-api-1 yishu-cloud-worker-1; do
  test "$(docker inspect "$service" --format '{{.State.Health.Status}}')" = healthy
  test "$(docker exec "$service" node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync("/workspace/packages/domain/dist/timeline.js")).digest("hex"))')" = "$(sha256sum context/packages/domain/dist/timeline.js | cut -d' ' -f1)"
done
trap - EXIT HUP INT TERM
printf 'TIMELINE_DISPLAY_RELEASE_PASS_OTHER_SERVICES_UNCHANGED\n'
