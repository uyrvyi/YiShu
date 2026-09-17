# Phase 9 Implementation Report

日期：2026-09-17。**Final Gate PASS / archived phase report**。保留实现架构、迁移、Gate findings 与修复证据，具有独立审计价值，非 PROJECT_STATUS 的重复副本。

## FINAL INDEPENDENT RE-GATE

- **FINAL GATE: PASS / PHASE 9 COMPLETE: YES / MAY START PHASE 10: YES / PHASE 10 NOT STARTED**。
- 原 M1 / M2 已由独立并发探针与正式回归确认 closed；BLOCKER / HIGH・MAJOR / MEDIUM / LOW correctness 均 NONE。
- Focused **33/33 PASS**；targeted **56/56 PASS × 3**（API 12 + Mobile 42 + Worker 2；Mobile = authenticatedFetch 6 + authService 10 + PushRegistration 6 + poller 11 + api/index 9）。
- Phase 5–7 regression **91/91 PASS**（33 + 17 + 36 + 5，随全量）；full **423 passed / 0 failed / 0 skipped，41 文件**。API 263 / Mobile 96 / Worker 2 / Shared 11 / Config 19 / DB 2 / Simulation 11 / Routing 19。
- Re-Gate 实际串行九项质量门禁全部 exit 0；Android export 1441 modules；disk/dev/test migration 16/16/16，drift/unfinished/rolledback 0/0/0。migration16 为 `20260915120000_phase9_push_delivery`，历史 1–15 无变化。
- 本次 Re-Gate 核验 migration/checksum/locks、test/dev 隔离保护、API/Worker/Push regression、runtime restart/disconnect recovery、build。**fresh DB 与 production health 200 引用前次 Independent Gate，未在 Re-Gate 重跑**；前次独立 smoke 使用 Gate 临时库及隔离队列，完成后清理。Unix native signal 未实测，runtime.close 已实测。
- dev 的 **User=2 / Letter=2 / Journey=1 / TransportLeg=6** 及关联记录为负责人确认的人工数据，保留未动，不视为污染。
- 非阻塞文档问题已收口：当前统计统一为 423 / Mobile 96 / targeted 56×3，Phase 4 报告完整到 §56。
- 本轮仅授权 Markdown 收口和本地 baseline commit，不 Push，不启动 Phase 10。提交信息为 `feat: complete phase 9 worker push and refresh`；提交 SHA 以 Git 为准。

## HISTORICAL IMPLEMENTATION RECORDS

以下 BASELINE、实施审计、Remediation、Finalization、运行与 Git 记录均为当时快照；其中未提交、等待 Re-Gate、旧测试数量不作为当前状态。当前结论以本报告顶部及 PROJECT_STATUS 为准。

## BASELINE

- 开始时 HEAD / 本地 origin/main：`fabbec686b08ef393dc83c848149bca21df812a6`，branch `main`，工作区 clean。
- Phase 8 实现 baseline：`10963fbea646cf36546c6d6ab93a4d5ac25eaf7f`。
- 当前工作区包含本阶段代码、测试、schema、migration、依赖与文档修改，尚未提交。

## MARKDOWN PRE-READ / AUDIT

先完整读取 README、开发规范、协作开发流程、阶段规划、PROJECT_STATUS、YISHU_V1_SPEC；同时审阅全部 tracked Markdown。最新负责人授权冻结为 Worker / safe Push / polling，不含 debug panel、WebSocket/SSE 或 Phase 10 UX。

| 文档                                 | 分类与处理                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| README.md                            | UPDATE：当前阶段、Worker、Push、Refresh、运行配置                                       |
| docs/PROJECT_STATUS.md               | UPDATE：Phase 9 进展；Phase 8 数字明确为历史封板基线                                    |
| 驿书_V1_Coding_Agent_阶段规划.md     | UPDATE：Phase 9 IN PROGRESS；Phase 8 PASS 保留                                          |
| docs/PHASE4_COMPLETION_REPORT.md     | HISTORICAL：只更新归档说明，不改历史实施记录                                            |
| docs/YISHU_V1_SPEC.md                | NO CHANGE：阶段归属指向根目录阶段规划                                                   |
| 驿书_V1_Coding_Agent_开发规范.md     | NO CHANGE：冻结业务语义；旧 job-id/日志示例由最新任务的最小身份与禁止 seed 日志要求约束 |
| 驿书_V1_Coding_Agent_协作开发流程.md | NO CHANGE：独立 Gate 与阶段授权流程不变                                                 |
| data/README.md                       | NO CHANGE：图版本冻结纪律不变                                                           |
| data/maps/README.md                  | NO CHANGE：地图来源、资产、显示修正规则不变                                             |
| docs/PHASE9_IMPLEMENTATION_REPORT.md | UPDATE：新增本阶段证据与限制                                                            |

## ARCHITECTURE / WORKER

- `packages/domain` 机械提取 `journey-advance` / `timeline` / `stationGraph`；与 HEAD 原文件逐字比对（忽略 CRLF）均一致。API re-export，Worker 调同一函数，无第二套推进算法。
- BullMQ 三队列：`journey-progression`、`push-delivery`、`reconcile`。Redis 只保存 journeyId / dispatchId，不存正文、seed、WorldEvent payload。
- 运输 job identity：Journey id + lastAdvancedAtSim；延迟约 5 秒。终态 stale job 不再推进或调度。唯一业务约束与行锁由 canonical progression 提供。
- 启动、重连与每 30 秒 durable reconciliation 扫描 DB，修复 commit/enqueue 间隙。分页限制内存；当前会扫描历史 Letter，尚未做大规模压测或增量索引优化。
- Redis 暂不可用时启动明确失败；运行时连接重试、重连重建 scheduler。Docker Compose 启用 AOF everysec，保留原 Redis 数据卷。
- 普通失败 5 次指数退避；已知 domain error 为 unrecoverable；BullMQ 错误消息净化，不保留驱动 URL/token。失败 job 保留，修复根因后的运维重试需要人工操作，非无限自动重试。
- SIGINT / SIGTERM：停止消费、等运行任务完成、关闭 Queue / Redis、断开 Prisma。真实测试覆盖 restart 与 close；不声称测试了所有 OS 强杀时序。

## PUSH

- migration 16 新增 `PushDevice` 与 `PushDispatch`；历史 15 个 migration 未修改。
- 注册/注销认证端点、token 唯一、多设备、owner/version、disabled、lease；发送时锁定设备并重读 owner/version，旧账号 dispatch 被取消。
- NEW_LETTER 只通知收件人，文案来自 immutable account snapshot。运输 allowlist：TRANSPORT_DELAYED / COURIER_MISSING / LETTER_RECOVERED / TRANSPORT_CHANGED / OUT_FOR_DELIVERY / DELIVERED / PERMANENTLY_LOST / DESTROYED。
- safe Timeline projection → durable dispatch → injectable provider；固定文案，不转发任意 metadata/description。Hidden causes、station arrival/departure、opened 不发送。
- unique dispatch 约束 + transaction 防重；provider 外部交付 best effort，崩溃边界可能重复，绝不声称 exactly once。
- invalid ticket/receipt 禁用对应 generation；provider retry 不更改 Letter / Journey / WorldEvent；receipt 分页避免前 100 条 pending 饿死后续记录。
- Mobile permission/token acquisition 可失败，App 正常工作；注册 generation fencing、logout 先等注册再 best-effort unregister，保留 token 在下次登录重绑。无法撤回已交给 provider 的通知，离线设备注销不是即时服务器撤销保证。

## REFRESH

- Detail 联合取 Letter / Timeline，Map 取现有 pure Map DTO：5 秒；列表：30 秒。
- focus + AppState active 控制 timer；foreground 即时刷新；single-flight 合并积压，epoch 拒绝失焦旧响应，卸载清理。
- authenticated client 401 共享 refresh、只重试一次；旧账号重试不得清除新账号 session。refresh token 轮换前检查是否仍为原 token。
- Push 接收/点击仅触发 refetch；冷启动 response 支持，trackingNo 严格格式校验，无 UI redesign。

## GATE REMEDIATION（2026-09-17）

独立 Gate 结果 `FINAL GATE FAIL`，仅两个 MAJOR correctness blocker。本轮只修这两项，不扩展功能、不进入 Phase 10。

- **M1 跨账号共享 refresh Promise**：`createAuthenticatedFetch` 原先用一个全局 `refreshing` Promise 合并 401 refresh。账号切换后（session generation 变化）新账号的 401 会命中旧账号仍在飞的 refresh：若该 refresh 失败，新账号会被误判为认证失效并执行 `invalidate`。修复：shared refresh 以 `{ generation, promise }` 缓存，仅 generation 相同才复用；generation 不同立即发起属于新 generation 的 refresh。缓存清理用身份比对（`refreshing === entry`），旧条目结束不会清掉新条目。
- **M2 旧 epoch 认证异常停止当前轮询**：poller 的 `catch` 原先无条件在 `AuthExpiredError` 时置 `authFailed = true` 并 `stopTimer()`。上一 focus / background 期间发出的请求迟到失败时，会杀掉当前 focus 刚刚建立的 timer，并让 `authFailed` 永久屏蔽后续恢复。修复：只有「仍为当前 epoch」的失败（`active && !disposed && started === epoch`）才允许停表；同一条件同时用于 `value` / `error` 投递，保持「旧焦点结果不上屏」的既有契约。
- **回归测试（3 项，均先在旧实现上实测失败，再在修复后通过）**：
  - `apps/mobile/src/api/authenticatedFetch.test.ts`：「never reuses the previous account's refresh for the new account」——A 账号 refresh 悬挂时切换 generation，B 账号必须发起自己的 refresh、不得复用 A 的结果、不得被 A 的失败 `invalidate`（旧实现断言到 `refresh` 只被调用 1 次即失败）。
  - `apps/mobile/src/refresh/poller.test.ts`：「a stale epoch auth failure cannot stop the current polling」——旧 epoch 的 `AuthExpiredError` 不得清掉当前 timer，合并请求仍须补发（旧实现 timer 归零、补发丢失）。
  - `apps/mobile/src/refresh/poller.test.ts`：「a stale auth failure while backgrounded cannot block the next foreground」——background 期间的迟到认证失败不得让下一次 foreground 无法恢复轮询（旧实现 `authFailed` 永久置位）。
- **门禁复验**：全量 **421 passed / 0 failed / 0 skipped**（41 文件；mobile 91 → 94，其余包不变）；typecheck / lint / format:check 均 PASS；无回归面（mobile 源码仅两个文件改动，无 schema / migration / 依赖变化）。Finalization 轮补跑 build / prisma / graph / map 后重跑为 **423 passed**。

## GATE REMEDIATION FINALIZATION（2026-09-17）

补尾轮：不修改 M1 / M2 业务代码（仅在验证「新测试能否捕获缺陷」时临时劣化一次并已还原，最终无净改动），只做文档修正、门禁实跑、语义覆盖确认与仓库卫生。

### 1. dev 数据状态修正（项目负责人已确认）

项目负责人已明确：dev 库中的人工业务数据由项目负责人本人创建，至少含 User=2、Letter=2 及相应关联业务记录。据此修正此前「来源待确认 / NOT READY」的表述：

- `docs/PROJECT_STATUS.md`：阶段行与状态段改为 `Phase 9 Gate Remediation completed — awaiting Independent Re-Gate`；dev 数据段改为「已确认为项目负责人本人的人工 dev 测试数据，不属于未知测试污染，不构成 Phase 9 blocker，未删除或修改」，并显式声明早期 `2 User / 1 Letter / 1 Journey / 6 Leg` 快照不代表当前 Gate 基线。
- `docs/PHASE9_IMPLEMENTATION_REPORT.md`：MIGRATIONS / RUNTIME 段与结尾状态段同步修正。
- `驿书_V1_Coding_Agent_阶段规划.md` §11：同步 dev 数据确认结论与当前状态。

未删除、未修改任何 dev 业务数据。

### 2. 门禁实跑（本轮逐条实际执行）

| 门禁                         | 实测                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm prisma:validate`       | exit 0                                                                                                                      |
| `pnpm prisma:generate`       | exit 0，无 tracked 文件变化                                                                                                 |
| `pnpm graph:validate --json` | exit 0；`--json` 不写报告；报告中的 `2026-09-17T11:03:16.051Z` 为此前生成时间，`china-v1` 294 nodes / 1949 edges 等结论不变 |
| `pnpm map:generate`          | exit 0，产物字节级不变（`git status` 对 `data/maps/**` 无输出）                                                             |
| `pnpm typecheck`             | exit 0                                                                                                                      |
| `pnpm lint`                  | exit 0                                                                                                                      |
| `pnpm format:check`          | exit 0（All matched files use Prettier code style）                                                                         |
| `pnpm test`                  | exit 0，**423 passed / 0 failed / 0 skipped，41 文件**                                                                      |

`build:packages` 与 `@yishu/worker` build 作为 `pnpm test` 脚本前缀一并通过；test / build 未并行。

### 3. 四项语义覆盖确认

**M1（`createAuthenticatedFetch`）**

| 语义                                                                        | 覆盖测试                                                                                                   | 结论                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A 同 generation 并发 401 共享一次 refresh，且各请求最多 retry 一次          | `shares one refresh across concurrent 401 responses`                                                       | 覆盖；本轮补强为同时断言 `fetchImpl` 恰好 4 次（2 请求 × 各 1 次重试），排除重试风暴                                                   |
| B 跨 generation 不复用上一账号的 refresh，迟到 retry 不得 invalidate 新账号 | `never reuses the previous account's refresh for the new account`、`late retry from A cannot invalidate B` | 覆盖                                                                                                                                   |
| C 迟到完成的 cleanup 不得破坏当前 refresh state                             | 新增 `keeps the new account's shared refresh after the previous account's refresh settles`                 | 本轮新增；A 的 refresh 在 B 的条目已建立后才结算，随后第三个 B 请求必须复用 B 的在飞 refresh（`refresh` 恒为 2 次）且不得 `invalidate` |
| D 当前 generation 真失败仍进入 auth expiry / `invalidate`                   | `failed refresh invalidates authentication`                                                                | 覆盖                                                                                                                                   |

**M2（poller epoch 与 timer 生命周期）**

| 语义                                                 | 覆盖测试                                                                                                                                 | 结论                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 旧 epoch 成功结果不上屏、不打扰当前 epoch          | `coalesces pending requests and rejects responses from the previous focus`、`unmount clears timers and ignores in-flight results`        | 覆盖                                                                                                                                                                                                 |
| B 旧 epoch 普通错误不停当前表、不通知当前 epoch      | 新增 `a stale epoch normal error cannot stop or notify the current epoch`                                                                | 本轮新增；断言 timer 仍为 1、`error` 未调用、合并请求仍补发、随后恢复轮询。**说明：该用例在修复前实现上同样会通过**（旧实现的非认证错误分支本就带 `started === epoch` 判定），属契约护栏而非缺陷复现 |
| C 旧 epoch `AuthExpiredError` 不停当前表、不阻塞恢复 | `a stale epoch auth failure cannot stop the current polling`、`a stale auth failure while backgrounded cannot block the next foreground` | 覆盖（两项在修复前实现上实测失败）                                                                                                                                                                   |
| D 当前 epoch `AuthExpiredError` 停表且无 401 风暴    | `expired authentication stops polling without a 401 storm`                                                                               | 覆盖                                                                                                                                                                                                 |

**缺陷捕获能力实测**：把 M1 的 cleanup 临时劣化为无条件 `refreshing = null`（模拟「迟到 cleanup 误清新条目」），新增的 C 用例在 `expect(refresh).toHaveBeenCalledTimes(2)` 处实测失败（实测 3 次），其余 95 项不受影响；随后还原为身份比对实现并重跑全量通过。M1 / M2 业务代码最终无净改动。

### 4. 测试增量

- `apps/mobile/src/api/authenticatedFetch.test.ts`：5 → 6；`apps/mobile/src/refresh/poller.test.ts`：10 → 11。
- Mobile 94 → 96；全量 421 → **423**，仍为 41 文件、0 failed、0 skipped。

### 5. 仓库卫生（本轮结束时）

- **未 Commit、未 Push**，分支 `main`，`origin/main` 未变；未进入 Phase 10。
- 工作区：`git diff --shortstat` = 32 files changed / 703 insertions / 2460 deletions；未跟踪路径 15 项（Phase 9 新增源码、测试、migration、文档）。无临时脚本（`tmp-*` 已清理）、无真实 push token、无日志残留；dist / generated 为被忽略的可再生构建产物。
- **误删恢复**：本轮发现 `docs/PHASE4_COMPLETION_REPORT.md` 在工作区被删除（该文件按本报告 DELIVERABLES 表应为 HISTORICAL 保留），已用 `git checkout --` 从 HEAD 恢复（封板复核确认与 HEAD 字节一致，335 个换行、末尾至 §56 完整；原“212 行 / §39”记录有误）。恢复后 `docs/` 为 4 个 Markdown，仓库无其他 Markdown 缺失。

### 6. Markdown 恢复性审计

- 全仓 Markdown 22 个（含 `.codebuddy/memory/*` 与 `apps/mobile/.expo/README.md` 生成物）：`docs/` 4 个、根目录 4 个、`data/` 2 个、`data/maps/` 1 个。
- `pnpm format:check` 覆盖 `*.md` 且实际通过 → 无解析失败、无尾随空白 / 行尾策略问题。
- `git status` 除已恢复的 Phase 4 报告外无任何 Markdown 删除或截断；`docs/PHASE9_IMPLEMENTATION_REPORT.md`、`docs/PROJECT_STATUS.md`、根阶段规划的 `##` 段落与结尾状态行完整。

## MIGRATIONS / RUNTIME

- 磁盘 / dev / test：16 migrations，0 unfinished、0 rolledback、0 checksum drift。
- Fresh 临时库 1→16 migrate deploy 一次性成功；fresh/dev/test schema diff 为空。临时库已删除，仅删除本轮创建的 fixture DB。
- Prisma 显式 `map` 保持 migration16 PostgreSQL 截断后的唯一索引名称一致；未重写已应用 migration / checksum。
- 早前核验 dev 12 张业务表均 0；最终复查 dev 出现 User=2 / RefreshToken=5 / Letter=1 / RecipientState=1 / SenderState=1 / Journey=1 / TransportLeg=6 / TimelineEvent=2，其他 4 表为 0。**这是当时的历史快照**：此后项目负责人又自行新增了人工 dev 数据（至少再 1 封 Letter，即当前 User=2 / Letter=2 及相应关联业务记录），因此上述早期 `Letter=1` 等数字**不代表当前 Gate 固定基线**。dev 数据来源已由项目负责人确认，为本人进行的人工 dev 测试数据；该数据不属于未知测试污染，不构成 Phase 9 blocker，未进行删除或修改。不再启动 dev Worker。dev/test 均无 idle-in-transaction、无 Lock waiter。Phase 9 集成测试经 `requireTestDatabaseUrl` 只连接 `/yishu_test`，与 dev URL 不同。
- PostgreSQL 17.11、Redis 7.4.11；Redis PONG、AOF=yes；Docker 容器 healthy。
- production-mode API `/api/v1/health`=200；Worker ready、SIGTERM handler 关闭资源成功。Windows smoke 用受控 IPC 触发同一 signal handler，非 Unix 原生 signal 测试。
- smoke 使用临时进程配置与随机加密 key、空 dev 库，无真实 Expo 发送；未改 `.env`。

## TESTS / QUALITY

- Phase 9 定向：API 真 DB/Redis 12 + Mobile 27 + Worker 2 = **41/41，连续三轮通过**。包含重复入队/执行、两个实际 runtime、late catch-up、终态 stale、重启、临时 TCP 断连恢复、Push ownership/dedupe/invalid/provider failure、polling/auth/native notification lifecycle。Gate Remediation 新增 3 项（全在 Mobile 侧），定向合计记为 **44/44**；Finalization 再新增 2 项 → **46/46**（增量恒为 +2）。
- 定向 Mobile 子集可复核口径（本轮逐文件实测）：`api/authenticatedFetch.test.ts` 6 / `auth/authService.test.ts` 10 / `push/PushRegistration.test.ts` 6 / `refresh/poller.test.ts` 11，合计 **33 passed**。早前报告写的「Mobile 27 → 30」集合划分本机未能逐字复现，故以四文件 33 与全量 423 作为可复核数字。
- Phase 5–8 回归随全量执行：world-events 33、journey-advance 17、timeline 36、letter-visibility 5、map-view 14、maps 14、graph-data 8、map-station-point 30，合计 157。
- 最终全量 **418 passed / 0 failed / 0 skipped，41 文件**：API 263 / Mobile 91 / Worker 2 / shared 11 / config 19 / db 2 / simulation 11 / routing 19。Gate Remediation 后重跑 **421**（Mobile 91 → 94）；Finalization 轮再次重跑并新增 2 项 → **423 passed / 0 failed / 0 skipped，41 文件**（Mobile 94 → 96，其余包不变）。
- 实际串行 typecheck / lint / format:check / test / build / prisma:validate / prisma:generate / graph:validate / map:generate 均通过；test / build 未并行。
- Expo Android production export 最终重跑通过（1441 modules）。真实设备推送需要部署凭据，本轮只 fake provider，不宣称已完成真机投递验收。

## REPOSITORY HYGIENE / GIT

- KEEP：domain 提取、queue/scheduler/runtime/provider/processor、Push API、Mobile refresh/push、对应测试、migration16、文档与兼容依赖；graph validation report 仅刷新 generatedAt，数据与结论不变。
- DELETE：旧 worker constants 骨架及其占位测试，已以真实 queue contract 测试替代。可从 Git HEAD 恢复。
- DELETE pending：NONE；未新增临时脚本、真实 push token 或日志文件。dist/generated 为被忽略可再生构建产物。
- NEEDS JUSTIFICATION：暂无额外正式业务范围；非功能性规模优化与真机凭据配置留作部署前事项。
- Finalization 轮结束时实测：`git diff --shortstat` = 32 files changed / 703 insertions / 2460 deletions；未跟踪 15 项。`docs/PHASE4_COMPLETION_REPORT.md` 曾被误删，已从 HEAD 恢复。
- 无 Commit、无 Push、无 Phase 10。

## FINALIZATION MARKDOWN AUDIT

正式 Markdown 清单由 `git ls-files "*.md"` 与 `git ls-files --others --exclude-standard "*.md"` 合并，共 10 份。不将 ignored Agent memory / Expo / 第三方生成文档作为产品状态来源。

| File                                 | Role                     | Classification | Changed? | Final status / reason                                                                                   |
| ------------------------------------ | ------------------------ | -------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| README.md                            | 当前使用说明             | UPDATE         | YES      | Phase 9 COMPLETE、Phase 10 NOT STARTED；补 domain / Push 模型，去除旧未实现描述                         |
| docs/PROJECT_STATUS.md               | 当前状态与质量基线       | UPDATE         | YES      | Re-Gate PASS、423/96/56×3、迁移与证据来源同步                                                           |
| 驿书_V1_Coding_Agent_阶段规划.md     | Phase 唯一来源           | UPDATE         | YES      | Phase 9 PASS / COMPLETE，Phase 10 未启动；findings 标明历史 resolved                                    |
| 驿书_V1_Coding_Agent_开发规范.md     | 产品/技术契约            | UPDATE         | YES      | 仅同步已验收 job identity、canonical reuse、refresh fencing、safe Push 与日志隐私契约；不写测试数或 SHA |
| 驿书_V1_Coding_Agent_协作开发流程.md | 稳定协作流程             | NO CHANGE      | NO       | 流程未变                                                                                                |
| docs/YISHU_V1_SPEC.md                | 规范索引                 | NO CHANGE      | NO       | Phase 索引准确                                                                                          |
| docs/PHASE4_COMPLETION_REPORT.md     | Phase 4 历史             | HISTORICAL     | NO       | 已有归档说明，完整到 §56，历史正文不改                                                                  |
| data/README.md                       | 图数据契约               | NO CHANGE      | NO       | 图数据契约未变                                                                                          |
| data/maps/README.md                  | 地图资产/许可真相源      | NO CHANGE      | NO       | 地图契约未变                                                                                            |
| docs/PHASE9_IMPLEMENTATION_REPORT.md | Phase 9 实现与 Gate 归档 | UPDATE / KEEP  | YES      | 保存架构、migration16、M1/M2 历史及最终独立证据                                                         |

DELETE / REDUNDANT: NONE。当前状态 STALE / CONFLICT: NONE。历史统计已明确分区。
封板仅验证 Markdown 格式、diff 与非 Markdown 哈希；引用刚完成的独立 Re-Gate，不冒充再执行一次全量 Gate。
