# 驿书 V1 (MVP)

「现代世界 + 古代通信方式」的点对点通信 App。

> 当前基线：**Phase 7 Final Gate PASS · Phase 7 COMPLETE（Timeline + 用户可见运输事实）**
> Phase 8：**implementation complete · Final Gate pending review**（Local Map + Journey Visualization；尚未 Commit、尚未通过独立 Final Gate）
> 下一阶段：**Phase 9 — Worker Scheduling + Push + Refresh（NOT STARTED）**
> 已完成项目骨架、账号/身份、Letter 核心、Phase 4 本地 Graph + Dijkstra 路线规划、Phase 5 SimulationClock / DeterministicRandom 与确定性推进、Phase 6 WorldEvent 世界真相 + 固定概率随机事件 + Recovery + 自动运输变更 + PERMANENTLY_LOST/DESTROYED、Phase 7 TimelineEvent 用户可见运输事实（WorldEvent ≠ TimelineEvent；visibility 冻结映射：直接可见 / 后台原因 HIDDEN / 终态确认结果），以及 Phase 8：完全离线的本地地图资产 + `GET /letters/:trackingNo/map` 安全投影 + Mobile RouteMap（已走实线 / 未走虚线 / 大概位置 / 最后确报 / 事实节点，无 ETA、无精确 GPS、无掉落范围）。Push 与后台调度（Phase 9）/ 完整 Mobile UI（Phase 10）等后续业务仍未实现。

当前进度、验收结果与已知限制见 [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)。

## 技术栈（规划）

| 模块     | 技术                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| Mobile   | React Native / Expo SDK 57 / React Native 0.86 / Expo Router / TypeScript strict |
| Server   | Node.js 24 LTS / Fastify 5 / TypeScript                                          |
| Database | PostgreSQL 17 / Prisma 7                                                         |
| Worker   | Redis / BullMQ                                                                   |
| Test     | Vitest                                                                           |
| 质量     | TypeScript strict / ESLint / Prettier                                            |
| 包管理   | pnpm workspace                                                                   |

## 目录结构

```
yishu/
├─ apps/
│  ├─ mobile/          # Expo Router App（认证入口 + Letter 列表/写信/详情）
│  ├─ api/             # Fastify API（含 /api/v1/health、认证、用户、Letter）
│  └─ worker/          # Simulation Worker 骨架
├─ packages/
│  ├─ shared/          # 共享基础设施 + 业务常量/类型（TransportType/LetterStatus/RecipientReadState）
│  ├─ db/              # Prisma PostgreSQL Runtime（当前由 API 使用，Worker 后续复用）
│  ├─ simulation/      # SimulationClock + DeterministicRandom（Phase 5 实现）
│  ├─ routing/         # 本地静态 Graph + Dijkstra + PIGEON 直连（Phase 4 实现）
│  └─ config/          # Zod 环境配置加载 + 根 .env
├─ data/               # 本地静态数据（station_nodes/route_edges/region_station_map + Phase 8 地图资产 maps/）
├─ prisma/
│  ├─ schema.prisma    # 模型：User/Block/RefreshToken/Letter/RecipientState/SenderState/Journey/TransportLeg/WorldEvent/TimelineEvent（含 enum）
│  └─ migrations/
├─ prisma.config.ts    # Prisma 7 配置文件
├─ docker-compose.yml  # PostgreSQL 17 + Redis
├─ pnpm-workspace.yaml
└─ package.json
```

## 环境要求

- **Node.js**: `>=24.3.0 <25`（React Native 0.86.2 要求 Node >= 24.3.0；当前使用 24.14.0）
- **pnpm**: `>=11.0.0 <12`（当前使用 11.22.0，见 `packageManager`）
- **Docker**: 用于本地 PostgreSQL / Redis

### TypeScript 版本策略

- **Node 侧**（`packages/*`、`apps/api`、`apps/worker`）：TypeScript 5.x（`tsconfig.base.json` 严格配置）。
- **Mobile**（`apps/mobile`）：TypeScript ~6.0（Expo SDK 57 模板锁定），`tsconfig.json` 继承 `expo/tsconfig.base`。
- `strict` 全局开启；禁止 `any` / `@ts-ignore`。
- `skipLibCheck`：Node 端与 Expo 的依赖类型（如 RN）存在相互不兼容的 `d.ts`，是实际工程兼容需要，故开启（见 `tsconfig.base.json` 注释）。业务代码本身仍接受完整类型检查。

## 安装依赖（含 Prisma Client 自动生成）

```bash
pnpm install
```

`pnpm install` 的 `postinstall` 会自动执行 `prisma generate`，将 Prisma Client 生成到 `generated/prisma`（已 gitignore，不提交）。因此：

- 干净 clone 后只需 `pnpm install`，无需手动 `prisma generate`。
- typecheck / build / test / dev 不因 `generated/` 缺失而失败。
- generate 不依赖真实私密 `.env`（`prisma.config.ts` 提供默认 `DATABASE_URL` 回退）。
- `generated/` 永不提交 Git。

## 环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

支持变量：

```text
NODE_ENV=development
API_PORT=4000
API_HOST=0.0.0.0
DATABASE_URL=postgresql://yishu:yishu@localhost:5432/yishu?schema=public
TEST_DATABASE_URL=postgresql://yishu:yishu@localhost:5432/yishu_test?schema=public
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN_SECONDS=900
REFRESH_TOKEN_DAYS=30
CONTENT_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:4000
```

> **真机 API 地址**：`EXPO_PUBLIC_API_BASE_URL` 在真机上必须设为开发机的**局域网地址**（如 `http://192.168.x.x:4000`）。`localhost` 在真机上指向手机自身，不可用；未配置时 Mobile 层 **fail-fast 抛错**，不会默默 fallback 到 localhost。

- API / Worker 统一通过 `@yishu/config` 的 `loadConfig()` 读取，不散落读取 `process.env`。
- 根 `.env` 由 `@yishu/config` 自动加载。
- **连接串结构校验**（URL 解析）：`DATABASE_URL` 校验 protocol（`postgresql:`/`postgres:`）、hostname、database/path；`REDIS_URL` 校验 protocol（`redis:`/`rediss:`）、hostname。
- **`NODE_ENV=production` 时，`DATABASE_URL`/`REDIS_URL`/`JWT_SECRET` 必须显式提供**，禁止静默回退到 localhost 默认值，否则配置加载抛错。
- **测试数据库隔离**：破坏性集成测试只允许在 `TEST_DATABASE_URL` 指向的 `*_test` 库执行清库。`requireTestDatabaseUrl()` 强制保护——未提供 `TEST_DATABASE_URL` 或数据库名不含 `_test` 时直接拒绝，**禁止 fallback 到开发库**。
- **日志安全**：Worker/API 不输出完整连接串（`DATABASE_URL` / `REDIS_URL`），避免泄露用户名、密码、token。

## 启动基础设施（PostgreSQL + Redis）

```bash
docker compose up -d
```

验证状态（已在当前机器实际执行并通过）：

```text
docker compose config   PASS
docker compose up -d    PASS
PostgreSQL 17 healthy   PASS
Redis 7.4 healthy       PASS
PostgreSQL 连接         PASS（SELECT 1 → ok）
Redis 连接              PASS（redis-cli ping → PONG）
Prisma SELECT 1         PASS（@yishu/db 实际连接）
```

> `docker-compose.yml` 仅运行 PostgreSQL 17 与 Redis（**不容器化** Mobile/API/Worker），端口仅绑定 localhost。

## 开发启动（三端 + 内部包 watch）

```bash
pnpm dev
```

同时启动：

- `mobile`：Expo Router（Metro `http://localhost:8081`）
- `api`：Fastify（`http://localhost:4000`）
- `worker`：Simulation Worker 骨架
- `packages/*`：TypeScript `tsc -w` watch 编译，保证修改共享代码后不读取过期产物

> api/worker 的 dev 使用 Node 24 原生 `--watch`（`node --watch --import tsx`），保证与 `pnpm --parallel` 并行启动兼容。

## 常用脚本

```bash
pnpm dev               # 三端 + packages watch 并行启动
pnpm build             # 全 workspace 构建（TS build；mobile 为 expo export native bundle）
pnpm typecheck         # 先构建 packages，再全 workspace TS 检查
pnpm lint              # 全 workspace ESLint
pnpm test              # 全 workspace Vitest
pnpm format            # Prettier 格式化
pnpm format:check      # Prettier 检查
pnpm prisma:validate   # Prisma schema 校验
pnpm prisma:generate   # 生成 Prisma Client 到 generated/prisma
pnpm prisma:studio     # Prisma Studio
pnpm graph:validate    # 校验 data/graphs/<version>/ 并写出 GRAPH_VALIDATION_REPORT.json
pnpm map:generate      # 由本地站数据离线生成 data/maps/* 与 apps/mobile/src/map/chinaMapData.ts（幂等）
```

### Build 语义说明

- 根 `pnpm build` 的 TypeScript 构建（`packages/*`、`apps/api`、`apps/worker`）与 **Expo / native bundle**（`apps/mobile` 的 `expo export`）是两件事。
- `apps/mobile` 的 `build` 脚本执行 `expo export --platform android`（native bundle 验证），由根 `pnpm build` 通过 `--if-present` 一并触发。
- 单独验证 Mobile bundle：`cd apps/mobile && pnpm build` 或 `npx expo export --platform android`。
- **生产 build 排除测试文件**：`packages/*`、`apps/api`、`apps/worker` 使用 `tsconfig.build.json`（exclude `*.test.*`），生产 `dist` 不含测试产物。

## API 健康检查

```bash
curl http://localhost:4000/api/v1/health
```

返回：

```json
{
  "status": "ok",
  "service": "yishu-api",
  "uptimeSeconds": 1.23,
  "timestamp": "2026-08-21T10:00:00.000Z"
}
```

## Phase 2 API（账号与身份）

认证与用户 API（前缀 `/api/v1`）：

```text
POST   /api/v1/auth/register    # 注册（account/password/nickname/province/city/district）
POST   /api/v1/auth/login       # 登录（account/password → access + refresh token）
POST   /api/v1/auth/refresh     # 用 refresh token 换取新 access token
POST   /api/v1/auth/logout      # 注销（撤销 refresh token）
GET    /api/v1/users/me         # 当前用户（需 Bearer access token）
GET    /api/v1/users/search?q=  # 搜索（account 或 8 位 UID）
POST   /api/v1/users/:uid/block # 拉黑用户（需认证）
```

要点：

- **Account**：4~24 字符（a-z/0-9/_），保存前统一转小写，全局唯一。
- **Password**：8~72 字符，Argon2id 哈希存储，永不明文。
- **UID**：8 位随机数字，首位非 0，全局唯一（碰撞自动重试）。
- **Access Token**：JWT，15 分钟；`sub` 为**对外 UID**（绝不使用 internal id）。**Refresh Token**：随机 opaque token，30 天，数据库只存 SHA-256 哈希。
- **用户搜索**：`GET /users/search?q=` 为**精确认收件人**（完整 account 或完整 8 位 UID），返回**单个**安全用户对象；不存在返回 `404 user_not_found`。不做模糊/多结果搜索。
- **Mobile Token 存储**：Refresh Token 仅存 `expo-secure-store`（`apps/mobile/src/auth/tokenStorage.ts`），禁止 AsyncStorage、禁止日志打印；logout 必须删除。
- **Mobile Auth Service**（`apps/mobile/src/auth/authService.ts`）：最小认证流程——register/login 成功后 `saveRefreshToken()`、refresh 从 `getRefreshToken()` 读取并更新、logout 用 try/finally 确保 `deleteRefreshToken()`。通过注入 `ApiClient` 实现可测试性（mock API + SecureStore 测试）。
- **安全**：响应不暴露 `passwordHash` 与 internal BIGINT `id`；JWT 不含 internal id；日志/错误不泄漏 token 与连接串。

## Prisma

```bash
pnpm prisma:validate    # Prisma schema 校验
pnpm prisma:generate    # 生成 Prisma Client 到 generated/prisma（install 时自动执行）
```

Schema 当前包含业务模型：**User**、**Block**、**RefreshToken**、**Letter**、**RecipientState**、**SenderState**、**Journey**、**TransportLeg**、**WorldEvent**、**TimelineEvent**（含 `LetterStatus` / `TransportType` / `RecipientReadState` / `JourneyStatus` / `TransportLegStatus` / `JourneyAnomalyType` / `WorldEventType` / `TimelineEventType` enum）。地图与推送等领域模型属于后续 Phase，尚未实现。

## packages/db（已正式接受的数据库基础设施）

`packages/db` 由项目负责人正式接受，作为可供 API / Worker 复用的数据库基础设施 package；当前生产消费方是 API，Worker 在 Phase 9（Worker Scheduling + Push + Refresh）接入数据库与队列时再声明依赖。

**职责**：

- 封装 Prisma 7 PostgreSQL driver adapter（`@prisma/adapter-pg` + `pg`）。
- 提供可复用的 Prisma Client 工厂与连接健康检查。
- 生成真正的 JS `dist`，Node 生产进程可直接导入，**不依赖 tsx**。

**关键实现**：

- `schema.prisma` 的 generator 配置 `importFileExtension = "js"` + `moduleFormat = "esm"`，使生成的 TS client 用 `.js` 相对导入，可被 tsc 编译为 Node 可运行的 ESM。
- `packages/db` 的 `build`（tsc）把 `generated/prisma` 编译进自身 `dist`，`main`/`types` 指向 `dist/packages/db/src/index.js`。
- 导出 `createPrismaClient(databaseUrl)` 与 `pingDatabase(databaseUrl)`（`SELECT 1` 连接健康检查）。

**API 真实消费**：`apps/api/src/server.ts` 在生产代码路径 `import { createPrismaClient } from "@yishu/db"`，构造 PostgreSQL adapter + PrismaClient（惰性连接），并在 shutdown 时 `$disconnect`。Worker 当前仍是可启动骨架，数据库依赖将在 Phase 9 按实际消费路径接入。

**运行时测试**：`packages/db` 提供可重复的构造测试（无需 PostgreSQL 在线即可构造 adapter + PrismaClient 并 disconnect）；当 Docker 可用时，`pingDatabase` 可执行真实 `SELECT 1` 连接验证（已在当前机器验证 PASS）。

## 状态与已完成能力

### 已完成（Phase 2：账号与身份系统）

- **User 模型**：BIGINT 自增 id（仅数据库内部）、8 位对外 UID、account（唯一、强制小写）、nickname、province/city/district、createdAt/updatedAt
- **账号注册 / 登录**：account + password，Argon2id 密码哈希，重复 account 明确 409
- **UID**：8 位随机数字，首位非 0，全局唯一（碰撞自动重试，最大 10 次）
- **JWT Access Token**：15 分钟，`sub` 为对外 UID（不泄露 internal id）
- **Refresh Token**：随机 opaque token，30 天，数据库只存 SHA-256 hash；logout 撤销
- **用户 API**：`users/me`、`users/search`（account / 8 位 UID 精准搜索，404 处理）、`users/:uid/block`（Block 模型）
- **TEST_DATABASE_URL 测试隔离**：破坏性集成测试仅允许在 `*_test` 库（requireTestDatabaseUrl 强制）
- **Mobile SecureStore**：`expo-secure-store` 封装（tokenStorage.ts）
- **Mobile AuthService**：`authService.ts`，register/login 保存 Refresh Token、refresh 读取更新、logout try/finally 删除
- **PostgreSQL / Prisma**：User/Block/RefreshToken 模型 + migration + validate/generate
- **Phase 2 测试覆盖**：认证/用户集成、JWT sub、malformed JSON、UID 碰撞重试、Unicode 昵称边界、SecureStore/AuthService

### 已完成（Phase 3：Letter 核心）

- **Letter 模型**：BIGINT 内部 id、trackingNo（对外唯一）、senderId/recipientId、身份快照、区域快照、status（enum）、initialTransport/currentTransport（enum）、AES-256-GCM 加密正文（ciphertext/iv/authTag）、clientRequestId、requestFingerprint、rulesVersion/graphVersion/simulationSeed（密码学随机）、sentAt/deliveredAt
- **Prisma enum + Shared Types**：`LetterStatus`（15 值）、`TransportType`（4 值）、`RecipientReadState`（2 值）；`@yishu/shared` 提供同一份类型来源，API schema/响应/Mobile 共用
- **Tracking Number**：`YS-YYYYMMDD-XXXXX` 格式，全局唯一，碰撞自动重试（最大 10 次）
- **正文加密**：AES-256-GCM 应用层加密（密钥来自 `CONTENT_ENCRYPTION_KEY`），数据库不存明文；Sender 始终可见，Recipient 未 DELIVERED 前 content=null；完整性错误抛入统一 500（不静默置 null）
- **创建信件** `POST /letters`：recipient（account/8 位 UID 精准解析；禁止注册 8 位数字 account 避免歧义）、block 发送拦截（**advisory lock** `pg_advisory_xact_lock` 与 Block 共用同一把锁防并发竞态）、身份/区域快照、正文加密、幂等（senderId+clientRequestId + requestFingerprint）
- **幂等指纹**：requestFingerprint = SHA-256(recipient UID + content + transportType)；同 key 同 body → 原 Letter(200)；同 key 不同 body → 409 `idempotency_conflict`（顺序/并发均适用）
- **simulationSeed**：每封 Letter 用 `crypto.randomBytes(32)` 生成，非空、两封不同、API 不返回
- **信件查询** `GET /letters`（寄出/收到/全部，过滤当前用户已隐藏信）、`GET /letters/:trackingNo`（详情）
- **RecipientState / SenderState**：open/hide 独立；Sender 永远看不到 readState
- **Open** `POST /letters/:trackingNo/open`：仅 Recipient 且 DELIVERED（幂等，重复 open 不重写 openedAt）
- **Hide** `POST /letters/:trackingNo/hide`：仅终态，Sender/Recipient 独立软隐藏（列表过滤，detail 仍可直达）
- **TransportType**：HAND_CARRY / HORSE_RELAY / EXPRESS_RELAY / PIGEON（仅保存选择）
- **Mobile 基础信件流程**：列表页、写信页（稳定幂等键、发已确认 UID、code-point 计数正文、搜索/确认/运输方式/寄出）、详情页（DELIVERED 前锁定正文）
- **Mobile 真实 Auth Session**：`loginSession`/`registerSession`/`restoreSession`/`logoutSession` 调用真实后端；access token 仅内存、refresh token 存 SecureStore；API Base URL 统一 `EXPO_PUBLIC_API_BASE_URL`（真机需配置局域网地址，未配置 fail-fast）
- **Mobile 最小认证入口**：首页启动 restoreSession，未认证显示 Login/Register 最小表单，认证后进入信件
- **Phase 3 测试**：全 workspace 130 tests（含 Letter 集成、advisory lock 确定性并发、fingerprint 幂等、simulationSeed、hide/open/snapshot 边界、加密/追踪号/视图单元测试、Mobile Letter API + 共享 Session + restoreSession）

### 已完成（Phase 4：本地 Graph + Dijkstra 路线规划）

- **Prisma 模型（Phase 4 当时基线）**：`Journey`（Letter 1:1，`letterId` UNIQUE；继承 `rulesVersion`/`graphVersion`/`simulationSeed`，自身不生成）、`TransportLeg`（Journey 1:N，`(journeyId, sequence)` UNIQUE；`distanceKm>0`；当时为最小状态集，Phase 5/6 已在其上加入推进与事件字段）
- **Shared Types**：`@yishu/shared` 新增 `JourneyStatus`/`TransportLegStatus` enum 与 `TRANSPORT_SPEEDS_KM_PER_DAY`（HAND_CARRY 35 / HORSE_RELAY 120 / EXPRESS_RELAY 300 / PIGEON 480 km/day，冻结常量）；版本化速度：`TRANSPORT_SPEEDS_BY_RULES_VERSION` / `speedKmPerDay(rulesVersion, transportType)` / `plannedDurationSeconds(rulesVersion, transportType, distanceKm)`（`distanceKm/speed → 秒`，仅内部 Simulation 输入，用户 API 严禁暴露）；未知 `rulesVersion` 抛 `UnknownRulesVersionError`（路由 → 422），不静默 fallback
- **本地静态路网（按版本索引）**：`data/graphs/china-v1/station_nodes.json`（294 节点）、`route_edges.json`（1949 无向边，全连通）、`region_station_map.json`（市→站点 / 省→省会兜底，确定性、无 GPS/geocoder）；`data/graphs/registry.json` 登记已知版本，未知版本明确拒绝；`pnpm graph:validate` 可重复生成 `data/GRAPH_VALIDATION_REPORT.json`
- **Graph Loader + 校验**：节点 id 唯一、边端点存在、无自环、`distanceKm>0`、transport 合法、重复边检测、连通分量统计（`validateGraph` 返回 node/edge/component/isolated 计数）
- **Dijkstra**：二叉最小堆；唯一权重 `distanceKm`；遍历前过滤 `enabled && allowedTransport includes`；确定性 tie-break（node id 字典序）；`origin==destination` 返回空；无连通抛 `NoRouteError`（不 fallback 外部地图/不改 transport）
- **PIGEON 特殊路由**：绕过 road graph，Haversine 大圆直线距离，单 leg，无 Dijkstra/在线地图
- **Region→Station 映射**：本地确定性（市精确 → 省会兜底），失败显式抛错，不依赖外部 geocoder
- **Journey 初始化服务**：原子事务创建 Journey + TransportLeg[]；`completedPath=[]` / `remainingPath=full route`（动态计算，completedPath 不可重写）；并发幂等（UNIQUE `letterId` + 事务 + P2002 冲突重读现有 Journey）；成功初始化后 Letter 进入 `DISPATCHED`（规范 §25）
- **API**：`POST /letters/:trackingNo/journey`（仅 Sender，幂等 201/200，第三方 404，无站点映射 422）、`GET /letters/:trackingNo/journey`（Sender/Recipient 同视图，第三方 404）；安全视图不含 internal id / `simulationSeed` / `plannedDuration` / ETA
- **Mobile**：Letter 详情基础路线文本（起点→终点、总距离、legs 列表；无地图、无 ETA）
- **Phase 4 测试**：routing 单元测试（loader 校验 / graphVersion 传播 / Dijkstra 最短·禁用·运输限制·不连通·origin==dest·未知节点·距离累加·确定性 tie-break / PIGEON 直连）19 项；journey 集成测试（ground 继承字段+原子 legs、PIGEON 单直连、Sender 专属/Recipient 404、并发严格 [200,201]、幂等 200、Sender/Recipient 同视图、未知版本 422、非 CREATED 409、同站点 PIGEON、行锁竞态 409）11 项
- **门禁**：typecheck / lint / format:check / test / build / prisma:validate / prisma:generate 全 PASS；Phase 4 当时 dev 与 test 两库 migration 均 up to date（5 个）；Docker 双容器 healthy；dev 库 0 残留；构建产物 server 启动 `/api/v1/health` 返回 200

### 已完成（Phase 5：Simulation Core + Transport Progression）

- **SimulationClock**（`packages/simulation`）：`SimulationClock` 接口（`now()`）+ `SystemSimulationClock`（生产 speed=1、可加速，模拟时间 = epoch + 真实流逝 × speed）+ `TestSimulationClock`（`advanceBy`/`advanceTo` 纯内存控制，禁止真实 sleep）。运输业务统一 `simulationClock.now()`，禁止直接 `Date.now()`
- **DeterministicRandom**（`packages/simulation`）：`simulationSeed + drawIndex` → `deterministicDraw(seed, index)`（SHA-256 前 4 字节 / 2^32，[0,1)）；`DeterministicRandom` 类；相同 seed/index 结果一致、可回放，不使用 `Math.random()`；本阶段仅基础设施，随机事件判定属 Phase 6
- **Prisma**（migration `20260826120000_phase5_simulation_progression`）：`TransportLegStatus` enum 增加 `ACTIVE`（PLANNED → ACTIVE → COMPLETED 单向）；`Journey` 增加 `startedAtSim`/`completedAtSim`/`lastAdvancedAtSim`/`currentLegSequence`；`TransportLeg` 增加 `startedAtSim`/`completedAtSim`（模拟时间语义；`createdAt`/`updatedAt` 仍为真实审计时间）
- **advanceJourneyToNow**（`apps/api/src/lib/journey-advance.ts`）：核心推进服务——读取 Letter/Journey/Legs → 按冻结 `rulesVersion` 校验（未知抛 `UnknownRulesVersionError`，不 fallback latest）→ 事务内 `SELECT ... FOR UPDATE` 锁 Journey + 锁后重读 → 连续完成应完成的 Leg（**一次可跨多个 Leg，模拟时间结余传递**：Leg 完成时刻为理论 `startedAtSim + plannedDuration`，不是 now）→ 激活下一 Leg → 更新 completedPath（只增）/remainingPath（只减，由 `toPathViews` 按 Leg 状态派生）→ 到达目标站 `OUT_FOR_DELIVERY` → 经过冻结 `LAST_MILE_DURATION_SECONDS`（6h，shared 常量）→ `DELIVERED`（`deliveredAt` 只设置一次）→ 原子事务 commit
- **状态机**：Letter `DISPATCHED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED`；Journey `PLANNED → IN_PROGRESS → COMPLETED`；TransportLeg `PLANNED → ACTIVE → COMPLETED`；零 Leg 同站点 PIGEON 视为立即到达目标站
- **并发 / 幂等**：同一 Journey 并发 advance 由 Journey 行锁串行化，锁后重读保证至多一个 changed；`now <= lastAdvancedAtSim` → no-op（同一 now 重复推进、时间倒退均 no-op，不重放不倒退）；终态（DELIVERED/PERMANENTLY_LOST/DESTROYED）遇更晚 `now` 为业务 no-op，仅允许 `lastAdvancedAtSim` 单调更新，`deliveredAt` 等 terminal snapshot 字段不重写；无 500
- **API / Mobile**：本阶段不新增任何 `POST /advance` 生产控制接口（普通用户无推进能力）；现有 `GET /letters/:trackingNo/journey` 与 Letter 详情自动反映推进后的状态/路径；Recipient 未 DELIVERED 前 `content=null`（Phase 3 服务端强制）；Sender 永无 `readState`/`openedAt`；视图不暴露 `simulationSeed`/`plannedDuration`/ETA/`*AtSim`/internal id
- **Phase 5 测试**：simulation 单元测试（TestSimulationClock advanceBy/advanceTo、SystemSimulationClock speed=1/加速/非法速度、DeterministicRandom 同 seed/index 复现·replay·序列唯一·跨 seed 不同·范围）11 项；journey-advance 集成测试（单 Leg 激活、全 Leg 完成 OUT_FOR_DELIVERY、last-mile DELIVERED + deliveredAt 一次、多 Leg 大跳跃时间结余精确传递、completedPath 只增/remainingPath 只减、PIGEON 正常推进、同 now 幂等、并发 advance 恰一 changed、时间倒退 no-op、unknown Journey.rulesVersion 明确失败且无状态写入、Letter unknown/Journey valid 反向保护、缺失 Letter/Journey 错误、Recipient 正文解锁、Sender 无 readState、无 ETA/seed/id 泄漏、later-sent 可先到、零 Leg 同站点）17 项
- **门禁**：全 workspace 193 tests（shared 4 / config 19 / db 2 / simulation 11 / routing 19 / worker 1 / mobile 26 / api 111）0 failed；typecheck / lint / format:check / build / prisma:validate / prisma:generate 全 PASS；两库 6 个 migration applied + checksum 一致；Docker 双容器 healthy；API production smoke `/api/v1/health` = 200；Expo Android bundle PASS

### 已完成（Phase 6：Random Events + Recovery + World Truth）

- **WorldEvent 模型**（Prisma `WorldEvent` + `WorldEventType` enum）：`(journeyId, eventIndex)` UNIQUE，事件顺序可 replay；字段 `journeyId/eventIndex/eventType/occurredAtSim/nodeId（NOT NULL）/transportLegSequence/payload/createdAt`（nodeId 为事件稳定位置，Phase 7 Timeline / Phase 8 Map 直接可用，不依赖按时间反推）；仅服务器世界真相，API 绝不直接暴露（Phase 7 才做 TimelineEvent/visibility）
- **确定性随机消费**：每完成一个 Leg 做一次一级事件判定，`deterministicDraw(simulationSeed, drawIndex)`；`Journey.nextRandomDrawIndex` 持久化（事务内单调递增，retry/rollback 不重复消费随机数，replay 一致）；**随机游标与 WorldEvent 编号解耦**（另有 `Journey.nextWorldEventIndex`，记录派生事实绝不消费随机数）；全程无 `Math.random`
- **冻结概率（shared，禁止魔法数字）**：HAND_CARRY（§28 8 项）/ HORSE_RELAY（§29）/ EXPRESS_RELAY（§30）/ PIGEON（§31）一级事件表 + 总和/分段自动测试；ROBBERY 二级分支 55/25/15/5（§32）；掉落恢复窗口 50/25/15/10（§33）；拾获处理 70/20/10（§34）；恢复后自动运输变更倾向（HAND 60/25/15、HORSE 80/15/5、PIGEON 70/30）；`selectWeightedOutcome` 确定性抽样；未知 `rulesVersion` 明确失败
- **事件应用**（`advanceJourneyToNow` 内联，保留 Phase 5 全部契约）：DELAY/OTHER/DEVIATION/TEMPORARY_STOP → 理论完成时刻延后；REROUTE → 排除原计划下一条边重新 Dijkstra（`planRouteExcluding`，PIGEON 不走 road graph），只重建 remaining、completed 永久保留；LOST_PATH/LOST/COURIER_MISSING → `COURIER_MISSING` 异常；LETTER_DROPPED/ROBBERY(MISSING/DEAD 分支)/ground 严重事故 → `LETTER_DROPPED` 异常；PIGEON 严重事故 → `DESTROYED`（唯一 DESTROYED 分支）
- **Recovery**：异常运输暂停；恢复窗口（确定性抽取）到期自动恢复（`RECOVERED`），可自动变更运输方式（`TRANSPORT_CHANGED`，剩余 legs 切换字段与时长），7 模拟日未恢复 → `PERMANENTLY_LOST`（terminal，Recipient 正文仍锁定）
- **状态机**：Letter 异常状态 `COURIER_MISSING`/`LETTER_DROPPED` → 恢复回 `IN_TRANSIT`；终态仅 `DELIVERED`/`PERMANENTLY_LOST`/`DESTROYED`，之后 advance 为业务 no-op（更晚 `now` 仅允许 `lastAdvancedAtSim` 单调更新）；completedPath 不变量由 `toPathViews` 派生保持
- **并发/幂等**：事务内 `SELECT ... FOR UPDATE` 锁 Journey + 锁后重读，并发 advance 恰一套 WorldEvent；同 now 重复/时间倒退为真正 no-op；终态更晚推进除 `lastAdvancedAtSim` 外不改任何 terminal snapshot；unknown rulesVersion 抛错在任何写库前 → 事务整体回滚无半个事件历史
- **API / Mobile**：不新增任何 `POST /advance` 生产接口；用户视图不暴露 `WorldEvent/payload/eventIndex/recoveryWindow/anomaly*/simulationSeed/internal id`；Recipient 未 DELIVERED 前 `content=null`；Sender 永无 readState
- **Phase 6 测试**：shared 概率表（总和 1.0 / 分段 / 未知版本拒绝 / 分支 / 窗口）7 项；world-events 集成 33 项，统一 `canonicalWorldSnapshot` 对照 Letter / Journey / Legs / WorldEvents 的全部 deterministic 字段；一次大跳跃 vs 分段推进覆盖 NORMAL、DELAY、SET_ASIDE、目的站 drop/recovery、连续两次 reroute 以及 DELIVERED / PERMANENTLY_LOST / DESTROYED 三终态；同时覆盖每 Leg 一次 primary event、恢复运输方式重建、lastMileReadyAtSim 生命周期、WorldEvent.nodeId、totalDistanceKm、rollback、并发与 API 无泄漏（固定 seed，关键 replay fixture 连续 3 轮无 flaky）
- **门禁**：全 workspace 233 tests 0 failed；typecheck / lint / format:check / build / prisma:validate / prisma:generate 全 PASS；两库 10 个 migration applied、checksum 10/10 且 schema diff 为空；PostgreSQL 17.11 / Redis 7.4.11 healthy；API production smoke `/api/v1/health`=200；Expo Android bundle 1245 modules PASS

### 已完成（Phase 7：Timeline + 用户可见运输事实）

- **TimelineEvent 模型**（Prisma `TimelineEvent` + `TimelineEventType` enum，对应开发规范 §57）：字段 `letterId/sourceKey/sequence/type/title/description/province/city/district/nodeId/mapX/mapY/uncertaintyRadiusKm/happenedAt/visibleAt/importance/metadata/createdAt`；`(letterId, sourceKey)` UNIQUE 作为幂等兜底（规范 §66），`sequence` 由 projection 确定性计算，排序只依赖 `(happenedAt, sequence)`，不依赖 createdAt / 自增 id
- **World Truth → User Fact 单向投影**（`apps/api/src/lib/timeline.ts`）：`projectTimelineFacts()` 纯函数由 WorldEvent + Journey/Leg/Letter 生成候选事实；**绝不复制 `WorldEvent.payload`**；不反向修改 World Truth
- **visibility 冻结表**（`packages/shared` `WORLD_EVENT_VISIBILITY`，项目负责人 2026-09-08 冻结，禁止自行推导）：
  - `IMMEDIATE`（直接可见）：DELAYED → 运输延误；COURIER_MISSING → 信使失联；RECOVERED → 运输已恢复；TRANSPORT_CHANGED → 寄送方式已变更
  - `HIDDEN`（后台原因，不得直接生成 TimelineEvent）：ROBBERY / REROUTED / LOST_PATH / LETTER_DROPPED / SERIOUS_ACCIDENT
  - canonical missing（World Truth 双事件，确定性冻结顺序）：LOST_PATH transition 原子记录 `WorldEvent.LOST_PATH`（HIDDEN cause，eventIndex = primary）+ `WorldEvent.COURIER_MISSING`（canonical，独立单调 draw index）；Timeline 只消费 canonical（sourceKey = `we:{canonicalEventIndex}`），每次 logical missing transition 恰好一条"信使失联"，不暴露 LOST_PATH/cause
  - 终态：PERMANENTLY_LOST / DESTROYED 只表达用户确认结果（已确认永久遗失 / 信件已损毁，happenedAt = 实际损毁时刻），绝不泄漏 cause chain
- **统一 Public Letter Status**（shared `toPublicLetterStatus`）：所有 Letter API 出口（Sender/Recipient list/detail、创建返回）只输出用户可见状态；内部 `LETTER_DROPPED` → `IN_TRANSIT`（掉落完全 HIDDEN，无新可确认事实）；exhaustive switch，禁止 `return letter.status` fallback
- **normal transport facts（只取不可变来源）**：寄出（Letter.sentAt/createdAt 冻结）/ 从某站发出 / 到达某站（Leg.startedAtSim/completedAtSim）/ 派送中（lastMileReadyAtSim）/ 已送达（deliveredAt）/ 终态确认结果；**禁止**从会变化的当前状态（anomalyType / 瞬时 status / 变化中的 fallback timestamp）投影永久历史；`TimelineEventType` enum **不含 LETTER_DROPPED**（corrective migration 已从 PostgreSQL 删除该枚举值）
- **Timeline district（可空语义）**：`TimelineEvent.district` 为 `String?`；station 冻结数据只到 province/city，故**只有区域锚点事件**（寄出=DISPATCHED 用 Letter origin 快照、送达=OUT_FOR_DELIVERY/DELIVERED 用 target 快照）且在驿站城市与区域城市一致时才写真实 district；其余事件 district = `NULL`（**禁止空串伪装 / 禁止按 city 猜测区县**）；API DTO 不暴露 district
- **refresh-frequency independence**：同一 World Truth + 同一最终 simulation now，GET 1 次 / 多次最终 DB canonical snapshot 与 API DTO 完全一致（sequence 由完整 canonical set 分配并同步，不按本轮 missing 数组编号）
- **已确认事实永久保留**：reroute 不删除已完成 Leg 的到达事实；同一 sourceKey 的事实内容永不变化
- **幂等 / 并发**：lazy materialization + `skipDuplicates` + **P2002 精确判断（仅吞 (letterId, sourceKey) 复合唯一，其它 rethrow）**；100 次刷新不新增重复、不改顺序、不改 World Truth；并发 GET 无重复、无 500
- **Timeline API**：`GET /api/v1/letters/:trackingNo/timeline`（规范 §75）—— Sender / Recipient 返回**完全相同**的用户可见事实，第三方 404；只提供 GET（无 POST /reveal /confirm /advance）
- **safe DTO**：只含 `type/title/description/location{province,city}/happenedAt`；递归扫描确认不含 internal id / letterId / journeyId / worldEventId / eventIndex / payload / seed / visibleAt / nodeId / mapX / mapY / metadata / ETA
- **边界保持**：Recipient 非 DELIVERED（含 PERMANENTLY_LOST / DESTROYED）正文仍为 `null`；Sender 任意响应完全不存在 `readState` / `openedAt`
- **Phase 7 测试**：`timeline.integration.test.ts` 36 项（IMMEDIATE 四种 / HIDDEN（ROBBERY/REROUTED/LETTER_DROPPED/SERIOUS_ACCIDENT）/ 仅独立 DELAYED 生成延误 / LOST_PATH 双事件（LOST_PATH + canonical COURIER_MISSING）唯一性 / **random cursor golden（PIGEON LOST_PATH cursor 恰为 5 次真实决策）** / **derived 事件不消费随机游标（PERMANENTLY_LOST / TRANSPORT_CHANGED）** / **双事件 fault-injection rollback（all-or-nothing）** / **district province+city 双校验（同名城市/省级 fallback 不误套）** / DISPATCHED 不可变时间戳 / late vs many GET 完整 matrix（NORMAL/DELAY/direct missing/LOST_PATH/RECOVERED+TRANSPORT_CHANGED/PERMANENTLY_LOST/DESTROYED）/ drop 异常期间 GET vs 恢复后首 GET / canonicalTimelineSnapshot / 100 次刷新幂等 / 并发 / Sender-Recipient 一致 / 第三方 404 / 正文边界 / read privacy / 递归+文本级泄漏扫描 / Phase 6 World Truth 不变 / P2002 单来源精确判断 / **WorldEvent 编号连续无空洞（NORMAL 不占号）** / **legacy 预留编号兼容（升级后复用预留编号、canonical 从其后分配）** / **legacy reservation 在回滚后保留** / DESTROYED happenedAt=实际损毁时刻）+ `letter-visibility.integration.test.ts` 5 项（LETTER_DROPPED→public IN_TRANSIT、Sender/Recipient list+detail+Timeline 全 API 攻击、ROBBERY missing/dead 旁路、**Letter refresh-frequency 双端 5 场景对照（含 deliveredAt）**、enum 结构无 LETTER_DROPPED），固定 seed 连续 3 轮无 flaky
- **门禁（Final Gate PASS）**：Phase 7 定向 **41/41 PASS × 3 轮**、Phase 5/6 回归 **50/50 PASS**、全 workspace **274 passed / 0 failed**（api 185 = Phase 6 的 144 + Phase 7 的 41）；typecheck / lint / format:check / build / prisma:validate / prisma:generate 全 PASS；dev / test 两库由 canonical 磁盘 history **从 0 重建**（各 **15 个** migration、逐条 checksum **0 drift**、无 rolled-back 残留），schema diff 为空（corrective：`20260908120000` 删 `LETTER_DROPPED` 枚举值、`20260908130000` district 改 `String?`、`20260913120000` 解耦 `nextRandomDrawIndex` / `nextWorldEventIndex`、`20260913130000` 校准事件编号下界含旧预留）；全新空库一次性跑通 15 migrations（fresh DB Gate PASS）；PostgreSQL 17.11 / Redis 7.4.11 healthy；**本地 production-mode smoke** `GET /api/v1/health` = HTTP 200（本地 smoke，不是线上 deployment acceptance）

### 已完成（Phase 8：Local Map + Journey Visualization）

- **状态**：**implementation complete · Final Gate pending review**（未 Commit；Phase 9 NOT STARTED）。实现细节与门禁结果见本节与 [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)。
- **完全离线地图资产（vendored static boundary source + repository-local station anchors）**：`pnpm map:generate`（`data/gen_map.cjs`）读取**两类职责独立的数据源** —— ① vendored 行政边界源 `data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson`（geoBoundaries `gbOpen / CHN / ADM1`，冻结 revision、SHA-256 校验；provider / dataset / boundaryID / 年份 / 许可 **只在 [`data/maps/README.md`](data/maps/README.md) 记录**）与 ② 站点锚点 `data/graphs/china-v1/station_nodes.json` —— 确定性生成 `data/maps/china-map.svg`（国家轮廓 + 34 个 ADM1 边界）、`data/maps/china-districts.json`、`apps/mobile/src/map/chinaMapData.ts`；生成器**不写当前时间 / 随机值 / 环境相关值**，重复执行零新增 diff（幂等）。**station 点云不再是行政边界来源**（无凸包 / 外扩 / 六边形）；边界几何只做 canonical projection + 定点序列化；运行时与构建期**均不访问互联网**（无在线瓦片 / geocoder / 商业地图 SDK）。该数据为开源静态行政边界数据，用于 V1 本地可视化，**非官方测绘成果、非法律边界认定文件**；面向中国大陆公开发布的合规检查属 Phase 12 Release Gate。
- **固定 viewBox + uniform scaling**：`MAP_VIEWBOX = 0 0 1000 800`；`MAP_DATA_BOUNDS` = 行政边界底图 ∪ 站点锚点的 `mapX/mapY` 范围，`MAP_FIT` 由其等比推导（**Y 为限制维度**，`MAP_FIT_MARGIN = 60`；X 因等比居中留白更大），**禁止 X/Y 独立拉伸**；全部 34 个 ADM1 形状、国家轮廓（union，非凸包）与 294 个站点锚点映射后均落在 viewBox 内。
- **Map API**：`GET /api/v1/letters/:trackingNo/map`（规范 §74）—— Sender / Recipient 同图（完整 `toEqual`）、第三方 404、匿名 401；纯投影函数（`apps/api/src/lib/map-view.ts`）只读「已物化且用户可见」的 Timeline 事实 + 冻结规划 + SimulationClock，**不读 WorldEvent.payload / Journey.anomalyType / internal `Letter.status`**；GET 前后 World Truth（Letter / Journey / TransportLeg / WorldEvent 与两个游标）完全不变。
- **safe DTO**：`status`（`PublicLetterStatus`）/ `origin` / `destination` / `completedPath` / `remainingPath` / `approximatePosition` / `lastKnownPosition` / `facts`（≤ 5，来源 = 用户可见 Timeline 事实，按 §21 冻结优先级 + 时间 + 确定性 tie-break）；**不含** id / letterId / journeyId / worldEventId / eventIndex / sourceKey / sequence / seed / rulesVersion / graphVersion / payload / anomalyType / primaryEvent\* / next\*Cursor / lat / lng / ETA / remainingSeconds / `dropArea` / `LETTER_DROPPED`，也不含 Recipient `readState` / `openedAt`。
- **路线与位置语义**：completed = 用户可见事实确认过的节点（reroute 后**永不重写**）；remaining = 冻结规划几何（虚线）；`approximatePosition` = 由「已确认出发时刻 → now」在计划区间内线性插值（clamp 到 `MAP_APPROXIMATE_MAX_RATIO`；确定性、不用 `Math.random`、不消费随机游标、与 GET 次数无关）；**无 ETA / 无倒计时 / 无精确 GPS**。
- **异常与终态**：`COURIER_MISSING` → `approximatePosition = null` + 只保留 last-known（未走路线仍为虚线，不暴露 cause）；隐藏掉落（internal `LETTER_DROPPED`，含 LOST_PATH / ROBBERY / SERIOUS_ACCIDENT 等 HIDDEN cause）**全局 HIDDEN**：用户可见状态仍 `IN_TRANSIT`、DTO 与「相同可见事实」的正常世界**完全一致**，无掉落范围 / 掉落坐标 / 掉落原因；`PERMANENTLY_LOST` / `DELIVERED` / `DESTROYED` 只表达终态确认结果并保持最后确报（不推测遗失点、不显示事故点）。
- **Mobile**：`apps/mobile/src/map/RouteMap.tsx` + `layers.tsx` 七层（ChinaOutline / ProvinceBoundary / CompletedRoute 实线 / RemainingRoute 虚线 / ApproximatePosition / LastKnownPosition / FactNode），**无 `DropAreaLayer`**；Letter Detail 只新增「查看旅程地图」入口，未引入 polling / push / foreground refresh（Phase 9 范围）或 Letter Detail redesign（Phase 10 范围）。
- **Phase 8 测试**：`apps/api/src/routes/maps.integration.test.ts` + `apps/api/src/lib/map-view.test.ts`（Map API 契约 / 安全投影 / 隐藏等价 / 终态 / reroute / 重复节点 / 多次改道 / 恢复锚点 / **真实响应禁止字段扫描** / 纯度 / 刷新无关）；`apps/mobile/src/map/geometry.test.ts`（几何与 viewBox 契约、294 站点覆盖、31 route province 无遗漏）；`apps/mobile/src/map/boundary.test.ts`（源 SHA-256 / 34 个 ADM1 / 31-31 映射 / MultiPolygon 保留 / union 轮廓包含 / **站点空间归属（0 跨省）** / 生成器幂等）；`RouteMap.test.ts`（图层渲染树）；`presentation.test.ts`（Asia/Shanghai 时区）。固定 seed 连续 3 轮无 flaky。
- **Phase 8 工程门禁（2026-09-14 M5 边界修复后复验；未 Commit）**：`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（**341 passed / 0 failed / 0 skipped**，35 个测试文件）/ `pnpm build`（含 Mobile Expo export，Android Bundled **1375 modules**）/ `pnpm prisma:validate` / `pnpm prisma:generate` 全 PASS；**Phase 8 定向 63/63 PASS × 3 轮**、**Phase 5–7 重点回归 91/91 PASS**；`pnpm map:generate` **可复现性通过**（连续两次执行字节一致；source 与三产物 SHA-256 记录在 [`data/maps/README.md`](data/maps/README.md)）；站点空间归属实测 **283/294 落在本省 ADM1 内、0 个跨省**（11 个容差用例已列明）；运行时实测：PostgreSQL 17.11 / Redis PONG、dev 与 test 各 **15 migrations 0 drift / schema diff 空 / 0 悬挂事务 / 0 未授权锁**、本地 production-mode smoke `GET /api/v1/health` = HTTP 200（验证后进程已停止、端口已释放）；本轮**无 Prisma schema / migration 改动**（磁盘仍 15 个 migration）。

### 未完成（后续 Phase）

以下业务**尚未实现**：Phase 8 地图的独立 Final Gate 复审（实现已完成，等待负责人评审；含完整 Mobile Timeline UI 与地图交互打磨属 Phase 10）、Push 与 BullMQ Worker 正式接入 / 轮询刷新（Phase 9）、完整 Mobile V1 流程与 Letter Detail Timeline UI（Phase 10）。Phase 7 已完成 WorldEvent→TimelineEvent 的可见性转换与 API/domain contract（按阶段规划，完整 Mobile timeline 属 Phase 10）；生产环境由谁按模拟时钟调度推进（后台 worker）属 Phase 9。**`LETTER_DROPPED` = HIDDEN 是全局用户可见性规则**（V1 不做掉落范围 / `dropArea` / `DropAreaLayer`，地图与任何用户 projection 都不得暴露掉落原因）。

## 已知限制与维护事项

- `generated/`、`dist/`、`.expo/` 均为可再生成产物并已忽略；`.env` 与本地 Agent 数据不进入 Git。
- Mobile 已有最小登录/注册认证入口与 Letter 列表/写信/详情页面；正式产品级 UI 打磨属后续。
- `pnpm audit --prod` 当前报告来自 Expo/Metro 与 Prisma 工具链的传递依赖公告；上游尚无兼容的完整修复组合，详见项目状态文档，升级时需重新审计。
- Docker 容器（PostgreSQL/Redis）由 `docker compose up -d` 启动；停止可执行 `docker compose down`。
