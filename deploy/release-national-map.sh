#!/bin/sh
set -eu
context=/opt/yishu-preview/national-20261005/context
cd /opt/yishu-preview
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = sha256:f375f740465bc3ff2dfe4a934feafc72aee2b664b05798091221aeb1d7428dbb
grep -qx 'PREVIEW_TAG=preview-20261004-map-scroll-lock-r2' preview.env
if test -e preview.env.before-national-20261005; then
  grep -qx 'PREVIEW_TAG=preview-20261004-map-scroll-lock-r2' preview.env.before-national-20261005
  test -f docker-compose.cloud-preview.yml.before-national-20261005
  test -f /opt/yishu/deploy/Caddyfile.cloud.before-national-20261005
  test -f /opt/yishu/docker-compose.cloud.yml.before-national-20261005
else
  test ! -e /opt/yishu/deploy/Caddyfile.cloud.before-national-20261005
  cp -p preview.env preview.env.before-national-20261005
  cp -p docker-compose.cloud-preview.yml docker-compose.cloud-preview.yml.before-national-20261005
  cp -p /opt/yishu/deploy/Caddyfile.cloud /opt/yishu/deploy/Caddyfile.cloud.before-national-20261005
  cp -p /opt/yishu/docker-compose.cloud.yml /opt/yishu/docker-compose.cloud.yml.before-national-20261005
fi
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > national-business-before.txt
rollback() {
  cp -p preview.env.before-national-20261005 preview.env
  cp -p docker-compose.cloud-preview.yml.before-national-20261005 docker-compose.cloud-preview.yml
  cp -p /opt/yishu/deploy/Caddyfile.cloud.before-national-20261005 /opt/yishu/deploy/Caddyfile.cloud
  cp -p /opt/yishu/docker-compose.cloud.yml.before-national-20261005 /opt/yishu/docker-compose.cloud.yml
  sh /opt/yishu/scripts/cloud.sh up -d --no-deps --wait --wait-timeout 120 caddy
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
}
trap rollback HUP INT TERM
docker cp "$context/deploy/Caddyfile.cloud" yishu-cloud-caddy-1:/tmp/Caddyfile.national
docker exec yishu-cloud-caddy-1 caddy validate --config /tmp/Caddyfile.national --adapter caddyfile
cp "$context/deploy/Caddyfile.cloud" /opt/yishu/deploy/Caddyfile.cloud
cp "$context/docker-compose.cloud.yml" /opt/yishu/docker-compose.cloud.yml
if ! sh /opt/yishu/scripts/cloud.sh up -d --no-deps --wait --wait-timeout 120 caddy; then rollback; exit 1; fi
cp "$context/docker-compose.cloud-preview.yml" docker-compose.cloud-preview.yml
sed -i 's/^PREVIEW_TAG=preview-20261004-map-scroll-lock-r2$/PREVIEW_TAG=preview-20261005-national/' preview.env
printf '\nEXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2\n' >> preview.env
if ! docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview; then rollback; exit 1; fi
trap - HUP INT TERM
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > national-business-after.txt
cmp national-business-before.txt national-business-after.txt
docker inspect yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 --format '{{.Name}} Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'
printf 'NATIONAL_MAP_RELEASE_PASS\n'
