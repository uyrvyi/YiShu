# 驿书 V1 Coding Agent 阶段规划

> 本文件用于定义「驿书」V1 从项目骨架到可部署版本的阶段边界、每阶段目标、允许范围、禁止范围、主要交付物与 Gate 条件。  
> 本文件与以下根目录规范配套使用：
>
> - `驿书_V1_Coding_Agent_开发规范.md`
> - `驿书_V1_Coding_Agent_协作开发流程.md`
>
> 三份根目录规范职责固定：`开发规范` 定义产品与技术规则；`协作开发流程` 定义 Agent 执行与 Gate 流程；本 `阶段规划` 是 Phase 编号、阶段边界与功能归属的唯一来源。`README.md` 只描述仓库当前真实状态。若出现冲突，优先遵循项目负责人最新明确决定；没有新决定时，按各文档职责域分别取其为准。

---

# 1. 总体阶段原则

驿书 V1 必须采用严格分阶段开发。

```text
读取规范
→ 只执行当前 Phase
→ Coding Agent 实现
→ 实际执行测试/构建/迁移
→ 输出完成报告
→ Sol / Codex 只读技术 Gate Review
→ 修复 Gate 问题
→ Final Gate
→ PASS
→ 更新 README
→ Git Commit
→ 才允许进入下一 Phase
```

任何其他文档、旧 Prompt 或历史报告中出现的 Phase 列表，如果与本文件不同，均视为历史信息；不得据此改变当前阶段边界。

任何 Phase 未得到：

```text
FINAL GATE: PASS
PHASE X COMPLETE: YES
MAY START PHASE X+1: YES
```

都不得进入下一阶段。

禁止 Coding Agent：

- 自动跨 Phase 开发
- 未通过 Gate 就实现下一阶段功能
- 为了“以后可能用到”提前实现大量后续业务
- 自动 Commit（除非项目负责人明确要求）
- 用 `any`、`@ts-ignore`、跳过测试等方式掩盖失败
- 只写代码不真正执行验证命令

---

# 2. 当前总状态

| Phase    | 名称                                           | 状态            |
| -------- | ---------------------------------------------- | --------------- |
| Phase 1  | 项目骨架与基础设施                             | FINAL GATE PASS |
| Phase 2  | 账号与身份系统                                 | FINAL GATE PASS |
| Phase 3  | Letter 核心与基础信件流程                      | FINAL GATE PASS |
| Phase 4  | Journey + Routing + TransportLeg               | 当前阶段        |
| Phase 5  | Simulation Core + Transport Progression        | 未开始          |
| Phase 6  | Random Events + Recovery + World Truth         | 未开始          |
| Phase 7  | Timeline + 用户可见运输事实                    | 未开始          |
| Phase 8  | Local Map + Journey Visualization              | 未开始          |
| Phase 9  | Worker Scheduling + Push + Refresh             | 未开始          |
| Phase 10 | Mobile V1 Integration + UX Closure             | 未开始          |
| Phase 11 | Security / Reliability / Performance Hardening | 未开始          |
| Phase 12 | Deployment + Release Gate                      | 未开始          |

后续 Phase 可以按真实工程需要做小范围拆分，但不得改变冻结产品规则，也不得把多个大阶段一次性合并实施。

---

# 3. Phase 1 — 项目骨架与基础设施

## 目标

建立可持续开发的 monorepo、开发工具链、数据库、Redis、API、Worker 和 Mobile 基础运行环境。

## 主要范围

- pnpm workspace
- `apps/mobile` / `apps/api` / `apps/worker`
- `packages/shared` / `simulation` / `routing` / `config` / `db`
- Expo Router
- Fastify
- Prisma
- PostgreSQL
- Redis
- BullMQ 基础依赖/骨架
- TypeScript strict
- ESLint / Prettier / Vitest
- Docker Compose（开发阶段只运行 PostgreSQL + Redis）
- 环境变量集中校验
- API `/api/v1/health`
- Prisma Client 生产可用
- build / dist 边界
- `.env` / secret 基础安全

## 禁止

- User 正式业务
- Letter
- Journey
- Routing 正式业务
- Simulation
- Random Events
- Timeline
- Map
- Push

## Gate 核心

- workspace 全部 typecheck/lint/test/build
- Expo Router bundle 成功
- Prisma validate/generate 成功
- PostgreSQL/Redis healthy
- API production start
- Worker production start
- `.env` 不进入 Git
- 无 Phase 2+ 越界

## 当前状态

```text
FINAL GATE: PASS
PHASE 1 COMPLETE: YES
```

---

# 4. Phase 2 — 账号与身份系统

## 目标

建立用户身份、注册登录、安全 Token 生命周期、用户精准搜索与 Block 基础关系。

## 主要范围

### User

- internal BIGINT id
- 8 位随机数字 UID
- account
- nickname
- passwordHash
- province / city / district
- createdAt / updatedAt

### 身份规则

- UID：8 位数字，首位非 0，全局唯一，永久
- account：4–24，`a-z / 0-9 / _`
- account 小写规范化
- 为避免 UID 歧义，禁止“恰好 8 位纯数字”的 account
- nickname 可重复

### Auth

- Register / Login
- JWT Access Token
- opaque Refresh Token
- Refresh Token Hash 入库
- Refresh / Logout
- Argon2id
- Access Token `sub = uid`
- Internal ID 不进入 JWT

### API

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET /api/v1/users/me
GET /api/v1/users/search?q=
POST /api/v1/users/:uid/block
```

### Mobile

- `expo-secure-store`
- Refresh Token 安全存储
- 最小 AuthService
- Session 恢复基础能力

### 测试安全

- 独立 `TEST_DATABASE_URL`
- 破坏性测试必须只允许 `_test` 数据库

## 禁止

- Letter / Journey / Transport / Map / Simulation / Push
- 好友系统
- 手机/SMS登录
- 第三方登录

## Gate 核心

- Internal ID 不泄露
- Refresh Token 只存 Hash
- Mobile Refresh Token 只进 SecureStore
- 测试不能清空开发库
- malformed JSON 正确 400
- account / UID 精准查询
- UID collision 确定性测试
- Block API 正确

## 当前状态

```text
FINAL GATE: PASS
PHASE 2 COMPLETE: YES
```

---

# 5. Phase 3 — Letter 核心与基础信件流程

## 目标

建立“信”本身，使用户能安全创建、查询、打开、隐藏独立 Letter，但此时信尚不真正进行长时间运输模拟。

## 主要范围

### Letter

- internal BIGINT id
- trackingNo
- sender / recipient
- sender/recipient identity snapshots
- origin/target region snapshots
- status
- initialTransport / currentTransport
- encrypted content
- `clientRequestId`
- `requestFingerprint`
- `rulesVersion`
- `graphVersion`
- `simulationSeed`
- timestamps

### 正文

- 纯文本
- 最大 2000 Unicode code points
- AES-256-GCM
- ciphertext / iv / authTag 入库
- Recipient 未 DELIVERED：`content = null`
- Sender 始终可读自己的正文

### 幂等

- `senderId + clientRequestId` UNIQUE
- 并发同请求最终只能一封
- request fingerprint 相同 → 返回原 Letter
- 同 key 不同逻辑 body → 409

### RecipientState / SenderState

- RecipientState：UNOPENED / OPENED / openedAt / hiddenAt
- SenderState：hiddenAt

### API

- create Letter
- list sent/received
- detail
- open
- hide

### Block

正式接入发送拦截，并使用 PostgreSQL transaction advisory lock 解决 Block/Letter 并发竞态。

### Mobile

- 最小真实认证入口
- Session restore
- 我的信件
- 写信
- 精准搜索收件人
- 收件人确认
- TransportType 选择
- Letter Detail
- 稳定 clientRequestId

## 禁止

- Journey
- TransportLeg
- 正式 Routing
- Simulation
- Random Events
- Timeline
- Map
- Push
- ETA
- 用户撤回/加速/改路线

## Gate 核心

- account/UID 无误投歧义
- AES 边界正确
- Sender 无 readState/openedAt
- Recipient 未 Delivered 不下发正文
- 并发幂等
- requestFingerprint
- Block/Letter 并发
- Hide 双方独立
- Mobile 真 Session
- Secret 不泄漏
- migration checksum 稳定

## 当前状态

```text
FINAL GATE: PASS
PHASE 3 COMPLETE: YES
```

---

# 6. Phase 4 — Journey + Routing + TransportLeg

## 目标

让已经创建的 Letter 生成一条可解释、可冻结、可分段的运输路线。

```text
Letter
→ Journey
→ Local Route Plan
→ TransportLeg[]
```

这一阶段“规划运输”，但不进行完整时间推进和随机事件模拟。

## 主要范围

### Journey

至少表达：

- Letter 一对一关系
- origin station / destination station
- rulesVersion / graphVersion / simulationSeed
- totalDistance
- Journey 基础状态
- completedPath / remainingPath

必须继承 Letter 已冻结的 versions/seed，不得重新生成。

### TransportLeg

至少：

- journey
- sequence
- fromNode / toNode
- transportType
- distanceKm
- plannedDuration
- 基础状态

数据库保证：

```text
(journeyId, sequence) UNIQUE
```

### 本地 Graph

生产数据：

- `station_nodes.json`
- `route_edges.json`
- 可选 `region_station_map.json`

目标约 150–250 个 major station nodes，覆盖主要省份、直辖市、省会、主要地级市和关键连接节点。

### StationNode

- stable id
- name
- province / city
- lat / lng
- mapX / mapY

### RouteEdge

- from / to
- distanceKm
- enabled
- allowedTransport

### Routing

Ground：HAND_CARRY / HORSE_RELAY / EXPRESS_RELAY 使用本地 Dijkstra。

唯一权重：

```text
distanceKm
```

PIGEON：不走普通道路 graph，使用本地 Haversine / direct geographic distance 做 point-to-point。

### Transport Speed

```text
HAND_CARRY = 35 km/day
HORSE_RELAY = 120 km/day
EXPRESS_RELAY = 300 km/day
PIGEON = 480 km/day
```

planned duration 仅内部使用，不得作为 ETA 展示。

### Journey 初始化

- Region snapshot → station
- route planning
- create Journey
- create TransportLeg[]
- `completedPath = empty`
- `remainingPath = full route`
- transaction 原子化
- 重复/并发初始化幂等

## 禁止

- WorldEvent / TimelineEvent
- Random Events
- SimulationClock 正式推进
- BullMQ 运输任务
- 抢劫/失联/掉信/事故
- Map 正式 UI
- Push
- ETA/countdown
- 用户改路线/运输方式/加速

## Gate 核心

- Dijkstra 正确
- disabled edge / allowedTransport 生效
- route deterministic
- Pigeon 绕过 road graph
- Journey 只能一个
- Leg 不重复
- versions/seed 正确继承
- completedPath/remainingPath 边界正确
- graph 数据完整
- 无外部 routing API
- 不向用户暴露 ETA
- Phase 3 安全边界无回归

## 当前状态

```text
CURRENT PHASE
```

---

# 7. Phase 5 — Simulation Core + Transport Progression

## 目标

让 Journey 按“模拟时间”向前推进，使 Letter 真正从一个 Leg 移动到下一个 Leg。此阶段只建立确定性时间推进核心，不加入完整随机事件树。

## 主要范围

### SimulationClock

统一业务时间来源：

```text
simulationClock.now()
```

支持 production speed = 1、dev accelerated speed、测试可控时间。

### Deterministic Random 基础设施

建立：

```text
simulationSeed + eventIndex
```

要求 replayable，不使用 `Math.random()`。

### Journey / Leg Progression

实现正常运输状态推进，例如：

- DISPATCHED
- IN_TRANSIT
- AT_STATION
- TRANSFER
- OUT_FOR_DELIVERY
- DELIVERED

TransportLeg 至少具备 PLANNED → ACTIVE/IN_PROGRESS → COMPLETED 的等价状态。

### 距离/时间推进

依据 distanceKm、transport speed、simulation elapsed time 推进。

### completedPath / remainingPath

随着 Leg 完成：

- completedPath 只增加
- remainingPath 只减少
- completedPath 绝不能被未来路线重算覆盖

### Delivered

```text
target station
→ OUT_FOR_DELIVERY
→ DELIVERED
```

目标 station 不等于 Delivered。

## 禁止

- Random Event 正式概率树
- Robbery / Missing / Drop / Recovery
- WorldEvent 正式系统
- Timeline 正式系统
- Push
- Map 正式 UI

## Gate 核心

- SimulationClock 一致
- 不使用 Math.random()
- 进度可重复回放
- 正常运输状态机正确
- 多 Letter 独立推进
- later-sent 可先到
- completedPath 不可回写
- Delivered 语义正确
- 无 ETA 暴露

---

# 8. Phase 6 — Random Events + Recovery + World Truth

## 目标

加入古代通信的不确定性，建立真实世界事件、异常运输、掉信、失联、恢复和永久失败机制。

## 主要范围

### WorldEvent

服务端真实世界事实。

```text
WorldEvent != TimelineEvent
```

WorldEvent 不自动向用户公开。

### 固定概率事件

按开发规范中冻结概率实现 HAND_CARRY / HORSE_RELAY / EXPRESS_RELAY / PIGEON 的 NORMAL、DELAY、REROUTE、MISSING、DROP、ROBBERY、ACCIDENT 等事件。

### Recovery

固定恢复窗口：

- 24h
- 1–3d
- 3–7d
- 7d 未恢复 → PERMANENTLY_LOST

恢复后可由系统自动改变 TransportType。

### Reroute

事件导致 edge disabled 时，从当前 node 重新 Dijkstra，但只能修改 `remainingPath`，绝对不能改写 `completedPath`。

### Permanent Failure

支持：

- PERMANENTLY_LOST
- DESTROYED

总体保持绝大多数 Letter 最终送达。

## 禁止

- 用户控制异常结果
- 用户救援/重新发运
- 用户改路线/付费加速
- 动态 fatigue/health/security/loyalty 属性
- AI NPC

## Gate 核心

- deterministic replay
- event probabilities 正确
- eventIndex 稳定
- WorldEvent 与用户知识分离
- 掉信/恢复正确
- 7 日 permanent loss
- transport auto-change 正确
- reroute 不改 completedPath

---

# 9. Phase 7 — Timeline + 用户可见运输事实

## 目标

把服务器“知道的世界事实”转换为 Sender/Recipient 可以确认的运输事实。

## 主要范围

### TimelineEvent

只保存用户可见、可确认事实，例如：

- 已寄出
- 到达某站
- 转运
- 延迟
- 信使失联
- 信件被拾获
- 运输方式改变
- 派送中
- 已送达

### World Truth → Timeline

支持 visibility policy：immediate / delayed / hidden。

后端真实发生 `courier died + letter dropped` 时，用户可能暂时只知道“信使失联”。

### 双方一致

Sender 与 Recipient 必须看到完全相同的用户可见运输 Timeline。唯一例外仍然是 RecipientReadState。

### Timeline 永久保留

一旦用户已确认的运输事实，不因后来事件而删除。

## 禁止

- 把全部 WorldEvent 暴露
- 上帝视角
- 向 Sender 暴露 readState
- ETA
- 预测事件

## Gate 核心

- WorldEvent ≠ TimelineEvent
- visibility delay 正确
- Sender/Recipient Timeline 一致
- readState 隔离
- Timeline 不删除历史确认事实

---

# 10. Phase 8 — Local Map + Journey Visualization

## 目标

使用完全本地地图数据，在 Mobile 中可视化 Letter 当前旅程。

## 主要范围

### Local Map

- `china-map.svg`
- `china-districts.json`
- `react-native-svg`
- 固定 viewBox，例如 `0 0 1000 800`

### Layers

- ChinaOutlineLayer
- ProvinceBoundaryLayer
- CompletedRouteLayer
- RemainingRouteLayer
- ApproximatePositionLayer
- DropAreaLayer
- LastKnownPositionLayer
- FactNodeLayer

### 路线

- completed：实线
- remaining：虚线

### 当前位置

只能显示近似位置，不得返回精确 GPS。

### Drop

显示 10–40 km approximate circle，不得给客户端 exact drop coordinate。

### Missing

只显示 last confirmed position。

### Map Fact Nodes

最多展示最新 5 个高优先事实，优先级：transport changed > drop/recovery > courier missing > important station > ordinary station。

## 禁止

- 高德 / 百度 / 腾讯 / Google / Apple / Mapbox
- 在线 tile / 在线 geocoder
- exact GPS
- ETA

## Gate 核心

- 完全离线
- mapX/mapY 正确
- sender/recipient 同图
- approximate location
- dropped circle 安全
- missing last-known-position
- completed/remaining route 正确
- 无 ETA

---

# 11. Phase 9 — Worker Scheduling + Push + Refresh

## 目标

把已正确的 Simulation 从手动/测试推进升级到可持续运行的后台执行模型。

## 主要范围

### Worker

- Redis
- BullMQ
- delayed jobs
- job idempotency

多日计时禁止 `setTimeout(days)`，必须使用持久化 delayed jobs / DB 状态。

### Job Idempotency

重复任务不得重复推进、重复事件、重复 Delivered。

### API / Mobile Refresh

V1 不使用 WebSocket：

- Letter Detail：约 5 秒 polling
- Home：约 30 秒 polling
- App foreground：立即 refetch

### Push

重要事件可 Push，但不得泄露正文。通知显示 account，例如：`xiangshen 给你送了一封信`。

## 禁止

- WebSocket
- Kubernetes
- 高频实时 GPS
- Push 正文泄漏
- sender opened notification

## Gate 核心

- Worker restart 可恢复
- delayed job durable
- job idempotent
- 无重复 Timeline/Delivered
- polling 正确
- foreground refresh
- Push 无隐私泄漏
- Sender 不得收到“已拆阅”

---

# 12. Phase 10 — Mobile V1 Integration + UX Closure

## 目标

把此前各阶段的 Mobile 能力整合成完整可用 V1 产品流程。

## 主要范围

### Auth

- 登录 / 注册 / Session restore / Logout

### Home

- 我的信件
- Sent / Received
- 状态摘要

### Compose

- 收件人精准搜索
- account / UID
- 确认用户
- 正文
- TransportType
- 最终确认
- 发送

### Letter Detail

- Letter metadata
- content lock/unlock
- route
- Timeline
- local map
- status
- hide/open

### UX

突出“我知道，有一句话正在向我走来”，但保持现代物流/通信审美。

不得做古代羊皮纸 UI、游戏化 NPC 面板、好友聊天、社交 Feed、read receipt。

### Error States

- no route
- permanently lost
- destroyed
- missing
- offline
- auth expired
- server error

## Gate 核心

- 从注册到发信到收信完整 e2e
- Recipient pre-delivery 无正文
- Sender 永无已读状态
- 状态与地图一致
- Timeline 双方一致
- 无 ETA
- 无 friend/chat leakage
- crash-free basic flow

---

# 13. Phase 11 — Security / Reliability / Performance Hardening

## 目标

Release 前集中做安全、并发、数据一致性、可靠性和性能加固。

## 主要范围

### Security

- auth abuse / brute-force protection
- rate limiting
- token lifecycle
- sensitive logs
- encryption key handling
- malformed payload
- unauthorized access
- ID enumeration
- API response field audit

### Concurrency

重点攻击：

- block vs send
- idempotent create
- journey init
- worker duplicate
- event duplicate
- open/hide
- delivery transitions

### Data Integrity

- migration checksum
- foreign keys
- enum consistency
- graph/rules versions
- replay seed
- encrypted content integrity

### Performance

- Letter list
- Journey queries
- Timeline queries
- graph load
- routing
- worker throughput
- mobile polling

### Testing

- integration
- concurrency
- replay
- randomized fixtures
- long-running simulation
- failure injection

## 禁止

- 新增大功能
- 改产品基本规则

## Gate 核心

- 无 BLOCKER/HIGH security bug
- migration clean
- deterministic replay stable
- worker restart safe
- API field leakage audit PASS
- test suite stable
- performance 满足 V1 合理规模

---

# 14. Phase 12 — Deployment + Release Gate

## 目标

建立 V1 可部署、可升级、可回滚的生产环境，并完成最终 Release Gate。

## 主要范围

### Docker Compose

生产：

- Caddy
- API
- Worker
- PostgreSQL
- Redis

### TLS

- HTTPS
- Caddy certificate

### Config

Production 必须显式提供 DATABASE_URL、REDIS_URL、JWT secret、encryption key、Push 配置等必要 secrets，禁止 silent localhost fallback。

### Migration

- production migration procedure
- backup
- rollback plan
- restore test

### Observability

- structured logs
- health checks
- error monitoring
- worker status

### Release Checklist

- clean install
- migration
- server start
- app build
- auth
- send Letter
- route
- simulate
- random event
- timeline
- map
- delivered
- recipient open
- sender still cannot know opened

## 最终 Release Gate

```text
RELEASE GATE: PASS
V1 RELEASE READY: YES
```

才视为 V1 完成。

---

# 15. 各阶段功能归属速查表

| 功能                                       | Phase |
| ------------------------------------------ | ----: |
| Monorepo / Expo / Fastify / Prisma / Redis |     1 |
| User / UID / account                       |     2 |
| Auth / Refresh Token / Block               |     2 |
| SecureStore                                |     2 |
| Letter / AES 正文 / Tracking No            |     3 |
| RecipientState / SenderState               |     3 |
| clientRequestId / fingerprint              |     3 |
| Letter open/hide                           |     3 |
| Journey / TransportLeg                     |     4 |
| Station Graph / RouteEdge                  |     4 |
| Dijkstra / Pigeon direct route             |     4 |
| Region → station / planned duration        |     4 |
| SimulationClock                            |     5 |
| Normal transport progression               |     5 |
| Deterministic random infrastructure        |     5 |
| Random transport events                    |     6 |
| Drop / Missing / Recovery                  |     6 |
| Reroute after event                        |     6 |
| WorldEvent                                 |     6 |
| TimelineEvent                              |     7 |
| User knowledge / visibility                |     7 |
| Local China Map                            |     8 |
| Approximate position / Drop circle         |     8 |
| BullMQ transport scheduling                |     9 |
| Push / Polling                             |     9 |
| Full Mobile V1 flow                        |    10 |
| Security/performance hardening             |    11 |
| Production deployment                      |    12 |

---

# 16. V1 永久禁止的产品能力

以下不是“某 Phase 暂时不做”，而是 V1 产品层明确不做：

- Friend system / friend request / friend list
- Follow / follower
- Group
- Instant chat / conversation model
- Comments / reactions / feed / moments
- Online status
- Sender-visible read receipt
- Anonymous letters
- Recall / edit after send / cancel
- User acceleration / reroute / transport change / re-dispatch
- Attachments / images / audio / video / files / rich text
- Read-once / auto expiry
- External map API / external geocoder
- WebSocket V1
- Dynamic NPC stats
- Weather/security/fatigue routing weights
- ETA / countdown

Coding Agent 在任何阶段引入上述能力，应视为 Scope Violation。

---

# 17. 全阶段数据不变量

## Internal ID

不得暴露 User / Letter / Journey / TransportLeg internal id。

## Sender read privacy

Sender 永远不得知道 readState、openedAt、Recipient 是否打开。

## Recipient content lock

当 `Letter.status != DELIVERED` 时，Recipient API 必须返回：

```json
{ "content": null }
```

且必须由服务端控制。

## Frozen versions

每封 Letter 创建后冻结：

- rulesVersion
- graphVersion
- simulationSeed

后续 Journey / Simulation 必须继承，不得重新生成。

## completedPath

一旦成为历史完成路线：

```text
NEVER REWRITE
```

未来 reroute 只能修改 remainingPath。

## User-visible facts

Sender 与 Recipient 必须拥有相同 transport facts、route facts、Timeline facts。唯一私人状态是 RecipientReadState。

## Source of truth

PostgreSQL 是 source of truth。Worker / Redis 不能成为唯一事实来源。

---

# 18. 每个 Phase 完成报告统一格式

Coding Agent 每阶段结束必须输出：

```text
# Phase X 完成报告

1. 本阶段目标
2. 实现内容
3. 数据模型
4. API
5. Mobile
6. Shared Types
7. 新增/修改/删除文件
8. 新增依赖
9. Prisma migration
10. typecheck
11. lint
12. format
13. test 总数 / passed / failed
14. build
15. Prisma validate/generate
16. PostgreSQL/Redis
17. API smoke
18. Mobile bundle
19. 安全检查
20. 并发/幂等检查
21. 上一 Phase 回归情况
22. 下一 Phase 越界扫描
23. README 更新
24. 当前遗留问题
25. 自评：READY FOR PHASE X REVIEW / NOT READY
```

完成后停止，不得自行进入下一 Phase。

---

# 19. Gate Review 统一原则

Sol / Codex Gate Review：

- 默认 READ-ONLY
- 不直接修改代码
- 不相信 Coding Agent 自评
- 必须独立查看源码
- 必须实际运行关键命令
- 对并发、安全、权限做攻击式测试
- 检查 migration drift/checksum
- 检查 README 是否和真实状态一致
- 检查是否越界下一 Phase

最终必须给：

```text
FINAL GATE: PASS / PASS WITH FIXES / FAIL
PHASE X COMPLETE: YES / NO
MAY START PHASE X+1: YES / NO
REMAINING BLOCKERS: NONE / ...
```

---

# 20. Git / README 规则

只有 Final Gate PASS 后：

1. 更新 README
2. 标记当前 Phase Final Gate PASS
3. 写明 Next Phase
4. 再进行 Phase 级 Git Commit

推荐 Commit：

```text
Phase 1: chore: complete phase 1 project foundation
Phase 2: feat: complete phase 2 authentication and identity
Phase 3: feat: complete phase 3 letter core flow
Phase 4: feat: complete phase 4 journey and routing
后续：feat: complete phase X <scope>
```

README 永远描述“项目现在是什么”；阶段历史由 Git / CHANGELOG / Gate 报告记录。

---

# 21. V1 最终完成定义

V1 只有在以下全部成立后才视为完成：

- Phase 1–12 全部 Gate PASS
- 核心产品规则未被破坏
- Mobile 完整流程可用
- 服务端可部署
- Worker 可恢复
- Letter 可真实模拟运输
- Random Events 可确定性回放
- Timeline 知识边界正确
- Map 完全本地
- Sender 永远不知道已读
- Recipient 未送达永远无法读取正文
- 无 ETA
- 无外部地图依赖
- 无 Friend/Chat 社交系统
- Release Gate PASS

最终目标不是做一个普通聊天软件，而是实现：

> 一封独立的信，在现代中国地理中，以古代通信机制真实地向另一个人走去。
