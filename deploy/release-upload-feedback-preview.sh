#!/bin/sh
set -eu
directory=/opt/yishu-preview/upload-feedback-20261005
mkdir -p "$directory/context"
cd "$directory"
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = 45f20c2e3f740e725ab90332907517df6000ff78bc69e5d11f09810d125a28ae
tar -xzf patch.tgz -C context
test -z "$(find context -name '._*' -o -name '.env*' -o -name '.DS_Store')"
test "$(find context -type f | wc -l)" -eq 4
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = sha256:2e903d4bd0633c561e6b7ee2aee42eb11e2b8a5e40e8b9ebabb9ee12d88b4f4f
cd context
docker build --network none -f deploy/Dockerfile.cloud-preview-upload-feedback -t yishu-cloud-preview:preview-20261005-upload-feedback .
docker run --rm --init --network none --read-only --entrypoint node yishu-cloud-preview:preview-20261005-upload-feedback -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const manifest = JSON.parse(fs.readFileSync("/workspace/upload-feedback-patch.json"));
for (const source of manifest.sources.filter(s=>s.file.startsWith("apps/mobile/"))) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync("/workspace/" + source.file)).digest("hex");
  if (actual !== source.sha256) throw Error("source_mismatch:" + source.file);
}
console.log("UPLOAD_FEEDBACK_SOURCE_PASS");'
docker run --rm --init --network none --read-only --memory 1280m --pids-limit 192 --cpus 0.75 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=536870912 \
  --tmpfs /workspace/apps/mobile/.expo:uid=1000,gid=1000,mode=0700,size=67108864 \
  --tmpfs /home/node:uid=1000,gid=1000,mode=0700,size=134217728 \
  -e EXPO_PUBLIC_API_BASE_URL=https://8.136.121.71 \
  -e EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2 \
  yishu-cloud-preview:preview-20261005-upload-feedback \
  node node_modules/expo/bin/cli export --platform ios --output-dir /tmp/export --max-workers 1
cd /opt/yishu-preview
grep -qx PREVIEW_TAG=preview-20261005-national preview.env
test ! -e preview.env.before-upload-feedback-20261005
cp -p preview.env preview.env.before-upload-feedback-20261005
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-before.txt"
rollback() {
  cp -p preview.env.before-upload-feedback-20261005 preview.env
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
}
trap rollback HUP INT TERM
sed -i 's/^PREVIEW_TAG=preview-20261005-national$/PREVIEW_TAG=preview-20261005-upload-feedback/' preview.env
if ! docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview; then rollback; exit 1; fi
trap - HUP INT TERM
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-after.txt"
cmp "$directory/business-before.txt" "$directory/business-after.txt"
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'
printf 'UPLOAD_FEEDBACK_RELEASE_PASS\n'
