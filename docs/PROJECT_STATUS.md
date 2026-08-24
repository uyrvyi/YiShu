# 驿书 V1 项目状态

> 更新时间：2026-08-24  
> 当前基线：Phase 4 实现完成 · Final Gate 三次评审修复完毕（第一次 FAIL → 已修复；第二、三次 PASS WITH FIXES → 全部 MEDIUM/LOW 已修复，等待最终封板复核）  
> 下一阶段：Phase 5（Simulation Core + Transport Progression），尚未开始

## Phase 完成情况

| Phase                | 状态        | 已完成范围                                                                                                                                           |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1：项目骨架    | COMPLETE    | pnpm workspace、Mobile/API/Worker、共享包、Prisma、PostgreSQL、Redis、Docker、严格 TypeScript、ESLint、Prettier、Vitest、构建与健康检查              |
| Phase 2：账号与身份  | COMPLETE    | User/Block/RefreshToken、注册登录、8 位 UID、Argon2id、JWT、Refresh Token Hash、TEST_DATABASE_URL 隔离、用户搜索、SecureStore 与 Mobile Auth Session |
| Phase 3：Letter 核心 | COMPLETE    | Letter/RecipientState/SenderState、Tracking Number、AES-256-GCM、创建幂等、Block 并发拦截、列表/详情/open/hide、Mobile 基础信件流程                  |
| Phase 4：Routing     | IMPLEMENTED | 版本化静态路网（data/graphs/china-v1）、Graph 加载与校验、Dijkstra、PIGEON 直连、Journey/TransportLeg、Journey 初始化服务、安全 API、Mobile 路线文本 |

## 当前质量基线

- TypeScript strict：PASS
- ESLint：PASS
- Prettier：PASS
- Vitest：166 passed / 0 failed（shared 4 / config 19 / db 2 / worker 1 / simulation 1 / routing 19 / mobile 26 / api 94）
- Graph validation：`pnpm graph:validate` PASS（含 selftest：isolated 按有效度数统计、`enabled=false` 合法禁用边不计入连通性；294 节点 / 1949 边 / 全连通 / 0 重复 city / 0 失效映射 / 0 孤立）
- Production build：PASS（含 Mobile Android Expo export）
- Prisma validate / generate：PASS
- 开发库与测试库 migration：5 个 migration 均 up to date，checksum 与文件一致
- Docker：PostgreSQL 17 / Redis 7.4 healthy
- Production API：可启动，`GET /api/v1/health` 返回 HTTP 200
- 测试隔离：破坏性集成测试只允许 `*_test` 数据库，开发库不被清理
- Git 工程闭环：Phase 1–4 源码与 migration 仍未提交；Phase 4 Final Gate 复审通过后由项目负责人确认再建立可回滚 Commit

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

- Journey / TransportLeg 的**运行期状态推进**（IN_PROGRESS / COMPLETED / TRANSPORT_CHANGED 等）与 SimulationClock / DeterministicRandom / 随机事件
- BullMQ Simulation Worker
- WorldEvent / TimelineEvent
- 离线地图、轨迹、掉落范围与最后确报
- Polling、Push 与开发调试面板

## 已知限制与外部风险

- Mobile UI 是可运行的基础流程，不是最终产品级交互与视觉实现。
- Worker 当前只验证独立进程与安全配置加载（Phase 1 骨架）；数据库、Redis/BullMQ 消费逻辑属于 Phase 9（Worker Scheduling + Push + Refresh，见阶段规划 §11）。
- `pnpm audit --prod` 当前报告 3 个 high、1 个 moderate 传递依赖公告：
  - `image-size <=2.0.2`：来自 Expo/Metro 工具链；公告要求 `>=2.0.3`，但审计时 npm registry 最新仍为 `2.0.2`，暂无可安装修复版。
  - `deepmerge-ts <8`：来自 Prisma 7.9.1 的 `@prisma/config`；Prisma 当前锁定 7.9.1，强制跨主版本 override 可能破坏工具链。
  - `uuid <11.1.1`：来自 Mobile 工具链的 moderate 公告。
- `pnpm peers check` 会报告 Expo / React Native 工具链内部的 3 组传递 peer 版本差异（React DOM、worklets、Metro config）；`expo install --check` 当前为 PASS，Android bundle 也通过，因此不强制覆盖 Expo SDK 57 的受支持版本矩阵。
- 上述依赖主要位于构建/CLI 链，不构成 Phase 1–3 业务正确性阻塞；在 Expo/Prisma 上游发布兼容升级后应优先更新并重跑完整 Gate。不要向 Metro/Prisma CLI 输入不可信的递归对象或恶意图片资产。

## 进入下一阶段规则

Phase 5 只能在项目负责人明确下达开始指令后执行。开始前应先确认并提交当前 Phase 1–4 基线；进入后仍遵循：单 Phase 开发、完整自测、完成报告、停止并等待评审。
