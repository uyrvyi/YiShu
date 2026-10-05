# Phase 11 实施记录

> 2026-09-30 · Security / Reliability / Performance Hardening · FINAL GATE PASS · COMPLETE

## 当前结论

**Phase 11 已封板，独立 Final Gate PASS（2026-09-30）**。认证、并发、正文完整性、列表过滤、日志/字段权限、一年 replay、迁移和 V1 本地性能基线通过；多小时耐久由负责人确认完成。首轮 HIGH-1 与复审 MEDIUM-1 均已修复并独立复验关闭，无未关闭 Phase 11 阻塞发现。最终全量 503/0，独立定向 302/0。audit 仍为 4 HIGH / 3 Moderate、ExpoCheck 非零，其使用边界和发布待办见 [依赖审计](PHASE11_DEPENDENCY_AUDIT.md)。完整结论和证据见 [Final Gate 报告](PHASE11_FINAL_GATE.md)。Phase 12 可进入但尚未实施，V1 Release Gate 未通过。

## 首批加固

- `/auth/register`：同一客户端 IP 每 10 分钟最多 5 次；`/auth/login`：每分钟最多 10 次；`/auth/refresh` 与 `/auth/logout`：每分钟最多 60 次。超限返回 429 `rate_limited` 与 `Retry-After`。
- 开发/生产 API 使用现有 Redis 共享计数，Redis 故障时不放行认证请求；测试可注入实例内存计数。限流基于 Fastify 解析的连接 IP，不信任客户端自行发送的 `X-Forwarded-For`。
- 移动端将登录/注册的 429 显示为“尝试过于频繁，请稍后再试”。启动错误日志只保留错误类别，不打印可能带凭据的连接错误正文。

## 认证与并发加固（2026-09-30）

- 不存在账号也执行一次相同参数的 Argon2id 校验，修复明显的跳过密码计算分支；不存在账号和密码错误保持同一 401。测试断言校验调用和成本参数，不将其表述为严格恒定时间。
- Redis 认证计数禁用离线队列，命令超时设为 2 秒，连接超时 5 秒；断连时认证请求返回安全 500，不访问用户表，健康检查仍可用，重连后恢复。故障注入只断开测试客户端，未停止共享 Redis 服务。
- 真实 Redis 测试使用随机独立 namespace：两个 API 实例同时发送 12 次请求，仅 10 次进入校验，其余 429；API 实例重建保留额度，Redis key 到期后恢复额度。仅清理测试自身的 key。
- `/users/search` 每 IP 每分钟最多 60 次，改变查询字符串不能重置额度；保持公开精准查询的产品规则。移动端显示等待后重试提示。
- 保持 1 MiB 请求体上限，超大 body 返回 413，不支持的媒体类型返回 415，非法 JSON 保持 400。Refresh Token 输入上限 256 字符（现有签发值为 64 字符）；昵称仍按 20 Unicode code point 限制。
- Refresh Token 到期和注销后不可再换取 Access Token，数据库只存 SHA-256 hash。未改变不旋转 Refresh Token 的现有契约；已签发的 Access Token 仍按配置到期，不声称注销会立即撤销它。
- 拆信改为数据库 `UNOPENED` 条件更新，首次 `openedAt` 只写一次；缺失 RecipientState 返回安全错误，不虚报成功。真实 PostgreSQL 并发测试覆盖 12 次拆信与双方隐藏交错，首次写入恰一次，已读/隐藏状态均保留。
- AES-256-GCM 密钥、IV、authTag、ciphertext 必须严格满足 hex 编码和长度规则；拒绝截短 tag、非法后缀、密文/IV 篡改和错误密钥。数据库加密字段损坏时 API 只返回通用错误，不输出正文或加密字段。
- 新增只读 `pnpm migrations:check`，对照磁盘 SQL SHA-256 与 dev/test `_prisma_migrations`，检查缺失、重复、未完成及回滚记录；不修改迁移历史或业务数据。

## 性能与审计（2026-09-30）

- 修复列表先 `take` 再过滤隐藏状态的问题：SQL 在 limit 前过滤，最近的隐藏信不再挤掉旧的可见信；sent/received/全部列表与寄给自己时的 Sender 视角优先级保持不变。两项真实 DB 回归通过。
- 16 个固定 seed 场景覆盖两图版本 × 四运输方式 × 两样本。一年大跳跃与 24 个随机时间点分段推进（含重复/倒退）对完整 deterministic Journey/Legs/WorldEvents/Timeline 快照全等；冻结版本和 seed 保持，事件唯一，至多一个 ACTIVE leg。
- 请求日志只记录方法、路由模板、连接 IP，不记录原始 URL/query、headers 或 body；未知路由不回显原始 URL。结构化密码、令牌、连接串与密钥字段被移除，异常原文/stack 被净化。捕获真实 Pino 输出的三项测试通过，Worker 继续使用现有通用错误类别与安全队列失败信息。
- 资源 API 审计递归断言不含内部 ID、密文、seed、fingerprint、WorldEvent/payload/游标/时长等字段；覆盖 me/search/block、列表、详情、Journey、Timeline、Map、PushDevice 注册/注销。分别验证 Sender/Recipient/第三方和无认证访问；收件人仍无未来计划路线，无隐藏世界事件泄漏。Auth token 只在认证端点按现有契约签发，由既有认证测试覆盖，不把它误判为违规输出。
- 新增 `pnpm phase11:benchmark`：随机独立临时 `_test` 库应用 16 条迁移、schema diff 为空，生成 100 用户/10,000 封信/96 Journey；现有 dev/test schema diff 也均为空。负载前后状态属主、冻结版本/seed、外键验证、随机/事件游标及 ACTIVE leg 检查通过。
- 首轮完整基线：20 并发寄件列表 P95 142.49ms，混合突发轮询 P95 82.03ms；60.03 秒持续读 1904 次，P95 64.14ms，World Truth 完全不变；Worker handler 116.46/秒。最终原子恢复与兼容依赖补丁后复跑：寄件列表 P95 167.01ms、混合 99.32ms、60.39 秒 1872 次读取 / P95 170.25ms / P99 665ms / max 1795.68ms、Worker handler 86.24/秒，96 Journey 均终态。本地保护阈值均通过，不作为生产 SLA。完整负载、分位数与限制见 [性能基线](PHASE11_PERFORMANCE_BASELINE.md)。
- 正常路径临时库和隔离 Redis 队列清理成功，基线工具初始化顺序错误的失败路径也已验证清库；只读查询确认残留临时库为 0。该工具故障已修复并完整复跑通过，不作为产品故障或未完成门禁。

## 验证

- 全 workspace：**503 passed / 0 failed**（API 320、Mobile 106、Config 29、Shared 11、DB 2、Simulation 12、Routing 19、Worker 4）。包含一年随机 replay、日志/字段审计、Worker 重启/Redis 网络中断/重试耗尽恢复、失败原因竞态及收件人字段可见性回归。
- typecheck、lint、全 workspace build PASS；Android export 3321 modules / 5.5 MB，API/Worker 构建通过。API health HTTP 200，Metro HTTP 200 / `packager-status:running`。
- 迁移历史：**disk/dev/test = 16/16/16**；checksum drift、缺失、重复、未完成、回滚均为 0。fresh DB 1→16 与 fresh/dev/test schema diff 本轮实际重跑通过，不沿用历史证据。
- 本轮没有修改 Prisma schema、migration SQL、冻结图数据或开发库业务记录。源码仍未提交。

## Final Gate 修复与生产配置核查

- 独立首轮 Gate 为 FAIL：真实 PostgreSQL/Redis 故障探针耗尽 5 次重试，健康重启与两次 reconciliation 仍无法推进；保留的 failed jobId 阻塞重加任务。该记录不得被全量单测通过替代。
- 新增统一 `enqueueRecoverableJob`：仅对净化后的暂时错误 `worker_operation_failed`，通过 BullMQ 重试脚本重新激活 failed 任务并重置本轮尝试数；沿用每轮 5 次指数退避，补偿扫描每 30 秒运行。未知图/规则版本等不可恢复 domain 错误继续保留，不自动反复重试。Journey、PENDING Push 和 startup reconciliation 使用同一恢复逻辑。
- 真实队列回归：Journey 和 startup 均耗尽 5 次后，恢复数据库、重启 runtime、并发两次 reconciliation，无人工 `retry()` 即恢复推进并送达；Push 暂时失败耗尽后恢复，provider 仅调用一次，数据库 provider 尝试预算未重置；不可恢复 domain 任务保持 failed / 1 次。定向整文件 15/15 及全量通过，独立恢复探针确认 HIGH-1 关闭。
- 第二轮独立复审为 PASS WITH FIXES / COMPLETE NO：MEDIUM-1 在两轮真实 Redis 探针中复现，A 持旧暂时错误快照，B 产生 domain 错误，A 再次 retry 导致执行数由 2 增为 3。修复将当前 Redis 失败原因判定和重试转换合并为同一 Lua 原子操作；原样复用 BullMQ `reprocessJob-7` 脚本，只前置当前 `failedReason` 守卫，不手工改写队列状态机。两轮正式回归均保持执行数 2 和 domain failed。
- BullMQ 固定为 `6.3.6`，因为使用库内脚本；以官方 Redis 后端的 `defineCommand` / `runCommand` 执行，keys/name 不兼容时 fail-fast。未来升级须显式复核此接口和全部恢复/竞态回归，不能只更新版本号。
- 最终独立 Re-Gate 与依赖追加复验 PASS：302/0（API 163、Config 29、Worker 4、Mobile 106）；默认指数退避耗尽 5 次后自动恢复并送达，两轮旧快照交错均返回 0 / 执行数保持 2，HIGH-1 与 MEDIUM-1 全部关闭。
- 兼容依赖补丁保持 SDK/Prisma/BullMQ 主版本不变；补丁后全量 503/0 和构建/类型/lint 又通过。audit 30 HIGH / 7 Moderate → 4 HIGH / 3 Moderate，仍 exit 1；Expo 版本诊断 exit 1，不伪称安全扫描或版本检查通过。独立审查在当前受控边界接受，发布前继续处置，见 [依赖审计](PHASE11_DEPENDENCY_AUDIT.md)。
- Production 拒绝 JWT 默认值、占位值、少于 32 字节及同字符密钥，并拒绝默认/同字节正文密钥；不替换现有开发库加密密钥。生产 API 必须接入共享 Redis，禁止通过测试开关关闭限流。
- 显式 `trustProxy: false`；两个 production API 实例共有 10 次登录额度，改变 `X-Forwarded-For` / `Forwarded` 不能绕过限流。生产 JSON 日志无测试凭据、原始路径/查询或伪造 IP。真实 TCP 本地 production-mode health 200、未认证 401、安全 404，3/3 通过；不作为线上部署验收。
- 多小时耐久由负责人在本轮直接确认完成，作为人工验收证据。未提供具体时长、负载、GC 后堆快照或监控附件；不虚构这些数值，也不把此前 60 秒探针写成多小时自动化测试。

## Release 跟进边界

- 安全：当前仅信任直连 socket IP；Phase 12 若增加反向代理，须配置可信代理与客户端 IP 提取规则、阻断 API 直连绕过，并复验限流。真实生产密钥、TLS 和分布式账号滥用监控属部署门禁；公开精准查询按产品规则可确认账号存在。
- 并发：既有 block/send、幂等创建、Journey 初始化、Worker/Event 重复、送达转换回归及 12 次 open/hide 交错通过；尚未做更大并发/多实例写入压力。
- 完整性：fresh DB、schema diff、checksum、版本/seed 与业务关联检查已补齐。
- 性能：已记录本地 1 万封信基线，但未测 TCP/TLS、跨主机、注册密码计算、大量 PushDevice 和队列端到端吞吐，不把 handler 基线写成生产容量 SLA。
- 耐久：一年模拟与 60 秒读探针已通过，多小时运行由负责人确认；原始 heap 观测不代表 GC 后内存泄漏审计通过。Phase 12 仍需真实 iOS 远程推送验收。

源码尚未提交；**FINAL GATE PASS · PHASE 11 COMPLETE · MAY START PHASE 12: YES · REMAINING BLOCKERS: NONE**。
