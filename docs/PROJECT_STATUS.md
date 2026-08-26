# 驿书 V1 项目状态

> 更新时间：2026-08-26  
> 当前基线：Phase 6 实现完成 · Final Gate 待复审（Random Events + Recovery + World Truth）  
> 下一阶段：Phase 7（Timeline + 用户可见运输事实），尚未开始

## Phase 完成情况

| Phase                | 状态        | 已完成范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1：项目骨架    | COMPLETE    | pnpm workspace、Mobile/API/Worker、共享包、Prisma、PostgreSQL、Redis、Docker、严格 TypeScript、ESLint、Prettier、Vitest、构建与健康检查                                                                                                                                                                                                                                                                                                                                                                      |
| Phase 2：账号与身份  | COMPLETE    | User/Block/RefreshToken、注册登录、8 位 UID、Argon2id、JWT、Refresh Token Hash、TEST_DATABASE_URL 隔离、用户搜索、SecureStore 与 Mobile Auth Session                                                                                                                                                                                                                                                                                                                                                         |
| Phase 3：Letter 核心 | COMPLETE    | Letter/RecipientState/SenderState、Tracking Number、AES-256-GCM、创建幂等、Block 并发拦截、列表/详情/open/hide、Mobile 基础信件流程                                                                                                                                                                                                                                                                                                                                                                          |
| Phase 4：Routing     | COMPLETE    | 版本化静态路网（data/graphs/china-v1）、Graph 加载与校验、Dijkstra、PIGEON 直连、Journey/TransportLeg、Journey 初始化服务、安全 API、Mobile 路线文本                                                                                                                                                                                                                                                                                                                                                         |
| Phase 5：Simulation  | COMPLETE    | SimulationClock（System/Test）、DeterministicRandom 基础设施、advanceJourneyToNow 确定性推进（多 Leg 结余传递、OUT_FOR_DELIVERY→DELIVERED、并发/幂等/时间倒退契约）、Prisma 模拟时间字段、集成测试                                                                                                                                                                                                                                                                                                           |
| Phase 6：World Truth | IMPLEMENTED | WorldEvent 模型、(journeyId,eventIndex) 唯一、冻结概率表（§28–§36）、每 Leg 一次 primary event 持久化（primaryEventIndex/outcome/delaySeconds，DELAY 冻结延长）、可重复 progression loop（一次大跳跃与分段推进完全一致）、reroute 后继续消费剩余模拟时间、Recovery + 自动运输变更（按新 transport 重建路线，PIGEON↔ground 语义）、WorldEvent 稳定位置（nodeId/transportLegSequence）、7 日 PERMANENTLY_LOST、PIGEON 严重事故 DESTROYED、completedPath 不变量、totalDistanceKm 同步、并发/幂等/回滚无半个事件 |

## 当前质量基线

- TypeScript strict：PASS
- ESLint：PASS
- Prettier：PASS
- Vitest：228 passed / 0 failed（shared 11 / config 19 / db 2 / simulation 11 / routing 19 / worker 1 / mobile 26 / api 139）
- Graph validation：`pnpm graph:validate` PASS（294 节点 / 1949 边 / 全连通 / 0 重复 city / 0 失效映射 / 0 孤立）
- Production build：PASS（含 Mobile Android Expo export）
- Prisma validate / generate：PASS
- 开发库与测试库 migration：10 个 migration 均 applied，checksum 与文件一致（Phase 6 新增 `20260826130000_phase6_world_truth` / `20260826140000_phase6_gate_fixes` / `20260826150000_phase6_terminal_resume` / `20260826160000_phase6_lastmile_ready`：WorldEvent 表 + JourneyAnomalyType + Journey 事件/异常字段 + TransportLeg primary event 持久化 + WorldEvent 位置字段（nodeId NOT NULL）+ Journey.resumeAtSim + Journey.lastMileReadyAtSim）
- Docker：PostgreSQL 17 / Redis 7.4 healthy
- Production API：可启动，`GET /api/v1/health` 返回 HTTP 200
- 测试隔离：破坏性集成测试只允许 `*_test` 数据库，开发库不被清理（Phase 6 Gate 探针：test 库 0 悬挂事务 / 0 未授权锁，dev 库 9 表 0 残留）
- Git 工程闭环：Phase 1–5 已提交至 baseline commit `e755cb2`（feat: complete phase 5 simulation progression）；Phase 6 源码与 migration 尚未提交，待 Phase 6 Final Gate PASS 后由项目负责人确认再建立可回滚 Commit

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

- TimelineEvent 与用户可见运输事实 / visibility（Phase 7；WorldEvent 已建立为服务器世界真相，不直接暴露给用户）
- BullMQ Simulation Worker（Phase 9；Phase 5/6 已提供确定性推进 service `advanceJourneyToNow` 与 WorldEvent 事件内核，生产环境由 worker 按模拟时钟调度消费）
- 离线地图、轨迹、掉落范围与最后确报（Phase 8）
- Polling、Push 与开发调试面板（Phase 9）

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

Phase 7（Timeline + 用户可见运输事实）只有在满足以下全部条件后才允许开始：

```text
FINAL GATE: PASS
PHASE 6 COMPLETE: YES
MAY START PHASE 7: YES
```

并在项目负责人确认后完成 Phase 6 baseline Commit。进入后仍遵循：单 Phase 开发、完整自测、完成报告、停止并等待评审。阶段编号与功能归属唯一以根目录 `驿书_V1_Coding_Agent_阶段规划.md` 为准。
