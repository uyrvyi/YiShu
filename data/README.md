# data

存放本地静态数据（对应开发规范 §15）：

- `graphs/registry.json`：图版本注册表（`versions` / `defaultVersion`）；未知版本被明确拒绝，不静默 fallback。
- `graphs/<graphVersion>/`：按版本索引的数据目录（Phase 4 起，当前 `china-v1`）：
  - `station_nodes.json`：驿站节点（id / name / province / city / lat / lng / mapX / mapY）
  - `route_edges.json`：路线边（from / to / distanceKm / enabled / allowedTransport）
  - `region_station_map.json`：Region → Station 映射（`cities` 市精确 / `provinces` 省级兜底；确定性，无 GPS / geocoder）
- `GRAPH_VALIDATION_REPORT.json`：图校验报告（由 `pnpm graph:validate` 或 `node data/gen_graph.cjs` 生成，报告与数据永不漂移）
- `maps/`：本地地图数据
- `gen_graph.cjs`：一次性/可重复生成脚本（重跑会校验：节点 id 唯一、边端点存在、无自环、distance>0、transport 合法、重复边、连通性、重复 city、映射指向有效节点、省级覆盖，并重新生成校验报告）
- `validate_graph.cjs`：独立校验 + 报告命令（`pnpm graph:validate`）

## 校验命令

```bash
pnpm graph:validate   # 校验 data/graphs/<version>/ 并写出 GRAPH_VALIDATION_REPORT.json
```
