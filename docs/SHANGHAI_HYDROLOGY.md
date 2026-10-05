# 上海同源水系试点

日期：2026-10-04。仅本机候选背景；未部署服务器、未构建 APK。全国同源水系及地图公开发布审核未完成，不称为正式测绘图。

## 来源和处理

- 同源行政区界与水面来自 OpenStreetMap，固定 [Geofabrik 上海 2026-10-03 PBF](https://download.geofabrik.de/asia/china/shanghai.html)，快照时间 `2026-10-03T20:20:50Z`；SHA-256 和逐区关系 ID 见 [来源报告](../data/maps/shanghai-hydro-report.json)。
- PBF 切片缺少静安、宝山关系的部分成员，使用 OSM 官方 API `/relation/398353/full` 和 `/relation/398374/full` 补齐；校验固定哈希，所有补充对象更新时间不晚于共同快照。提取的无效源几何为 0；16 区按当前编号或上海范围内唯一精确名称匹配，不模糊改名。
- 显示范围限定 OSM 上海关系 `r913067`，区界与水面按相同范围裁切；补充关系中的范围外飞地不显示。原始源保留，不能把这份显示切片当作完整全国行政归属数据库。
- 使用 WGS84。区界和河面一起生成共享 TopoJSON，不独立简化、平滑、吸附或手绘补线；取消量化，避免窄多边形和孔洞被量化压塌。WebView 对 OSM 几何设 `smoothFactor: 0`。
- 水系绘制真实水面多边形，不把河道中心线拉宽充当河面。未命名多边形保留源 ID，不借附近河道名字强行命名。
- 水面最小面积 5000 平方米；缩放 6–9 显示至少 250000 平方米，9–11 至少 20000 平方米，11–13 至少 5000 平方米。几何不变，仅筛选小要素。没有在线瓦片、公共 Overpass 或地图 API 的运行时依赖。

## 黄浦江核验

核验窗口为经纬度 `[121.44, 31.20, 121.55, 31.26]`，距离在 EPSG:32651 中测量。原始源中窗口内浦东边界长约 11.43 千米，全部位于源河面内，河面外边界长度 0 米。

该区段的河道中心线与区界中位距离约 28 米、95 分位约 60 米。这不是绘图偏移修补的理由：河岸、河道中心线和行政分界线不是同一种几何，不能强制三者重合。试点要求的是同一坐标基准及可靠河面关系，而不是宣称中心线就是法定区界。

`verify_map_hydro.py` 对实际注入 WebView 的解码后多边形另行检查，不能只核对原始源。它检查所有几何有效、区名点位于区域内、窗口内区界不越出水面，并约束与源区界的处理误差。该抽样不代表整条黄浦江或全国每条河流已经人工审核。

## 生成与检查

GIS 工具仅装在 Docker；版本固定为 Pyosmium 4.3.1、Shapely 2.1.2、Pyproj 3.7.2。输入文件在忽略的 `.local/water-source` 目录，不进入线上密钥或数据库。

```sh
docker build -t yishu-gis-tools:local -f scripts/gis/Dockerfile .
docker run --rm --network none -v "$PWD:/workspace" yishu-gis-tools:local python scripts/gis/audit_osm_water.py .local/water-source/shanghai-261003.osm.pbf .local/water-source/shanghai-details.geojson
docker exec yishu-next-version-tools-1 node scripts/generate-shanghai-hydro.mjs
docker exec yishu-next-version-tools-1 pnpm --filter @yishu/api exec tsx ../../scripts/render-local-map-preview.ts
docker run --rm --network none -v "$PWD:/workspace" yishu-gis-tools:local python scripts/gis/verify_map_hydro.py
```

固定源缺失或哈希不匹配时生成器失败，不运行时下载、不偷偷回退粗略水系。证据输出 `.local/water-source/shanghai-rendered.audit.json`；浏览器截图另见 `.local/geographic-route-390.png`、`.local/geographic-route-1024.png`。

### 本机复验结果

- 实际解码的 16 区、2812 个水面多边形全部有效；核验窗口内区界落在河面外的长度 0 米，与源区界的处理偏差 0 米。仅针对该窗口，不推断其他河段。
- 上海黄浦、浦东及浙江海曙、余杭四个示例起终点均位于对应当前背景区域内；点位不是用户住址。
- 上海压缩包 1,933,062 字节，SHA-256 `d8e0e3c5c3392729f5e50987cd3b2e4237cc57ee80d60cf503f347c84d80972c`。
- Playwright + Edge 在 390×312、1024×700 下验证上海恰好两段、浙江恰好三段；水面实际显示，低精度重复实线不显示，缩放、平移、适配、轮询保持相机、标签避让通过，页面异常与外网请求为 0。
- Mobile 342 项、API 地图权限定向 4 项及移动端类型检查通过；iOS 3336 模块、Android 3473 模块资源导出通过，Hermes bundle 各约 15 MB。
- 以上不是两端真机或地图公开发布验收，不标记服务器业务规则上线。

## 权限与发布边界

背景是公开地理信息；路线、未来端点、预计位置仍仅使用服务端已过滤的 DTO。未改收件人事实权限、正文/图片/时间可见性、驿站或冻结业务坐标，也未启用规则 `1.1`。

数据遵循 [ODbL 1.0](https://www.openstreetmap.org/copyright)，完整许可在 `data/maps/source/ODBL_LICENSE` 并随 WebView 的 `osm-notice.json` 分发；画面保留 OpenStreetMap contributors 署名。公开发布前仍须审核派生数据库分享义务、源提供方式和地图内容合规，不能将开源许可等同于地图发布批准。
