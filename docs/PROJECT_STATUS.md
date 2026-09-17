# 驿书 V1 项目状态

> 更新时间：2026-09-17
> 当前基线：**Phase 9 Final Gate PASS · Phase 9 COMPLETE（Worker Scheduling + Push + Refresh）**
> Phase 8：**独立 Final Gate PASS（2026-09-15）**；BLOCKER / HIGH / MEDIUM / LOW 均为 NONE；实现 baseline commit `10963fb`。
> 下一阶段：**Phase 10 — Mobile V1 Integration + UX Closure（NOT STARTED）**。准入已通过，启动需另行授权。本轮仅授权本地 baseline commit，不 Push。

## Phase 完成情况

| Phase                | 状态                        | 已完成范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1：项目骨架    | COMPLETE                    | pnpm workspace、Mobile/API/Worker、共享包、Prisma、PostgreSQL、Redis、Docker、严格 TypeScript、ESLint、Prettier、Vitest、构建与健康检查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase 2：账号与身份  | COMPLETE                    | User/Block/RefreshToken、注册登录、8 位 UID、Argon2id、JWT、Refresh Token Hash、TEST_DATABASE_URL 隔离、用户搜索、SecureStore 与 Mobile Auth Session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase 3：Letter 核心 | COMPLETE                    | Letter/RecipientState/SenderState、Tracking Number、AES-256-GCM、创建幂等、Block 并发拦截、列表/详情/open/hide、Mobile 基础信件流程                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phase 4：Routing     | COMPLETE                    | 版本化静态路网（data/graphs/china-v1）、Graph 加载与校验、Dijkstra、PIGEON 直连、Journey/TransportLeg、Journey 初始化服务、安全 API、Mobile 路线文本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase 5：Simulation  | COMPLETE                    | SimulationClock（System/Test）、DeterministicRandom 基础设施、advanceJourneyToNow 确定性推进（多 Leg 结余传递、OUT_FOR_DELIVERY→DELIVERED、并发/幂等/时间倒退契约）、Prisma 模拟时间字段、集成测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Phase 6：World Truth | COMPLETE                    | WorldEvent 模型、(journeyId,eventIndex) 唯一、冻结概率表（§28–§36）、每 Leg 一次 primary event 持久化（primaryEventIndex/outcome/delaySeconds，DELAY 冻结延长）、可重复 progression loop（一次大跳跃与分段推进完全一致）、reroute 后继续消费剩余模拟时间、Recovery + 自动运输变更（按新 transport 重建路线，PIGEON↔ground 语义）、WorldEvent 稳定位置（nodeId/transportLegSequence）、7 日 PERMANENTLY_LOST、PIGEON 严重事故 DESTROYED、completedPath 不变量、totalDistanceKm 同步、并发/幂等/回滚无半个事件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase 7：Timeline    | COMPLETE（Final Gate PASS） | TimelineEvent 模型（规范 §57，TimelineEventType 无 LETTER_DROPPED，corrective migration）、(letterId,sourceKey) 幂等唯一、World Truth→User Fact 单向投影（绝不复制 payload、不反向修改世界真相）、visibility 冻结表（IMMEDIATE：DELAYED/COURIER_MISSING/RECOVERED/TRANSPORT_CHANGED；HIDDEN：ROBBERY/REROUTED/LOST_PATH/LETTER_DROPPED/SERIOUS_ACCIDENT）、canonical missing 双事件（LOST_PATH HIDDEN cause + 唯一 canonical COURIER_MISSING）、**随机游标与 WorldEvent 编号解耦**（`nextRandomDrawIndex` / `nextWorldEventIndex`，记录派生事实不消费随机数；新 Journey **仅在实际创建 WorldEvent 时分配编号**，等待期不占号；旧 Journey 的 `primaryEventIndex` 预留编号被尊重 → 升级后不碰撞）、Timeline district 可空（`String?`，仅区域锚点且 **province+city 双匹配**才写真实 district）、统一 PublicLetterStatus（LETTER_DROPPED→IN_TRANSIT，全 API 无泄漏）、normal transport facts 只取不可变来源（**一个用户可确认事实 → 一条 Timeline 事实**）、refresh-frequency independence、GET /letters/:trackingNo/timeline、safe DTO、Sender/Recipient 完全一致；**WorldEvent.eventIndex 不变量 = 唯一 + 单调 + 不碰撞**（新 Journey 等待期不占号，旧 Journey 允许继承历史 gap） |

| Phase 8：本地地图 | FINAL GATE PASS · COMPLETE（baseline `10963fb`） | `data/gen_map.cjs`（`pnpm map:generate`，读 **vendored 行政边界源** `data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson`（pinned revision + SHA-256 校验）+ `data/graphs/china-v1/station_nodes.json` 站点锚点，确定性生成 `data/maps/china-map.svg` + `data/maps/china-districts.json` + `apps/mobile/src/map/chinaMapData.ts`，幂等、无时间戳/随机值、完全离线）、固定 viewBox `0 0 1000 800` 与 `MAP_FIT` 等比映射（Y 为限制维度、禁 X/Y 独立拉伸）、`GET /api/v1/letters/:trackingNo/map` 安全投影（`apps/api/src/lib/map-view.ts`：只读用户可见 Timeline 事实 + 冻结规划 + SimulationClock；sender/recipient 同图、第三方 404、无 ETA/无 GPS/无掉落范围、`LETTER_DROPPED` 全局 HIDDEN 与正常世界 DTO 完全等价）、completedPath 永不重写 + remainingPath 虚线 + approximatePosition 确定性插值 + last-known（COURIER_MISSING）/ 终态只表达确认结果、Mobile `RouteMap` 七层（无 `DropAreaLayer`）、Letter Detail 仅新增「查看旅程地图」入口（无 polling / push / foreground refresh） |

| Phase 9：Worker / Push / Refresh | FINAL GATE PASS · COMPLETE | canonical domain 复用、durable BullMQ scheduling / reconciliation、safe Push、Mobile polling、Auth generation / epoch 防护、migration16 |
| Phase 10：Mobile V1 Integration + UX Closure | NOT STARTED | 准入通过；须项目负责人另行授权启动 |

## Phase 9 最终质量基线（2026-09-17 Independent Re-Gate PASS）

- Worker：真实 BullMQ delayed scheduling、启动/重连/周期 reconciliation、唯一 canonical progression、幂等与 graceful shutdown。PushDevice / PushDispatch 支持认证注册/注销、ownership/version、safe Timeline allowlist、durable dedupe、Expo provider 与 receipt 处理。
- Mobile：Detail / Map 约 5 秒、Home 约 30 秒轮询；foreground refetch、background pause、single-flight。原 M1（跨账号 refresh）/ M2（旧 epoch 认证失败停表）均由独立探针与正式测试确认 **closed**。
- 全量 **423 passed / 0 failed / 0 skipped，41 test files**：API 263 + Mobile 96 + Worker 2 + Shared 11 + Config 19 + DB 2 + Simulation 11 + Routing 19 = 423。
- Focused M1/M2 **33/33 PASS**；Phase 9 targeted **56/56 PASS × 3**（API 12 + Mobile 42 + Worker 2，Mobile 包含 focused 33 与 api/index 9）；Phase 5–7 regression **91/91 PASS**（world-events 33 + journey-advance 17 + timeline 36 + letter-visibility 5，随全量执行）。
- Re-Gate 实际串行 typecheck / lint / format:check / test / build / prisma:validate / prisma:generate / graph:validate --json / map:generate 全部 exit 0；Android export **1441 modules**。正式文件哈希不变，地图产物字节不变。
- Migration16：`20260915120000_phase9_push_delivery`。disk / dev / test = **16 / 16 / 16**；drift / unfinished / rolledback = **0 / 0 / 0**。历史 migration 1–15 未修改。
- Re-Gate 实测 migration/checksum/locks、test/dev URL 隔离及 dev URL 拒绝保护、API/Worker/Push regression、runtime restart/disconnect recovery、build。**fresh DB 1→16、schema diff 与 production health 200 是前次 Independent Gate 证据；本次 Re-Gate 未重复执行 fresh DB / production health smoke。** Unix 原生信号、真机 Expo delivery 与大规模压测未验收；provider 非 exactly-once。
- dev 实测 **User=2 / Letter=2 / Journey=1 / TransportLeg=6**，属于负责人确认的人工 dev 测试数据，关联记录保留，未删除或修改；旧 Letter=1 仅为历史快照。dev/test 无 idle transaction / lock waiter。
- Independent Re-Gate：**BLOCKER NONE / HIGH・MAJOR NONE / MEDIUM NONE / LOW correctness NONE**。非阻塞 documentation statistics cleanup 已在封板文档收口中完成，不是 correctness blocker。
- Phase 9 开发 baseline：`fabbec686b08ef393dc83c848149bca21df812a6`；本地封板提交使用 `feat: complete phase 9 worker push and refresh`，准确 SHA 以 Git 为准，不在提交内部自引用。本轮不 Push，Phase 10 NOT STARTED。
- 历史实现快照与 M1/M2 修复过程保留于 [PHASE9_IMPLEMENTATION_REPORT.md](PHASE9_IMPLEMENTATION_REPORT.md)，不作为当前统计。

## 已封板质量基线（Phase 8 历史，不代表 Phase 9 门禁）

- TypeScript strict：PASS
- ESLint：PASS
- Prettier：PASS
- Vitest：**385 passed / 0 failed / 0 skipped**（shared 11 / config 19 / db 2 / simulation 11 / routing 19 / worker 1 / **mobile 71** / **api 251**，共 37 个测试文件；其中 **Phase 8 定向 107/107 PASS × 3 轮**（`map-view` 14 + `maps.integration` 14 + `graph-data` 8 + `map-station-point` 30（含 20 例配置故障注入）+ mobile `geometry` 11 / `boundary` 15 / `RouteMap` 9 / `presentation` 6）、**Phase 5–7 重点回归 91/91 PASS**（world-events / journey-advance / timeline / letter-visibility）、**Phase 7 定向 41/41 PASS × 3 轮**（timeline 36/36 + letter-visibility 5/5）、**Phase 5/6 回归 50/50 PASS**（world-events 33/33 + journey-advance 17/17），关键 replay fixture 连续 3 轮稳定）
- Graph validation：`pnpm graph:validate` PASS（294 节点 / 1949 边 / 全连通 / 0 重复 city / 0 失效映射 / 0 孤立）
- Production build：PASS（含 Mobile Android Expo export）
- Prisma validate / generate：PASS
- 开发库与测试库 migration：**dev / test 两库已由 canonical 磁盘 history 从 0 重建**（`DROP/CREATE DATABASE` → `migrate deploy`），各 **15 个** migration、**逐条 checksum 与磁盘一致（0 drift）**、无 rolled-back / unfinished 残留，两库 `migrate diff` 均无差异；**全新空库（fresh DB Gate）从 migration 1 一次性跑通 15 个**（未 resolve / 未手工 ALTER / 未手工改 checksum / 未跳 migration）。Phase 6 四个 `20260826*`；Phase 7：`20260906120000_phase7_timeline`、corrective `20260908120000_phase7_remove_letter_dropped_visibility`（重建 enum 删 `LETTER_DROPPED`，PostgreSQL 不支持 `DROP VALUE`）、`20260908130000_phase7_timeline_district_nullable`、`20260913120000_phase7_decouple_random_cursor`（`nextEventIndex` → `nextRandomDrawIndex` + 新增 `nextWorldEventIndex`）、`20260913130000_phase7_reconcile_world_event_cursor`（把 `nextWorldEventIndex` 抬到 `GREATEST(当前, MAX(WorldEvent.eventIndex)+1, MAX(TransportLeg.primaryEventIndex)+1, 0)`，兼容旧版本已预留但尚未落库的 primary 编号）
- Runtime：Node 24.14.0 / pnpm 11.22.0 / PostgreSQL 17.11 / Redis 7.4.11 healthy（本轮 Gate 由 `docker compose up -d` 启动 `postgres:17` 与 `redis:7.4-alpine`，端口仅绑定 localhost；dev=`yishu` / test=`yishu_test` 严格分离）
- Production API：production 构建可启动，**本地 production-mode smoke** `GET /api/v1/health` 返回 HTTP 200（本地 smoke，不是线上 deployment acceptance）
- 测试隔离：破坏性集成测试只允许 `*_test` 数据库，开发库不被清理（Phase 7 Gate 探针：test 库 0 悬挂事务 / 0 未授权锁，dev 库 10 表 0 残留）
- Git 工程闭环：Phase 1–4 baseline `bcba2e5`、Phase 5 `e755cb2`、Phase 6 `141a66c`、Phase 6 Gate maintenance `1e3a8be`、**Phase 7 baseline `6488e8e`**（`feat: complete phase 7 timeline and visibility`）、**Phase 8 spec-alignment commit `9a4fe8a`**（`docs: align phase 8 map visibility rules`）、**Phase 8 实现 commit `10963fb`**（`feat: complete phase 8 local map and journey visualization`；含 Phase 8 代码 / 资产 / 测试 / 文档）。Phase 8 已于 2026-09-15 通过独立 Final Gate；后续文档同步另立 commit，不改写 baseline。远程同步以实际 `git push` / 远程 ref 查询结果为准，不将易变的 `origin/main` 指针写成固定基线。

## 安全基线

- Internal BIGINT id 不进入 JWT 或 API 响应；JWT `sub` 使用 8 位 UID。
- 密码使用 Argon2id；`passwordHash` 不返回客户端。
- Refresh Token 数据库仅存 SHA-256 Hash，Mobile 仅存 SecureStore。
- Letter 正文使用 AES-256-GCM；密钥来自环境变量，生产环境禁止默认值。
- Recipient 在 `DELIVERED` 前由服务端强制获得 `content: null`。
- Sender 响应完全不包含 Recipient `readState` / `openedAt`。
- Block 与 Letter 创建使用同一 transaction-scoped PostgreSQL advisory lock。
- `.env`、日志、生成产物与本地 Agent 数据均不提交。

## 有意保留的后续范围

以下能力尚未实现，不能把当前骨架或字段误认为正式业务：

- ~~TimelineEvent 与用户可见运输事实 / visibility~~ → **Phase 7 已完成**（TimelineEvent + IMMEDIATE/DELAYED/HIDDEN 映射 + `GET /letters/:trackingNo/timeline`）；WorldEvent 仍为服务器世界真相，绝不直接暴露给用户
- Mobile 上的完整 Timeline UI / Letter Detail 时间线展示（Phase 10；Phase 7 只提供 API / domain contract）
- Phase 10 完整 Mobile V1 Integration + UX Closure（NOT STARTED）
- ~~离线地图、轨迹、近似位置与最后确报~~ → **Phase 8 已完成并通过独立 Final Gate（2026-09-15）**：完全离线的本地地图资产 + `GET /letters/:trackingNo/map` 安全投影 + Mobile RouteMap；**`LETTER_DROPPED` = HIDDEN 为全局用户可见性规则**，V1 不做掉落范围 / `dropArea` / `DropAreaLayer`，地图不得暴露掉落原因。地图交互打磨与 Mobile 端完整展示属 Phase 10
- 开发调试面板（不在本轮冻结实施范围内）

## 已知限制与外部风险

- Mobile UI 是可运行的基础流程，不是最终产品级交互与视觉实现。
- Phase 9 Worker / Push / Refresh 已通过独立 Re-Gate；真机投递、规模压测与部署验收仍按后续阶段执行。
- `pnpm audit --prod` 当前报告 3 个 high、1 个 moderate 传递依赖公告：
  - `image-size <=2.0.2`：来自 Expo/Metro 工具链；公告要求 `>=2.0.3`，但审计时 npm registry 最新仍为 `2.0.2`，暂无可安装修复版。
  - `deepmerge-ts <8`：来自 Prisma 7.9.1 的 `@prisma/config`；Prisma 当前锁定 7.9.1，强制跨主版本 override 可能破坏工具链。
  - `uuid <11.1.1`：来自 Mobile 工具链的 moderate 公告。
- `pnpm peers check` 会报告 Expo / React Native 工具链内部的 3 组传递 peer 版本差异（React DOM、worklets、Metro config）；`expo install --check` 当前为 PASS，Android bundle 也通过，因此不强制覆盖 Expo SDK 57 的受支持版本矩阵。
- 上述依赖主要位于构建/CLI 链，不构成当前 Phase 1–6 基线的业务正确性阻塞；在 Expo/Prisma 上游发布兼容升级后应优先更新并重跑完整 Gate。不要向 Metro/Prisma CLI 输入不可信的递归对象或恶意图片资产。
- **Timeline district 为可空语义（by design）**：`StationNode` 冻结数据只到 province/city（规范 §16 未定义 district），因此途中驿站事件 `district = NULL`；只有区域锚点事件（DISPATCHED 用 Letter origin、OUT_FOR_DELIVERY/DELIVERED 用 Letter target）在**驿站 province+city 与冻结区域双匹配**时才写真实区县。**禁止用空串伪装、禁止按 city 猜测区县、禁止外部 geocoder**；API DTO 不暴露 district。
- **随机游标与事件编号已解耦（2026-09-13 Gate 修复）**：`Journey.nextRandomDrawIndex`（随机决策游标）与 `Journey.nextWorldEventIndex`（WorldEvent 编号分配器）分离；记录派生事实（canonical COURIER_MISSING / TRANSPORT_CHANGED / PERMANENTLY_LOST）不再消费随机数。**该修复改变了 LOST_PATH / 恢复 / 终态路径的随机序列**（此前多消费的错误行为已消除）。事件编号在**实际创建 WorldEvent 时**才分配：新 Journey 等待期不占号（`primaryEventIndex = null`）、编号连续；由旧版本升级的 Journey 允许继承历史 gap（`primaryEventIndex` 预留编号被保留并优先使用）。**正式不变量 = eventIndex 唯一 + 单调 + 不碰撞**（不强制历史 Journey 满足 `nextWorldEventIndex === 事件数`）。升级兼容由 `20260913130000` 校准与迁移 13→14→15 真实临时库 fixture 验证（无 P2002、frozen outcome 未重抽、随机游标保留）。
- **dev 库 migration checksum 漂移已消除（BLOCKER）**：dev 曾有一条 `20260908130000` 成功记录保存了修正前的 checksum（历史 `resolve --rolled-back` 后重部署未刷新该书签）。处置方式为**从 canonical 磁盘 history 重建 dev（及 test）数据库**（业务表当时全 0，无数据损失），未使用 `UPDATE _prisma_migrations`、未手工改 checksum、未修改任何 migration 文件；重建后逐条 checksum 与磁盘一致（0 drift）。
- **Mobile public DTO 类型契约**：`apps/mobile` 的 `LetterView.status` 使用 `PublicLetterStatus`（不含 `LETTER_DROPPED`），与 `@yishu/shared` 的 `toPublicLetterStatus` 对齐；客户端不存在 `LETTER_DROPPED` UI 分支。
- **Phase 8 地图可见性规范对齐 + 实现（2026-09-13）**：`LETTER_DROPPED` = HIDDEN 为**全局**用户可见性规则（不限于 Timeline）；禁止经 Letter API / Timeline / Journey projection / Mobile / Map 或任何其他用户 projection 暴露 `LETTER_DROPPED` / 信件掉落 / 掉落范围 / 掉落原因。规范与阶段规划中旧的「掉落范围 / 半透明圆形范围 / `DropAreaLayer` / Map API `dropArea` / 既定事实节点优先级中的信件掉落」已按项目负责人最新决定移除或改写；共享常量中残留的 §21 事实优先级注释已同步为「信件掉落不参与优先级表」。**实现已完成（独立 Final Gate PASS，2026-09-15）**：无 Prisma schema / migration 改动（磁盘仍 15 个 migration），初期几何方案随后由 vendored 静态行政边界源替代（见 2026-09-14 记录）；当前站点只作路线锚点，数据来源与许可见 `data/maps/README.md`。
- **行尾策略**：仓库已加入 `.gitattributes`（`* text=auto eol=lf`，`*.bat`/`*.cmd` 为 CRLF）并随 Phase 7 baseline commit 提交；**未执行 `git add --renormalize .`**（避免把全仓大规模 EOL 变更混入 Phase 7 baseline commit）。受控 renormalize 仍保持独立决策，需项目负责人单独指示。
- **Phase 8 Gate Repair（2026-09-14，已含于 `10963fb`）**：H1 剩余 / 已走路线改为**有序 Leg progression** 构造（禁止 `nodeId` 反查与「找不到就回退整条路线」；DELIVERED / PERMANENTLY_LOST / DESTROYED / 无剩余 leg → `remainingPath = []`）、M1 大概位置时间锚点改为**该段起点站最新可见 `DEPARTED_STATION`**（恢复 / 长期停留后重新出发不再沿用旧锚点）、M3 地图事实时间固定 `Asia/Shanghai`（`src/map/presentation.ts`，不随设备时区）、M4 新增**真实 API 响应安全扫描**（递归键 + 原始 JSON 全文）与 RouteMap / 图层 / FactList **渲染树测试**、L1 底图描边改为 `viewBoxStrokeWidth()` scale 补偿、L2 删除未使用 `toViewBoxPoints`。M5（边界语义）当时仍 **BLOCKED**，随后于 2026-09-14 修复（见下条）。
- **✅ Phase 8 地图边界语义（Gate M5）已修复（2026-09-14，项目负责人正式裁定数据源）**：`ProvinceBoundaryLayer` / `CHINA_MAP_OUTLINE_D` 改为 **vendored 静态行政边界源**（geoBoundaries `gbOpen / CHN / ADM1`，pinned revision、SHA-256 校验；provider / dataset / boundaryID / 年份 / 许可 **只在 `data/maps/README.md` 记录**）。station 点云**不再**参与边界生成（凸包 / 外扩 / 六边形逻辑已从生成器删除）。边界几何只做 canonical projection + 定点序列化（不自行简化），国家轮廓 = 34 个 ADM1 geometry 的 **union**（MultiPolygon / 岛屿全保留）。**34 个 ADM1 feature** 与 **31 个 route province** 明确区分（31/31 显式映射，无 fuzzy match；其余 3 个仅作底图，不伪造 station 计数），`MAP_DATA_BOUNDS` 语义改为「行政边界底图 ∪ 站点锚点」范围。站点空间归属实测：**283/294 严格落在本省 feature 内、0 个跨省**（旧方案 249/294 同时落入多个省形的问题消除）；11 个容差用例已在 Gate 报告逐条列明（其中 `yangquan` 系 Phase 4 冻结站点坐标本身为近似值所致，禁止改写冻结坐标）。该数据为开源静态行政边界数据，用于 V1 本地可视化，**非官方测绘成果、非法律边界认定文件**；面向中国大陆公开发布的合规检查属 Phase 12 Release Gate。
- **✅ Phase 8 Gate 复核修复：Yangquan 跨省显示（2026-09-15，已含于 `10963fb`）**：M5 容差用例 `yangquan` 在用户可见地图上落到**河南省**一侧（根因 = Phase 4 冻结站点坐标为近似值，**冻结版本禁止改写**）。修复分两层：① **数据层**新增图版本 `china-v2`（`data/gen_graph.cjs` 的 `VERSION_OVERRIDES` 承载**唯一获批**的 `yangquan` 坐标修正；生成算法不变、其余站点与 `china-v1` 逐项一致；`registry.json` 登记 `china-v2` 并将其设为 `defaultVersion`，`china-v1` 保持**字节冻结**）；② **显示层**新增人工批准、可追溯的 `data/maps/station-display-corrections.json`（每条含 `lat` / `lng` / `source` / `reason`），由 `apps/api/src/lib/map-station-point.ts` **在加载时**完整校验后缓存，**只影响用户可见地图的渲染坐标**，不改路由 / 距离 / `World Truth` / Timeline 事实。校验规则与失败语义（**任一不满足即抛 `station_display_corrections_invalid`，绝不静默回退到冻结坐标**）：顶层 / 版本 / 条目必须是普通对象；版本 key 必须在 `data/graphs/registry.json` 登记；`nodeId` 必须属于该版本；每条必须带非空字符串 `source` / `reason` 且**不得含未知字段**；`lat` / `lng` 必须为有限数且在合法经纬度范围内、投影后必须落在 `MAP_DATA_BOUNDS` 内；版本对象不得为空（顶层 `{}` = 明确「当前无需显示修正」）。文件缺失或解析失败 → `station_display_corrections_unreadable`。地图生成产物不随 display-only 修正漂移（`data/gen_map.cjs` 路线锚点仍固定 `china-v1`）。证据：新增 `apps/api/src/lib/graph-data.test.ts`（`china-v1` 三资产 SHA-256 冻结 + 重生成逐字节一致 + `china-v1`↔`china-v2` 差异清单仅 `yangquan`）、`apps/api/src/lib/map-station-point.test.ts`（30 项：修正生效 / 范围封闭 / 未知节点与版本 / 冻结数据只读 / **20 例内存故障注入：结构 / 版本 / 站点 / 来源字段 / 未知字段 / 经纬度范围 / 投影边界 / 空版本对象全部必须抛错**）、mobile `boundary.test.ts` 增补「显示坐标 0 跨省 + `yangquan` 不再落入他省」。该修复已提交（`10963fb`）。
- **⛔ Phase 8 前轮独立 Final Gate re-review 历史结论（2026-09-15）：FAIL**（`BLOCKER: NONE` / `HIGH: NONE` / **2 项 MEDIUM**）：
  - **MEDIUM-1（已修复）**：显示修正表未实现完整 fail-fast 校验（原实现只校验 `lat`/`lng` 有限性，`[]` / `null` / 站点拼写错误 / 未知版本 / 缺 `source`/`reason` 均被静默接受 → 可静默恢复跨省显示）。修复：加载时按上述规则完整校验（结构 / 版本 / 站点 / 来源字段 / 未知字段 / 经纬度范围 / 投影边界 / 空版本对象）+ 20 例内存故障注入测试（只注入内存，不写文件）。
  - **MEDIUM-2（已修复）**：阶段规划与状态文档的「当前状态」与实测矛盾（阶段规划仍写「M5 BLOCKED / Final Gate 尚未开始」；状态文档声称非法配置均抛错但当时未实现）。修复：区分**历史记录**与**当前状态**，按真实验证结果更新（含本节与根目录 `驿书_V1_Coding_Agent_阶段规划.md` §10）。
  - 该轮复核未修改任何源码 / 正式资产（184 个文件前后哈希一致），七项质量门禁 PASS（`typecheck` / `lint` / `format:check` / `test` 363 / `build` / `prisma:validate` / `prisma:generate`）。
  - **再次独立复审（2026-09-15）：PASS，两项 MEDIUM 均关闭**。真实文件读取路径故障注入确认非法结构 / 未知版本 / 拼错站点 / 缺来源 / 越界均拒绝，缺文件 / 损坏 JSON 明确报错；文档历史与当前状态已区分。全仓 **385 passed / 0 failed**（37 文件）；Phase 8 **107/107 共三轮通过**（全量中一轮＋额外两轮），Phase 5–7 回归 **91/91**；七项质量门禁全 PASS。dev/test 各 15 migrations、checksum 无漂移，无悬挂事务或异常锁等待；dev 十表为空，PostgreSQL / Redis healthy，production health HTTP 200。184 个仓库文件前后哈希一致，评审未改动正式文件。

## 封板与进入下一阶段规则

Phase 7 已通过独立 Final Gate Review，并已建立 Phase 7 baseline commit：

```text
FINAL GATE: PASS
PHASE 7 COMPLETE: YES
MAY START PHASE 8: YES
REMAINING BLOCKERS: NONE
```

Phase 8（Local Map + Journey Visualization）已通过最终独立复审（2026-09-15），实现 baseline commit 为 `10963fb`：

```text
FINAL GATE: PASS
PHASE 8 COMPLETE: YES
MAY START PHASE 9: YES
BLOCKER: NONE / HIGH: NONE / MEDIUM: NONE / LOW: NONE
REMAINING BLOCKERS: NONE
```

Phase 8 baseline `10963fb` 保留。Phase 9 Independent Re-Gate 已通过，封板结论如下；阶段编号与归属唯一以根目录阶段规划为准。

```text
FINAL GATE: PASS
PHASE 9 COMPLETE: YES
MAY START PHASE 10: YES
PHASE 10 NOT STARTED
REMAINING BLOCKERS: NONE
```

项目负责人本轮只授权本地 Phase 9 baseline commit；Push 与 Phase 10 启动须另行授权。
