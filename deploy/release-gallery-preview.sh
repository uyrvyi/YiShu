#!/bin/sh
set -eu
case "${2:-gallery}" in
  gallery)
    revision=gallery-20261005
    base_tag=preview-20261005-upload-feedback
    base_id=sha256:0ccef398af4d9efce6d91cbec148ebce777549877db03aa235bd9d655d250e64
    next_tag=preview-20261005-gallery
    ;;
  preload)
    revision=gallery-preload-20261005
    base_tag=preview-20261005-gallery
    base_id=sha256:1dff0d609b4b1b3a9ba4cf9ed3a34d699919eefaa674bb72d0ad518a0fcb4d26
    next_tag=preview-20261005-gallery-preload
    ;;
  *) exit 1 ;;
esac
directory=/opt/yishu-preview/$revision
image=yishu-cloud-preview:$next_tag
backup=preview.env.before-$revision
test "${#1}" -eq 64
mkdir -p "$directory/context"
cd "$directory"
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = "$1"
tar -xzf patch.tgz -C context
test -z "$(find context -name '._*' -o -name '.env*' -o -name '.DS_Store')"
test "$(find context -type f | wc -l)" -eq 8
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = "$base_id"
cd context
docker build --network none --build-arg "PREVIEW_BASE_IMAGE=yishu-cloud-preview:$base_tag" -f deploy/Dockerfile.cloud-preview-gallery -t "$image" .
docker run --rm --init --network none --read-only --entrypoint node "$image" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const manifest = JSON.parse(fs.readFileSync("/workspace/gallery-patch.json"));
for (const source of manifest.sources.filter(s=>s.file.startsWith("apps/mobile/"))) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync("/workspace/" + source.file)).digest("hex");
  if (actual !== source.sha256) throw Error("source_mismatch:" + source.file);
}
console.log("GALLERY_SOURCE_PASS");'
docker run --rm --init --network none --read-only --memory 1280m --pids-limit 192 --cpus 0.75 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=536870912 \
  --tmpfs /workspace/apps/mobile/.expo:uid=1000,gid=1000,mode=0700,size=67108864 \
  --tmpfs /home/node:uid=1000,gid=1000,mode=0700,size=134217728 \
  -e EXPO_PUBLIC_API_BASE_URL=https://8.136.121.71 \
  -e EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2 \
  "$image" \
  node node_modules/expo/bin/cli export --platform ios --output-dir /tmp/export --max-workers 1
cd /opt/yishu-preview
grep -qx "PREVIEW_TAG=$base_tag" preview.env
test ! -e "$backup"
cp -p preview.env "$backup"
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-before.txt"
rollback() {
  cp -p "$backup" preview.env
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
}
failed_release() {
  code=$?
  trap - EXIT HUP INT TERM
  rollback
  exit "$code"
}
trap failed_release EXIT
trap 'exit 1' HUP INT TERM
sed -i "s/^PREVIEW_TAG=$base_tag\$/PREVIEW_TAG=$next_tag/" preview.env
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-after.txt"
cmp "$directory/business-before.txt" "$directory/business-after.txt"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.State.Health.Status}}')" = healthy
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'
trap - EXIT HUP INT TERM
printf 'GALLERY_RELEASE_PASS\nBUSINESS_CONTAINERS_UNCHANGED_PASS\n'
