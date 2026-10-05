# data/maps

Phase 8（Local Map + Journey Visualization）的**完全离线**地图资产目录（开发规范 §14 / §15 / §17 / §18）。

> 本文件是地图资产的 **source / license 真相源**：上游版本、boundaryID、许可、源文件 SHA-256、
> 变换方式与「非法律边界认定」声明都以此处为准；其他文档只引用，不重复版本号。

## 资产清单

| 路径                                                    | 类型                    | 说明                                                                            |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `source/geoBoundaries-CHN-ADM1-2019-simplified.geojson` | **vendored source**     | 冻结的上游行政边界数据（只读输入；见下「数据源」）                              |
| `china-map.svg`                                         | 生成产物                | 可直接预览的 SVG（国家轮廓 + ADM1 边界），与 Mobile 渲染使用同一坐标系          |
| `china-districts.json`                                  | 生成产物                | canonical 结构化几何（轮廓 / 34 个 ADM1 形状 / fit 元数据 / 来源元数据）        |
| `apps/mobile/src/map/chinaMapData.ts`                   | 生成产物（输出到 apps） | Mobile bundle 使用的 TS 模块（`CHINA_MAP_OUTLINE_D` / `CHINA_PROVINCE_SHAPES`） |
| `station-display-corrections.json`                      | 人工批准配置（手写）    | 站点**显示坐标**修正（见下「显示坐标修正（display-only）」）                    |

> 说明：`china-districts.json` **文件名沿用历史命名**，其内容是 **ADM1（province-level）** 几何，
> 不是 district / 区县边界；不要按文件名误读语义。

## 数据源（source / license / integrity）

| 项                                               | 值                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider                                         | geoBoundaries                                                                                                                              |
| Dataset                                          | `gbOpen`                                                                                                                                   |
| ISO / boundary type                              | `CHN` / `ADM1`                                                                                                                             |
| boundaryID                                       | `CHN-ADM1-43563684`                                                                                                                        |
| boundaryCanonical（上游字段原文）                | `People’s Republic of China`                                                                                                               |
| boundaryYearRepresented                          | 2019                                                                                                                                       |
| Pinned upstream revision                         | `9469f09`                                                                                                                                  |
| Input artifact                                   | `geoBoundaries-CHN-ADM1_simplified.geojson`                                                                                                |
| ADM1 feature count                               | 34                                                                                                                                         |
| Route station province count（station graph 侧） | 31                                                                                                                                         |
| Upstream license（该 boundary metadata）         | `Public Domain`                                                                                                                            |
| Upstream license 说明                            | geoBoundaries `gbOpen` 总体按 CC-BY 4.0 说明；本仓库采取保守策略：保留 attribution、记录 provider / dataset / revision / boundaryID / year |
| Upstream source                                  | `geoBoundaries, Wikimedia Commons`（sourceDataUpdateDate 2023-01-19 / buildDate 2023-12-12）                                               |
| **Source SHA-256**                               | `bc4afc7eacf4351ae5b3ae7a612327987ce1123cb5deb8574fb49107091c6623`（263343 bytes）                                                         |
| Vendored 方式                                    | 从 pinned revision 一次性取得后写入仓库（Git LFS 以 oid 提供同一 SHA-256）；**不在构建或运行时下载**                                       |
| Runtime                                          | **完全离线**：无网络请求、无在线瓦片 / geocoder / 商业地图 SDK                                                                             |

### 变换（transformation）

```text
源几何 lng/lat
  → Phase 4 canonical projection（data/map_projection.cjs，与 294 个 station 的 mapX/mapY 同一公式）
  → mapX/mapY（world 1000x800 空间）
  → MAP_FIT（@yishu/shared，等比居中；viewBox "0 0 1000 800"）
  → SVG / JSON / TS 资产
```

- 仅做 **projection + 定点小数序列化**：**不做** Douglas-Peucker 再简化、不做凸包 / 外扩 / buffer /
  六边形化（源本身已是 `_simplified`）。
- 轮廓（China outline）= **全部 34 个 ADM1 geometry 的 union**（`polygon-clipping`，生成器专用
  devDependency），保留源拓扑与全部岛屿（MultiPolygon 不丢环）。
- station graph（`data/graphs/china-v1/station_nodes.json`）**只提供** route anchor / 站点位置 /
  Journey 几何；**不再是** China outline 或 province boundary 的来源。
- 生成器把路线锚点来源**固定**为冻结基线 `china-v1`（`MAP_VERSION`）：地图几何资产不随
  `station-display-corrections.json` 这类 display-only 修正漂移。

### 生成

```bash
pnpm map:generate        # = node data/gen_map.cjs（离线、幂等；校验 source SHA-256）
```

生成器 `data/gen_map.cjs` 只读 vendored source（无网络访问）；连续执行两次产出字节一致。

### 生成产物哈希（2026-09-14 实测；连续两次执行字节一致）

| 产物                                  | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `data/maps/china-districts.json`      | `85dd6c60caa7d34951d43bbc4878906cecb48f2f83b4f3eb86bf174760e2f48e` |
| `data/maps/china-map.svg`             | `6ac9fb992988745e2ea5a9592356cf6a361009c3f7e3aaf81eb571a70bcb242e` |
| `apps/mobile/src/map/chinaMapData.ts` | `f7c40dee2bf35c1c4975ae6dddf915812bea7b2df7517eae1349cc8dd5773f7a` |
| vendored source（输入）               | `bc4afc7eacf4351ae5b3ae7a612327987ce1123cb5deb8574fb49107091c6623` |

## 显示坐标修正（display-only）

`station-display-corrections.json` 解决「Phase 4 冻结站点坐标近似导致用户可见位置跨省」的问题，
**只改渲染坐标**：

- **范围**：仅影响用户可见地图上的站点绘制位置（`apps/api/src/lib/map-station-point.ts` 读取并校验，
  API Map DTO 输出修正后的 `mapX` / `mapY`）。**不改** 冻结图数据、路由、距离、`WorldEvent` /
  `World Truth`、Timeline 事实或地图生成产物。
- **版本承载**：修正按图版本键（`{ "<graphVersion>": { "<stationId>": { lat, lng, source, reason } } }`）。
  `china-v1` 保持字节冻结，用户可见修正不改写冻结版本；同时新增 `china-v2` 版本承载同一修正
  （用于新信件，见 `data/README.md` 版本纪律）。
- **不变量（违规即失败）**：`apps/api/src/lib/map-station-point.ts` **在加载时**执行完整校验并在进程内
  缓存；**任何一项不满足立即抛错**（`station_display_corrections_invalid`），**绝不静默回退到冻结坐标**
  （否则配置错误会让跨省显示悄悄复现）：
  1. **对象结构**：顶层必须是 `{ [graphVersion]: { [nodeId]: entry } }` 形式的普通对象（数组 / `null` /
     字符串 / 数字一律拒绝）；每个版本的值必须是普通对象，且**不得为空对象**（空版本对象 = 无效声明）；
     顶层 `{}` 表示「当前无需显示修正」（合法但当前不适用）。
  2. **版本存在性**：每个版本 key 必须是 `data/graphs/registry.json` 已登记的图版本。
  3. **站点存在性**：每个 `nodeId` 必须存在于该版本的 `station_nodes.json`（拼写错误即失败）。
  4. **来源字段**：每条必须带**非空字符串** `source` 与 `reason`，且**只允许** `lat` / `lng` / `source` /
     `reason` 四个字段（未知字段即失败）。
  5. **坐标边界**：`lat` / `lng` 必须是有限数且在合法经纬度范围内，且投影到 `mapX` / `mapY` 后必须落在
     冻结的 `MAP_DATA_BOUNDS`（`@yishu/shared`）内。
     文件缺失或 JSON 解析失败 → `station_display_corrections_unreadable`。上述规则由
     `apps/api/src/lib/map-station-point.test.ts` 的**内存故障注入测试**覆盖（只注入内存、不写文件）。
- **可追溯**：每条修正必须携带 `lat` / `lng` / `source`（上游依据）与 `reason`（为何修正）。
- **非目标**：不使用在线 geocoder、不重新下载边界、不重生成 `china-map.svg` / `china-districts.json`
  （生成器不读取本文件）。

## 许可与发布合规（license ≠ 监管合规）

- 本目录内容来自 **open static administrative boundary dataset**，用于 **V1 本地可视化**：
  它是开源数据，**不是官方测绘成果**，**不是具有法律效力的行政边界认定文件**。
- License 与监管合规是两个问题：**面向中国大陆公开发布前，Phase 12 Release Gate 必须另行检查
  地图内容与发布合规要求**（本项目不声称该数据已满足任何地图监管要求）。

## 区县候选代表点（2026-10-04，本机验证）

新增 `district-anchors.json`，不是 `china-districts.json` 的省级边界改名，也不是完整当前区县库。它从固定 geoBoundaries ADM3 2017 源生成候选代表点；2281 个名称匹配、775 个缺失，省内名称匹配仍须核验城市归属和行政区变更。原形状 ID、源哈希、ODbL-1.0 许可和未批准发布状态保留在文件中。缺失点不允许回退到市中心冒充区县。

来源、生成方式、覆盖缺口与启用门禁详见 [区县运输地图](../../docs/DISTRICT_TRANSPORT_MAP.md)。省级边界继续使用上述冻结源，显示投影修正见下一节，不改变业务路由或原地图数据的发布审查要求。

## 等比地理显示投影（2026-10-04）

旧 `mapX/mapY` 是冻结业务空间，不适合直接作为显示地图的横纵比例。交互地图改用 [Leaflet EPSG:3857](https://leafletjs.com/reference.html#crs-epsg3857)，将同一 ADM1 WGS84 源交给标准地理投影；业务点先反解经纬度，再交给同一投影绘制。

静态兜底由 `node scripts/generate-geographic-map.mjs` 生成，使用 [Turf toMercator](https://turfjs.org/docs/api/toMercator) 和单一比例等比拟合到 1000×800。新增资产：`apps/mobile/src/map/chinaGeographicData.ts`、`data/maps/china-geographic-map.svg`。生成器校验源哈希，保留全部 34 个 Feature、Polygon/MultiPolygon 和环，不额外简化，不手画或修改国界。旧 `china-districts.json`、`china-map.svg`、`chinaMapData.ts` 和驿站图仍保留冻结，不用于新版显示投影。

这只是显示比例修复，不代表地图内容合规审核完成；原许可、历史边界和公开发布门禁继续适用。

## 分级背景细节（2026-10-04，本机候选）

新增 `apps/mobile/src/map/detailData/` 的离线省份包，补充市级/区县边界和名称；粗略水系候选因不能满足区县级空间对齐要求已停用显示，不修改上述冻结 ADM1 几何、驿站图或业务端点库。

| 项目                     | 值                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行政数据源               | [GaryBikini/ChinaAdminDivisonSHP](https://github.com/GaryBikini/ChinaAdminDivisonSHP)                                                                |
| 固定版本 / 版次          | `ae72417fee2a63f453e6b2717e40655e87e26887` / `v24.02.06`                                                                                             |
| 行政源许可               | 仓库 MIT；高德来源的再分发权利仍待核验，不能将仓库许可当作上游授权                                                                                   |
| 坐标转换                 | 源实际 GCJ-02，生成时 gcoord 转为 WGS84                                                                                                              |
| 匹配与缺口               | 364 个市级条目、2839 个区县；217 个选择器区县缺失，46 个源条目因编号/名称/归属不匹配拒绝                                                             |
| 上海背景                 | 16/16 区；与仍缺闵行、金山的后端候选端点库分离                                                                                                       |
| 水系源                   | [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) `ca96624a56bd078437bca8184e78163e5039ad19`；1:10m 概略河流/湖泊，public domain |
| 输出编码                 | TopoJSON 量化 1e6、deflateRaw、base64；省份懒解码                                                                                                    |
| 生成器                   | `scripts/generate-map-details.mjs`，只读固定 SHA-256 的本地源                                                                                        |
| 逐文件校验 / 拒绝 / 缺失 | `detail-source-report.json`                                                                                                                          |
| 完整通知                 | `source/ADMIN_DETAIL_LICENSE`、随 WebView 分发的 `detailData/notices.json`                                                                           |
| 发布状态                 | `releaseApproval: pending`，仅本机候选；未同步服务器或更新 APK                                                                                       |

缩放策略、离线体积、加载缓存和验证证据见 [离线分级运输底图](../../docs/OFFLINE_MAP_DETAILS.md)。开源来源、字段匹配和自动化通过不等于当前全国覆盖或地图公开发布审核通过。
