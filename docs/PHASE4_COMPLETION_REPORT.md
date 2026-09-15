# 驿书 V1 — Phase 4 完成报告（Journey + Routing + TransportLeg）

> **归档说明（2026-09-15）**：本文保留 Phase 4 当时的实施与复评记录，以下“等待复核 / 未 commit / 未进入 Phase 5”均为历史状态，不代表当前项目进度。Phase 1–8 已通过 Final Gate，Phase 8 实现 baseline 为 `10963fb`；Phase 9 准入通过但尚未启动。当前状态以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 与根目录阶段规划为准。
>
> 生成时间：2026-08-24
> 角色：Phase 4 实操 Coding Agent（非 Review Agent）
> 结论：**Phase 4 实现完成 · Final Gate 三次评审：第一次 FAIL → 已修复；第二次 PASS WITH FIXES（MEDIUM×2 + LOW×1）→ 已修复；等待最终封板复核**
> 下一步指令：等待项目负责人进行最终封板复核；按指令**未 commit**、**未进入 Phase 5**。
>
> > **历史快照说明**：§1–§36 为首次实现时的记录；其后的评审修复以 §37+ 为准。§4/§5 中初版的数据路径、节点数、函数签名已在 §37/§45/§47–§49 更正，阅读时以复评修复记录为准。

---

## 1. 目标与范围

实现「本地静态 Graph + Dijkstra」路线规划，落地 Journey / TransportLeg 模型与初始化服务、PIGEON 特殊路由、Region→Station 映射、安全 API 视图、Mobile 基础路线展示，以及全部门禁（typecheck/lint/format:check/test/build/prisma:validate/prisma:generate）。Phase 5+（Simulation 推进 / 地图 / Push / WorldEvent）不在本次范围。

## 2. Prisma 模型 — Journey

- `Journey`：BIGINT 自增 id；`letterId` UNIQUE（Letter 1:1，并发竞态最终保障）；`originNodeId` / `destinationNodeId`（字符串稳定节点 id）；`status`（`JourneyStatus`：PLANNED/IN_PROGRESS/COMPLETED/CANCELLED，默认 PLANNED）；`rulesVersion` / `graphVersion` / `simulationSeed`（**继承 Letter 冻结值，Journey 不自行生成**）；`totalDistanceKm` Float；时间戳；`onDelete: Cascade` 关联 Letter；`legs TransportLeg[]`。

## 3. Prisma 模型 — TransportLeg

- `TransportLeg`：BIGINT id；`journeyId`；`sequence` Int；`(journeyId, sequence)` UNIQUE；`fromNodeId` / `toNodeId`；`transportType`（`TransportType`）；`distanceKm` Float（>0）；`plannedDurationSeconds` Int（仅内部 Simulation 输入）；`status`（`TransportLegStatus`：PLANNED/COMPLETED/CANCELLED，默认 PLANNED）；`onDelete: Cascade`。**不含**事件/掉落/疲劳等 Phase 5+ 字段。

## 4. Shared Types（@yishu/shared）

- 新增 `JourneyStatus` / `TransportLegStatus` enum 与 `JOURNEY_STATUSES` / `TRANSPORT_LEG_STATUSES`。
- `TRANSPORT_SPEEDS_KM_PER_DAY: Record<TransportType, number>`（冻结常量）：HAND_CARRY 35 / HORSE_RELAY 120 / EXPRESS_RELAY 300 / PIGEON 480 km/day。
- 版本化速度（复评 BLOCKER-1 修复，见 §37）：`TRANSPORT_SPEEDS_BY_RULES_VERSION` / `speedKmPerDay(rulesVersion, transportType)`；`plannedDurationSeconds(rulesVersion, transportType, distanceKm) = distanceKm / speed`（秒，内部仅用，用户 API 严禁暴露）；未知 `rulesVersion` 抛 `UnknownRulesVersionError`（路由 → 422）。
- > ⚠️ 历史快照：初版签名为 `plannedDurationSeconds(transportType, distanceKm)` 两参数，已在复评修复中废弃。

## 5. 静态路网数据

- 版本化数据目录（复评 BLOCKER-1 修复，见 §37）：`data/graphs/china-v1/{station_nodes,route_edges,region_station_map}.json` + `data/graphs/registry.json`（登记已知版本，未知版本明确拒绝）。
- 当前版本 `china-v1`：**294** 节点（真实中国城市/省会，稳定 id 如 `shanghai`/`beijing`，含重庆）、**1949** 条无向边（全连通；0 重复 city / 0 失效映射 / 0 孤立）。
- `data/gen_graph.cjs`：生成脚本（重生成后自动校验 + 写报告）；`data/validate_graph.cjs` + `pnpm graph:validate`：可重复校验并写 `data/GRAPH_VALIDATION_REPORT.json`。
- > ⚠️ 历史快照：初版为顶层 `data/station_nodes.json`（293 节点）/ `data/route_edges.json`（1943 边），已在复评修复中迁移至版本化目录并扩充数据（见 §37/§39）。

## 6. Graph 加载与校验（packages/routing）

- `loader.ts`：`buildGraph`（校验 + 无向双向展开 + 重复边检测，错误即抛）；`validateGraph` 返回 `nodeCount / edgeCount / connectedComponentCount / isolatedNodeCount / invalidEdgeCount / duplicateEdgeCount`。
- 校验项：节点 id 唯一、边端点存在、无自环、`distanceKm>0`、transport 合法、重复边检测、连通性。

## 7. Dijkstra（packages/routing/dijkstra.ts）

- 二叉最小堆（`MinHeap`，控制流收窄重写以兼容 `noUncheckedIndexedAccess` + 禁用 `!` 的 lint）。
- 唯一权重：`distanceKm`（无天气/拥堵/疲劳/随机）。
- 遍历前过滤：`enabled === true && allowedTransport.includes(transportType)`。
- 确定性 tie-break：node id 字典序（不依赖 Map 插入顺序）。
- `origin === destination` → 空路线、距离 0。
- 无连通 → 抛 `NoRouteError`（不 fallback 外部地图、不改 transport）。

## 8. PIGEON 特殊路由（packages/routing/pigeon.ts）

- 绕过 road graph，Haversine 大圆直线距离，单 leg，无 Dijkstra / 无在线地图。

## 9. 地理工具（packages/routing/geo.ts）

- `haversineKm(lat, lng, lat, lng)`：大圆距离（公里）。

## 10. Routing 包导出

- `buildGraph / validateGraph / findShortestPath / planPigeonRoute / getNode / haversineKm`；类型 `Graph / PathResult / StationNode / RouteEdge / EdgeStep / GraphValidationResult / NoRouteError / UnknownNodeError`。

## 11. Station Graph 访问层（apps/api/src/lib/stationGraph.ts）

- 从仓库 `data/` 读取三份文件并缓存（进程级单例，`resolveStationForRegion` / `planRoute` / `getStationNode` / `resetStationGraphCache`）。
- `resolveStationForRegion`：市精确 → 省会兜底，失败显式抛错（不依赖外部 geocoder）。
- `planRoute`：PIGEON → `planPigeonRoute`；ground → `findShortestPath`。

## 12. Journey 初始化服务（apps/api/src/lib/journey.ts）

- `initializeJourney(prisma, letterId)`：查 Letter（含现有 Journey，幂等）→ region→station → planRoute（PIGEON/ground）→ 事务原子创建 Journey + TransportLeg[]（5）→ Letter → DISPATCHED。
- `completedPath=[]` / `remainingPath=full route`（动态计算；completedPath 不可重写）。
- 并发幂等：`letterId` UNIQUE + 事务 + 检查后建；捕获 P2002（letterId 冲突）→ 重读现有 Journey 返回（200 幂等）。
- 自定义错误：`JourneyAlreadyExistsError` / `LetterNotFoundError` / `NoStationMappingError`。
- `toPathViews` / `stationName` / `publicRouteNodes`（安全视图，无 internal id）。

## 13. API — POST /letters/:trackingNo/journey

- 仅 Sender（preHandler 认证）；幂等：新建 201 / 已存在返回现有 200。
- 非 Sender（Recipient / 第三方）→ 404（不泄露 Letter 存在）。
- 无站点映射 → 422 `no_station_mapping`。

## 14. API — GET /letters/:trackingNo/journey

- Sender / Recipient 同视图；第三方 404；未初始化 → 404 `journey_not_initialized`。

## 15. 安全序列化（toJourneyView）

- 不含 internal id / `simulationSeed` / `plannedDuration` / ETA / 倒计时；仅暴露 station name + mapX/mapY + transportType + totalDistanceKm + status + routeNodes + completedPath/remainingPath + legs（name + distance + transport + status）。

## 16. Letter 详情集成 Journey 摘要

- `routes/letters.ts` 详情 `include` Journey+legs，`buildJourneySummary` 输出安全摘要（起点/终点 station name、总距离、legs 序列），不含 internal id/seed/ETA。

## 17. Mobile 基础路线展示

- `apps/mobile/src/api/letterApi.ts`：新增 `JourneyLegView` / `JourneyView` 类型，`LetterView.journey?`。
- `apps/mobile/app/letters/[trackingNo].tsx`：Journey 存在时渲染起点→终点、总距离、legs 列表（无地图、无 ETA）。

## 18. 速度常量与 plannedDuration

- 速度冻结于 `@yishu/shared`；`plannedDurationSeconds = distanceKm/speed`（秒），仅内部 Simulation 输入，用户 API 从不返回。

## 19. Region→Station 映射策略

- 市精确匹配 → 省会兜底；均无则抛 `no_station_mapping`，不 fallback 外部服务。

## 20. 并发幂等验证

- `letterId` UNIQUE 约束 + 事务 + 检查后建 + P2002 重读，保证同一 Letter 仅 1 个 Journey、Legs 不重复。

## 21. 测试 — routing 单元（18 项）

- loader 校验（节点唯一/边端点/无自环/距离/transport/重复/连通）；Dijkstra（最短/禁用边/运输限制/不连通/origin==dest/未知节点/距离累加/确定性 tie-break）；PIGEON 直连。

## 22. 测试 — journey 集成（6 项）

- ground HORSE_RELAY（创建 + 继承字段 + 原子 legs + completed/remaining）；PIGEON（单直连、900–1300km）；Sender 专属 / Recipient 404；并发仅 1 Journey；幂等 200；Sender/Recipient 同视图。

## 23. 测试 — 全 workspace

- api 85 + routing 18 + mobile 26 + worker 1 + config/shared/simulation/db（全 workspace 约 150+ tests）全部 PASS。

## 24. 图校验报告（data/GRAPH_VALIDATION_REPORT.json）

- nodeCount 293 / duplicateNodeIds 0 / edgeCount 1943 / invalidEdgeCount 0 / duplicateEdgeCount 0 / selfLoopCount 0 / invalidDistanceCount 0 / connectedComponentCount 1 / isolatedNodeCount 0 / fullyConnected true。

## 25. 迁移

- `prisma/migrations/20260824111606_add_journey_and_transport_leg/` 已 apply 到 dev（`yishu`）+ test（`yishu_test`）；两库均 5 个 migration、up to date、checksum 一致。

## 26. 门禁 — typecheck

- `pnpm typecheck` 全 workspace PASS（含 `noUncheckedIndexedAccess` 严格检查）。

## 27. 门禁 — lint

- `pnpm lint` 全 workspace PASS（ESLint，禁用 `!` 非 null 断言等）。

## 28. 门禁 — format:check

- `pnpm format:check` PASS（Prettier 全匹配）。

## 29. 门禁 — test

- `pnpm test` 全 workspace PASS（见 §23）。

## 30. 门禁 — build

- `pnpm build` 全 workspace PASS（含 mobile `expo export` native bundle、api/worker/routing 等 TS build）。

## 31. 门禁 — prisma:validate / prisma:generate

- 均 PASS；generate 产物位于 `generated/prisma`（gitignore）。

## 32. 门禁 — Docker / 健康 / 残留

- Docker PostgreSQL 17 + Redis 双容器 healthy。
- 构建产物 `apps/api/dist/server.js` 启动，`GET /api/v1/health` → 200（`{status:"ok",service:"yishu-api",...}`）。
- 开发库（`yishu`）User/Letter/Journey/TransportLeg 均 0 残留，测试仅污染 `*_test` 库。

## 33. 明确未实现（Phase 5+）

- Simulation 推进 Journey/Leg 状态（IN_PROGRESS/COMPLETED/TRANSPORT_CHANGED）；地图可视化；Push；BullMQ Worker 正式接入；WorldEvent/TimelineEvent；TransportLeg 事件/掉落/疲劳字段；reroute / ETA 倒计时。

## 34. 已知限制

- 静态图节点数 293（超过规范 §22 的 150–250「主要节点」目标，但覆盖全国主要城市，连通性 100%）。
- plannedDuration 仅作内部 Simulation 输入，未驱动任何对外 ETA/倒计时。
- 路线视图为文本/坐标，不含地图渲染。

## 35. 本次修复的关键缺陷（实现期）

1. Letter→Journey 关系命名 `journeys`→`journey`（1:1）并重建 db dist。
2. apps/api 补 `@yishu/routing` workspace 依赖；`TransportType` 改从 `@yishu/shared` 导入。
3. MinHeap 去 `!` 断言（控制流收窄）。
4. POST handler 合并 `result.legs` 进视图（修复 legs undefined 导致的 500）。
5. 测试经 `letterIdOf(trackingNo)` 反查 internal id（Letter 视图按安全设计不暴露 id）。
6. `initializeJourney` 捕获 P2002 重读现有 Journey（并发幂等 200）。

## 36. 提交与后续

- **按指令未 commit、未进入 Phase 5。**
- 等待项目负责人执行 Phase 4 Final Gate Review；复审通过后按其指示再 commit。
- README 已更新为「Phase 4 实现完成 · Final Gate 待复审」+ Phase 4 完成小节 + 未实现列表收窄。

---

# 复评修复记录（第一次 Final Gate FAIL → 已全部修复，等待复审）

评审结论：BLOCKER×2 / HIGH×3 / MEDIUM×3。以下按评审「最小修复」逐项落地。

## 37. BLOCKER-1：graphVersion / rulesVersion 真实参与图与规则选择

- 静态数据改为按版本索引：`data/graphs/china-v1/{station_nodes,route_edges,region_station_map}.json` + `data/graphs/registry.json`（登记已知版本）；顶层旧数据删除。
- `stationGraph.ts`：`loadGraph(graphVersion)` / `planRoute({graphVersion, ...})` / `resolveStationForRegion(region, graphVersion)` / `getStationNode(id, graphVersion)`；注册表校验，未知版本抛 `UnknownGraphVersionError` → 路由 422，不静默 fallback。
- `@yishu/shared`：`TRANSPORT_SPEEDS_BY_RULES_VERSION` / `speedKmPerDay(rulesVersion, transportType)` / `plannedDurationSeconds(rulesVersion, transportType, distanceKm)`；未知 rulesVersion 抛 `UnknownRulesVersionError` → 路由 422。
- `initializeJourney` 全程使用 Letter 冻结的 graphVersion / rulesVersion。
- 确定性测试：stationGraph.test.ts（未知版本拒绝）、journeys.integration.test.ts（china-v999 / 999.0 → 422）、shared.test.ts（版本语义）、routing.test.ts（graphVersion 传播）。

## 38. BLOCKER-2：format Gate 恢复 PASS

- `pnpm format` 修复报告等文件；`pnpm format:check` → PASS。

## 39. HIGH-1：Region→Station 生产数据修复

- 新增重庆节点（`chongqing`，lat 29.563 / lng 106.5514）并接入骨干（西安 / 成都）；`cities["重庆市"]` / `provinces["重庆市"]` = chongqing。
- 赤峰「赤赤峰市」→「赤峰市」；莱州 city「烟台市」→「莱州市」，`cities["烟台市"]` = yantai（不再被覆盖）。
- `gen_graph.cjs` 内置自动校验：重复 city（防止后写覆盖）、映射指向有效节点、省级覆盖、连通性；生成后调用 `validate_graph.cjs` 写报告。
- `resolveStationForRegion` 改抛类型化 `NoStationMappingError` → 路由 422（不再 500）。

## 40. HIGH-2：禁止非 CREATED Letter 初始化

- 仅 `status === CREATED` 可初始化，否则 `LetterNotCreatedError` → 409；幂等优先（已有 Journey 先返回 200）。
- 事务内 `updateMany(where id + status=CREATED)` 条件更新，防止终态 / 并发状态下状态倒退。
- 测试：DELIVERED 信初始化 → 409，且不创建 Journey、状态不回退（deliveredAt 保留）。

## 41. HIGH-3：同站点 PIGEON 运输方式

- `toJourneyView` 增参 `transportType`（来自 `letter.initialTransport`）+ `graphVersion`；删除 HAND_CARRY 兜底。
- 测试：上海→上海 PIGEON → transportType=PIGEON、零 leg、距离 0。

## 42. MEDIUM-1：并发 HTTP 幂等语义

- `initializeJourney` 返回 `created`；P2002（letterId，driver adapter 约束字段名去引号规范化）重读 → created:false → HTTP 200；只识别 letterId 约束，无法确认重新抛出。
- 测试严格断言并发结果 = `[200, 201]`（连续 3 轮稳定）。

## 43. MEDIUM-2：Leg 顺序确定性

- 所有 Journey relation 查询统一 `orderBy: { sequence: "asc" }`（POST / GET / 幂等重读 / Letter 详情）。

## 44. MEDIUM-3：图报告可重复生成 + 文档同步

- 新增 `data/validate_graph.cjs` + 根脚本 `pnpm graph:validate`；`gen_graph.cjs` 重生成后自动写报告。
- 同步 `docs/PROJECT_STATUS.md`（Phase 4 IMPLEMENTED、165 tests、5 migration）与 `data/README.md`。

## 45. 复评门禁（全部 PASS）

- typecheck / lint / format:check / build / prisma:validate / prisma:generate / graph:validate 全 PASS。
- test：**165 passed / 0 failed**（shared 4、simulation 1、config 19、db 2、worker 1、routing 19、mobile 26、api 93）。
- 图数据：294 节点 / 1949 边 / 全连通 / 0 重复 city / 0 失效映射。
- dev 库 0 残留；两库 5 migration up to date；Docker healthy。

## 46. 结论（等待复审确认）

- FINAL GATE：PASS（复评修复后）——待项目负责人复审确认。
- PHASE 4 COMPLETE：YES（按评审全部修复）。
- MAY START PHASE 5：NO（须复审通过后由项目负责人指示）。
- 仍未 commit、未进入 Phase 5。

---

# 二次复评修复记录（第二次 PASS WITH FIXES → 已修复，等待最终封板复核）

第二次评审结论：未发现 BLOCKER/HIGH；MEDIUM×2 + LOW×1，全部修复。

## 47. MEDIUM-1：Journey 状态竞态返回 500

- 根因：`LetterStatusConflictError` 在 service 内被重新抛出，但路由未映射，落入统一 500。
- 修复：`journey.ts` 导出 `LetterStatusConflictError`；`journeys.ts` 路由 catch 映射为 **409 `letter_status_conflict`**（明确业务冲突，不再 500）。
- 新增确定性行锁集成测试：并发事务以 `SELECT ... FOR UPDATE` 持有 Letter 行锁 → 主线程初始化读到 CREATED → 条件更新阻塞 → 并发事务改为 DELIVERED 提交 → 条件更新匹配 0 行 → 整体回滚并返回 409；断言 Journey=0、Letter 保持 DELIVERED、deliveredAt 保留。

## 48. MEDIUM-2：状态文档漂移同步

- `docs/PROJECT_STATUS.md`：Vitest 153 → **166**（shared 4 / config 19 / db 2 / worker 1 / simulation 1 / routing 19 / mobile 26 / api 94）；Graph validation 补充 isolated/disabled 语义；Worker/BullMQ 阶段编号 **Phase 6 → Phase 9**（与阶段规划 §11 一致）。
- `README.md`：Shared Types 更新为版本化签名 `speedKmPerDay(rulesVersion, transportType)` / `plannedDurationSeconds(rulesVersion, transportType, distanceKm)`；Phase 4 测试更新为 routing 19 / journey 11；未完成列表标注对应 Phase 编号（Simulation=5、WorldEvent=6、Timeline=7、地图=8、Push/BullMQ=9）。
- `docs/PHASE4_COMPLETION_REPORT.md`：头部标注历史快照说明；§4（签名）、§5（数据路径/数量）更正并标记历史快照；§36 结论更新。

## 49. LOW-3：图校验器统计语义修正

- `data/validate_graph.cjs` 重写：
  - `isolatedNodeCount` 按**有效度数**统计（无任何有效边端点的节点），不再用 `ids.size - visited.size`（后者恒为 0，不可信）。
  - `enabled=false` 是**合法禁用边**：不判 invalid、仍参与去重，但不加入有效 adjacency（不计入连通性）。
  - 新增 `selftest()`（isolated/disabled fixtures），`node data/validate_graph.cjs` 与 `pnpm graph:validate` 均先跑 selftest。
- 生产图重算不受影响：294 节点 / 1949 边 / 1 连通分量 / 0 孤立 / 0 重复 / 0 失效映射 / `disabledEdgeCount=0`。

## 50. 终检门禁（全部 PASS）

- typecheck / lint / format:check / build / prisma:validate / prisma:generate / graph:validate（含 selftest）全 PASS。
- test：**166 passed / 0 failed**（shared 4、config 19、db 2、worker 1、simulation 1、routing 19、mobile 26、api 94）。
- journey 集成 11 项（含行锁竞态 409、未知版本 422、非 CREATED 409、同站点 PIGEON）。
- dev 库 0 残留；两库 5 migration up to date；Docker healthy。

## 51. 结论（等待最终封板复核）

- FINAL GATE：PASS（二次复评修复后）——待项目负责人最终封板复核确认。
- PHASE 4 COMPLETE：YES（按评审全部修复）。
- MAY START PHASE 5：NO（须封板复核通过后由项目负责人指示）。
- 仍未 commit、未进入 Phase 5。

---

# 三次复评修复记录（第三次 PASS WITH FIXES → 已修复，等待最终封板复核）

第三次评审结论：未发现 BLOCKER/HIGH；MEDIUM×2 + LOW×1，全部修复。

## 52. MEDIUM-1：Journey 竞态集成测试依赖固定延迟

- 问题：测试在取得 `FOR UPDATE` 锁后固定等待 800ms，未确认初始化事务已阻塞在行锁上，存在结构性 flaky 风险。
- 修复（确定性交错，无固定延迟）：
  1. **握手**：T1 取得行锁后 resolve `lockHeld` promise；主测试确认后再放行（`goT1`）。
  2. **轮询确认**：主测试启动 `initJourney`（不 await）后，用 `waitForRowLockWait()` 轮询 `pg_stat_activity` 中 `wait_event_type='Lock' AND wait_event='transactionid'`（排除自身会话），确认 init 事务已进入行锁等待，再 `onGo()` 放行 T1 提交 DELIVERED。
  - **关键坑**：等待 `FOR UPDATE` 行锁的 UPDATE 在 `pg_locks` 中表现为 `locktype='transactionid'`（ShareLock, NOT granted）而非 `tuple`；初版按 `tuple` 轮询永远超时。已用探针脚本实证并改用 `pg_stat_activity` 判断。
  - 验证：连跑 5 轮全部 11/11 PASS，无 flaky。
- 生产代码无改动（已正确抛出并映射 409）。

## 53. MEDIUM-2：阶段与版本文档统一

- `docs/PROJECT_STATUS.md`：下一阶段规则 `Phase 4` → **Phase 5**（基线 Phase 1–4）；Prisma 锁定版本 `7.1.5` → **7.9.1**。
- `README.md`：未完成列表统一阶段语义——Journey/Leg 运行期状态推进属 **Phase 5（Simulation Core + Transport Progression，由 SimulationClock/DeterministicRandom 驱动）**；后台化调度消费与 BullMQ Worker 属 **Phase 9（Worker Scheduling + Push + Refresh）**。
- `apps/worker/src/index.ts`：注释 `BullMQ / Redis 消费者将在 Phase 6 实现` → **Phase 9**。
- 统一依据：根目录 `驿书_V1_Coding_Agent_阶段规划.md`（Phase 编号唯一来源）。

## 54. LOW-1：Graph Validator 自测覆盖与 CLI 语义

- `data/validate_graph.cjs` selftest 增加**重复 disabled 边**断言：重复禁用边仍去重（`duplicateEdgeCount=1`）、不判 invalid、`disabledEdgeCount` 只计 1。
- CLI 支持 `--selftest`：仅运行自测，**不写** `GRAPH_VALIDATION_REPORT.json`；默认模式仍先 selftest 再 run()。
- 验证：`node data/validate_graph.cjs --selftest` → `OK (no report written)`；`node data/validate_graph.cjs` → `OK (selftest PASS)`。

## 55. 三次终检门禁（全部 PASS）

- typecheck / lint / format:check / build / prisma:validate / prisma:generate（7.9.1）/ graph:validate（含 selftest + `--selftest`）全 PASS。
- test：**166 passed / 0 failed**（shared 4、config 19、db 2、worker 1、simulation 1、routing 19、mobile 26、api 94）。
- journey 集成 11 项（行锁竞态确定性握手 409 连跑 5 轮稳定）。
- dev 库 0 残留；两库 5 migration up to date；Docker healthy。

## 56. 结论（等待最终封板复核）

- FINAL GATE：PASS（三次复评修复后）——待项目负责人最终封板复核确认。
- PHASE 4 COMPLETE：YES（按评审全部修复）。
- MAY START PHASE 5：NO（须封板复核通过后由项目负责人指示）。
- 仍未 commit、未进入 Phase 5。
