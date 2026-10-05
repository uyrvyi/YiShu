#!/bin/sh
set -eu
cd /opt/yishu-preview/national-20261005
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = c2d301b86851ed0bc2b853eb43d52c9c3464a128a71f0050e4d126fcfda15beb
test "$(sha256sum data-metadata.tgz | cut -d' ' -f1)" = 5f3cd33259fa53c08390a7aa446285b42113676e2afd45baea5c91c7a5850f93
test "$(sha256sum map-image.tar.gz | cut -d' ' -f1)" = 5bc64cec64afc06f09ee9a22f526ce5031bd017d9dcad606d82957d8c464455d
mkdir -p context
tar -xzf patch.tgz -C context
test -z "$(find context -name '._*' -o -name '.env*' -o -name '.DS_Store')"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = sha256:f375f740465bc3ff2dfe4a934feafc72aee2b664b05798091221aeb1d7428dbb
docker load -i map-image.tar.gz
test "$(docker image inspect yishu-map-tiles:national-20261005 --format '{{.Id}}')" = sha256:7e86796da318b5dd0c85dce55105969ef28c27602d82542175d51339701877d6
mkdir -p /opt/yishu-maps/data
if ! test -f /opt/yishu-maps/data/national-20261003-v2.mbtiles; then
  cat /opt/yishu-maps/incoming/tile-part-[0-9][0-9] > /opt/yishu-maps/data/national-20261003-v2.mbtiles
fi
test "$(sha256sum /opt/yishu-maps/data/national-20261003-v2.mbtiles | cut -d' ' -f1)" = 21b5178b1cdb0d96922d26dde913b57c1799c53e131f4f6c8009fb53a14bced7
tar -xzf data-metadata.tgz -C /opt/yishu-maps/data
mv /opt/yishu-maps/data/STATIC_TILE_NOTICE.txt /opt/yishu-maps/data/NOTICE.txt
chmod 755 /opt/yishu-maps /opt/yishu-maps/data
chmod 644 /opt/yishu-maps/data/*
cp context/docker-compose.cloud-maps.yml /opt/yishu-maps/
docker compose -f /opt/yishu-maps/docker-compose.cloud-maps.yml up -d --wait --wait-timeout 120
cd context
docker build --network none -f deploy/Dockerfile.cloud-preview-national -t yishu-cloud-preview:preview-20261005-national .
docker run --rm --init --network none --read-only --entrypoint node yishu-cloud-preview:preview-20261005-national -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const manifest = JSON.parse(fs.readFileSync("/workspace/national-patch.json"));
for (const source of manifest.sources.filter(s => s.file.startsWith("apps/mobile/"))) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync("/workspace/" + source.file)).digest("hex");
  if (actual !== source.sha256) throw Error("source_mismatch:" + source.file);
}
console.log("NATIONAL_MAP_SOURCE_PASS");'
docker run --rm --init --network none --read-only --memory 1280m --pids-limit 192 --cpus 0.75 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=536870912 \
  --tmpfs /workspace/apps/mobile/.expo:uid=1000,gid=1000,mode=0700,size=67108864 \
  --tmpfs /home/node:uid=1000,gid=1000,mode=0700,size=134217728 \
  -e EXPO_PUBLIC_API_BASE_URL=https://8.136.121.71 \
  -e EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2 \
  yishu-cloud-preview:preview-20261005-national \
  node node_modules/expo/bin/cli export --platform ios --output-dir /tmp/export --max-workers 1
printf 'NATIONAL_MAP_STAGE_PASS\n'
