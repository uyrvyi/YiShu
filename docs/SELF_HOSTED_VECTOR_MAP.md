# 全国自有静态矢量底图

## 范围

2026-10-04 完成本机预览；2026-10-05 经用户授权部署到服务器。全国按视野加载水面、海岸线、共享行政区界和主要道路。
此次只更新独立瓦片服务、HTTPS 网关和服务器 Expo Go 地图前端；不改数据库、地区选择、驿站、路线计算、计时或内容可见权限。
已安装 APK 不会自动获得本轮地图，仍需后续重新打包。

数据来自同一 OpenStreetMap / Geofabrik `2026-10-03T20:20:50Z` 快照。
China、Taiwan 两份源文件校验通过；西藏、海南补充关系中的所有对象时间均不晚于快照。
澳门采用源数据的 admin_level=3，渲染归入省级显示，不更改业务层级。
原始来源、SHA256、异常隔离和未闭合关系保存在 `.local/maps/*report.json`、`source-integrity.json`。

## 渲染

- 共享行政边界按 OSM way ID 只绘制一次；父子共线只保留较高层级，避免双描边。
- 水系采用真实面几何，不把中心线加粗伪装成河岸，不吸附、不按行政区裁切河流。
- 道路采用 motorway、trunk、primary、secondary 及相应连接匝道；缩放到 6/7/9/11 级逐步出现。
- 小路、住宅路、内部服务道路、三级路、步道、骑行道等不进入瓦片。
- 顺序：水面 → 浅灰道路 → 海岸线 → 行政区界 → 地名 → 业务路线与标记。
- 使用 Leaflet.VectorGrid 的 Canvas 瓦片渲染器，避免上海这种路网密集视图生成数万个 SVG 节点；地名和业务覆盖层保持独立。
- 2–12 级预生成 MVT，12 级保留源顶点，不再简化；量化 detail=14，最多显示到 15 级。
- 低缩放全国概览仍保留原有简化陆地填充，但不描边；放大到 6 级后隐藏它，避免粗糙海岸轮廓叠加。
- 高缩放海岸目前为同源精细线，不从行政海域推断陆地/海洋填色。
- 道路仅为背景参考，不意味着信件沿该道路行驶，也不提供道路导航。

## 本机运行

已经生成的瓦片由独立 Docker 容器只读提供，仅绑定 `127.0.0.1:4180`。
容器只挂载 `.local/maps`，不挂载项目根目录、不读取 `.env`，不提供任何业务凭据。
使用非 root、只读文件系统、init、256 MB 内存和 64 进程限制。

```sh
docker compose -p yishu-map-preview -f docker-compose.map-preview.yml up -d --build
```

地图预览：`http://127.0.0.1:4179/geographic-map`。
瓦片前缀：`http://127.0.0.1:4180/maps/national-20261003-v2`。
版本路径固定，gzip 压缩、ETag、长期不可变缓存；新数据必须更换版本路径，不能覆盖已发布版本。
失败保留业务覆盖层，并显示背景不可用状态；不调用第三方地图 API，没有第三方地图请求配额。

App 预留 `EXPO_PUBLIC_MAP_TILE_BASE_URL`，默认留空沿用已发布离线背景。
它只接受 HTTPS 或本机回环 HTTP，禁止 URL 凭据、查询参数和任意路径；请求不携带 Cookie。
真实手机不能用 `127.0.0.1` 访问 Mac 的服务。本轮不向实际 `.env` 写入回环地址。
服务器预览已设置公网版本前缀；本机实际 `.env` 仍未改动。

## 服务器部署（2026-10-05）

- 公网前缀：`https://8.136.121.71/maps/national-20261003-v2`，沿用现有 HTTPS TCP 443；不增加公网端口。
- 目录 `/opt/yishu-maps/data`；独立 Compose 项目 `yishu-cloud-maps`。容器只读挂载公开地图，非 root、Docker init、256 MiB 内存、64 进程，宿主端口为 `{}`。
- 独立内部网络 `yishu-maps` 只接入地图与 Caddy，未把预览加入业务网络；网关不向地图转发 Cookie 或 Authorization。
- 瓦片镜像 `yishu-map-tiles:national-20261005`，ID `sha256:7e86796da318b5dd0c85dce55105969ef28c27602d82542175d51339701877d6`。
- Expo 镜像 `yishu-cloud-preview:preview-20261005-national`，ID `sha256:2e903d4bd0633c561e6b7ee2aee42eb11e2b8a5e40e8b9ebabb9ee12d88b4f4f`；在原滚动锁版本上只复制指定地图文件和已安装的纯 JS 依赖，保留图片交互等既有代码。
- MBTiles SHA-256 `21b5178b1cdb0d96922d26dde913b57c1799c53e131f4f6c8009fb53a14bced7` 两端一致；SQLite quick_check 为 ok，160,715 个瓦片。
- 公网实际解码上海、北京、武汉、成都、广州、乌鲁木齐、拉萨、海口、香港、澳门、台北 11 处瓦片，均包含主要道路；上海同时含水面与区界。地名哈希一致，gzip、CORS、immutable 缓存和 ETag 304 通过。
- `/NOTICE.txt`、`/ODBL_LICENSE`、`/source-report.json` 及完整 `/national-20261003-v2.mbtiles` 均位于上述版本前缀下；数据库下载流式输出，不整份加载到内存。任意文件读取和公开 `/api/v1/ready` 仍返回 404。
- 347 项移动端测试、TypeScript 和 6 项静态服务测试通过。服务器无网络、只读、非 root 的 iOS 导出通过（3337 模块、约 15 MB）；既有 google-services.json 未打入预览的配置警告保留，不代表 APK 或推送验收。
- Caddy 短暂重建以接入新网络；API、Worker、PostgreSQL、Redis 的镜像和启动时间逐字一致，业务 HTTPS 健康 200；没有数据库迁移、规则开关调整或 APK 构建。
- 部署脚本：`deploy/stage-national-map.sh`、`deploy/release-national-map.sh`；配置备份均带 `.before-national-20261005` 后缀。初次发布因旧 cloud.sh 未有执行权限而停止并恢复配置，随后改用显式 `sh` 调用成功；未更改文件权限。
- Expo 公网包最终验证及手机复验状态见 `CLOUD_EXPO_PREVIEW.md`；不能把 HTTP 和导出通过写成真机 PASS。

回退时仅恢复预览与网关两组配置，不回滚业务数据，旧镜像与版本数据保留：

```sh
cd /opt/yishu-preview
cp -p preview.env.before-national-20261005 preview.env
cp -p docker-compose.cloud-preview.yml.before-national-20261005 docker-compose.cloud-preview.yml
cp -p /opt/yishu/deploy/Caddyfile.cloud.before-national-20261005 /opt/yishu/deploy/Caddyfile.cloud
cp -p /opt/yishu/docker-compose.cloud.yml.before-national-20261005 /opt/yishu/docker-compose.cloud.yml
sh /opt/yishu/scripts/cloud.sh up -d --no-deps --wait caddy
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait preview
```

回退后重新核对免费隧道入口，已发布地图版本不能覆盖为不同内容。

## 再生成

GIS 工具在 `deploy/Dockerfile.map-gis`，固定 Python、pyosmium、Shapely、pyproj、osmium-tool 和 Tippecanoe 版本。
公开源文件下载到 `.local/water-source`，使用 `verify_map_sources.py` 验证后再生成。
先分别以 osmium tags-filter 保留行政关系 4/5/6、水面、海岸线及全部引用对象，合并两份快照、澳门关系和两份完整省级关系。
省级补充 XML 先 osmium sort 转成 PBF；不可使用 omit-referenced 选项。
道路单独过滤上述 highway 类型，再合并 China/Taiwan 提取文件。

```sh
docker run --rm --network none --memory=3g -v "$PWD:/workspace" yishu-gis-tools:local python scripts/gis/extract_national_map.py .local/water-source/national-complete.osm.pbf .local/maps
docker run --rm --network none --memory=2g -v "$PWD:/workspace" yishu-gis-tools:local python scripts/gis/extract_map_roads.py .local/water-source/national-roads.osm.pbf .local/maps
docker run --rm --network none --memory=4g -e TIPPECANOE_MAX_THREADS=2 -v "$PWD:/workspace" yishu-gis-tools:local tippecanoe -o .local/maps/national-20261003-v2.mbtiles -Z2 -z12 --full-detail=14 --low-detail=14 --minimum-detail=14 --simplify-only-low-zooms --no-tiny-polygon-reduction-at-maximum-zoom --no-tile-size-limit --no-feature-limit --no-progress-indicator --preserve-input-order --attribution='© OpenStreetMap contributors' .local/maps/national.geojsonseq .local/maps/roads.geojsonseq
```

Leaflet.VectorGrid 的渲染器和依赖许可随 App 打包，不依赖 CDN。
供应链声明和许可证在 `vendor/VECTOR_GRID_LICENSES`；OSM 的 ODbL 全文在 `data/maps/source/ODBL_LICENSE`。

## 验收与限制

验收记录会写入 `.local/maps/verification.json`；测试源文件也提供给复跑。
需要核对实际交付 MVT 的坐标，不只核对转换前的 GeoJSON。
检查上海沿江区界与已交付水面及源共享区界的偏差、31 个内地省级地名、全国抽样、两/三段业务路线、手机尺寸和实际拖动/缩放。

社区数据不是官方行政边界或地图审图证明。同源解决处理流程造成的错位，不等于全国每条河岸、道路和行政边界已经认证准确。
源数据中的错误面隔离，不擅自修复；缺漏/未闭合关系留在报告中，不伪造边界。
水面小于 5000 平方米有意忽略。各地道路/河流的完整度取决于源数据。
此次是用户授权的服务器试运行预览；正式地图发布门禁仍需单独核验适用地区的地图合规、边界表达和许可履行。服务器缓存与容量抽查已完成，不等于持续压测或地图审图认证。

### 本轮实际结果

- 全国归档 620,691,456 bytes（约 592 MiB），160,715 个静态瓦片，不打进 App。
- 289,368 个水面、38,058 段去重区界、17,970 段海岸线；道路提取没有非法几何，忽略小路。
- 31 个内地省级地名均存在；另外包含香港、澳门和 Taiwan extract 的地区数据。不是每个区县的完整度认证。
- 黄浦/浦东、虹口/浦东、杨浦/浦东的选定沿江窗口：源共享区界与交付瓦片偏差最大 0.283 m，水面 1 m 容差外长度为 0。这个数字只表示转换误差，不是原始地图测绘精度。
- 源面隔离 6 项；未闭合行政关系 365 项（含提取范围边缘及境外关系），详情留在报告，没有补画。
- 移动端全量 347 tests PASS，TypeScript PASS；Canvas 切换后的 21 项关键回归再次 PASS。
- 静态 HTTP 服务 5 项测试 PASS，运行容器健康；仅回环端口，无业务密钥挂载。
- 本机 iOS/Android 导出成功（切换 Canvas 之前）；尚未重新构建 APK，也未完成这版的手机真机验收。
- 浏览器实测上海两段路线、浙江三段路线、390×312 手机尺寸、缩放/拖动；上海画面从 24,207 个背景 SVG path 降到 25 个 Canvas、0 个背景 SVG path。
- 北京、武汉、成都、广州、乌鲁木齐、拉萨、海口、香港、澳门、台北均加载成功；截图在 `.local/maps/area-*.jpg`，没有浏览器错误日志。
