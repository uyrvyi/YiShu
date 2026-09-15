# data

存放本地静态数据（对应开发规范 §15）：

- `graphs/registry.json`：图版本注册表（`versions` / `defaultVersion`）；未知版本被明确拒绝，不静默 fallback。**`defaultVersion` 是新信件默认图版本的唯一来源**（业务代码禁止硬编码版本号）。
- `graphs/<graphVersion>/`：按版本索引的数据目录：
  - `china-v1`：**Phase 4 字节冻结基线**（三资产 SHA-256 固定，由 `apps/api/src/lib/graph-data.test.ts` 断言 + 重生成逐字节复现）；
  - `china-v2`：Phase 8 复核新增（同一算法 + **唯一获批**的 `yangquan` 坐标修正，见 `gen_graph.cjs` 的 `VERSION_OVERRIDES`）；
  - `station_nodes.json`：驿站节点（id / name / province / city / lat / lng / mapX / mapY）
  - `route_edges.json`：路线边（from / to / distanceKm / enabled / allowedTransport）
  - `region_station_map.json`：Region → Station 映射（`cities` 市精确 / `provinces` 省级兜底；确定性，无 GPS / geocoder）
- `GRAPH_VALIDATION_REPORT.json`：图校验报告（由 `pnpm graph:validate` 或 `node data/gen_graph.cjs` 生成，报告与数据永不漂移；**registry 全版本**逐一校验）
- **版本纪律**：冻结版本**禁止原地改写**（任何字节差异都视为回归）；数据修正只能通过**新增版本**表达，
  用户可见的位置修正走 `maps/station-display-corrections.json`（只改渲染坐标，不改路由 / 距离 / World Truth）。
- `maps/`：Phase 8 本地地图资产（详见 [`maps/README.md`](maps/README.md)，其中含 source / license 真相源）：
  - `maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson`：**vendored 行政边界源**
    （geoBoundaries `gbOpen / CHN / ADM1`，pinned revision，离线只读、SHA-256 校验）
  - `maps/station-display-corrections.json`：**显示坐标修正表**（人工批准、可追溯：`lat` / `lng` / `source` / `reason`）。
    只影响用户可见地图的渲染坐标（`apps/api/src/lib/map-station-point.ts` 加载时校验后缓存），**不改写**冻结图数据、
    不影响路由 / 距离 / World Truth；**加载即完整校验**（对象结构 / 版本登记 / 站点归属 / 来源字段 / 无未知字段 /
    经纬度范围 / 投影后落在 `MAP_DATA_BOUNDS` 内 / 版本对象不得为空），任一不满足明确抛错（fail fast，
    绝不静默回退到冻结坐标；规则与故障注入测试见 [`maps/README.md`](maps/README.md)）。
    当前仅登记 `china-v1/yangquan`（Phase 4 冻结坐标落在河南省一侧）。
  - `china-map.svg`：可直接预览的 SVG 产物（国家轮廓 + ADM1 边界）
  - `china-districts.json`：canonical 结构化几何 / 34 个 ADM1 形状 / `MAP_FIT` 与来源元数据
  - `apps/mobile/src/map/chinaMapData.ts`：Mobile 打包使用的生成模块（输出到 apps 侧）
- `gen_graph.cjs`：一次性/可重复生成脚本（重跑会校验：节点 id 唯一、边端点存在、无自环、distance>0、transport 合法、重复边、连通性、重复 city、映射指向有效节点、省级覆盖，并重新生成校验报告）
- `gen_map.cjs`：地图资产生成器（Phase 8；读 `maps/source/` 的 vendored 行政边界源 + `graphs/<version>/station_nodes.json` 的站点锚点，确定性输出，不含时间戳 / 随机值，可重复执行）
- `map_projection.cjs`：Phase 4 canonical projection helper（`lng/lat → mapX/mapY`；边界与站点共用同一公式，禁止第二套投影）

> **两类数据源职责独立**：`graphs/` 是**路网 / 站点**数据（route anchor、Journey 几何），
> `maps/source/` 是**行政边界底图**数据；二者不互相推导（station 点云不再是边界来源）。

- `validate_graph.cjs`：独立校验 + 报告命令（`pnpm graph:validate`）

## 校验 / 生成命令

```bash
pnpm graph:validate   # 校验 data/graphs/<version>/ 并写出 GRAPH_VALIDATION_REPORT.json
pnpm map:generate     # 生成 data/maps/china-map.svg + data/maps/china-districts.json + apps/mobile/src/map/chinaMapData.ts
```
