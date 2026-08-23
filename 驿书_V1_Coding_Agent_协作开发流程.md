# 驿书 V1 — Coding Agent 协作开发流程

> 本文档定义 **驿书 V1 的开发协作方式**。  
> Coding Agent 必须遵守本文档执行任务。  
> 本文档不替代 `docs/YISHU_V1_SPEC.md`，产品与技术需求仍以 `YISHU_V1_SPEC.md` 为唯一业务规范。

---

# 1. 核心协作原则

本项目采用：

```text
需求规范
↓
单阶段开发
↓
Agent 自测
↓
Agent 汇报
↓
人工 / LLM 评审
↓
通过
↓
Git Commit
↓
进入下一阶段
```

禁止：

```text
一次性开发整个 V1
```

禁止 Coding Agent 在完成当前阶段后：

```text
自动进入下一个 Phase
```

每个阶段完成后必须：

```text
停止开发
等待评审
```

---

# 2. 参与角色

当前协作角色：

## Coding Agent

职责：

- 阅读规范
- 编写代码
- 运行命令
- 执行测试
- 自行修复本阶段错误
- 汇报真实执行结果
- 在当前 Phase 完成后停止

Coding Agent 不是最终需求决策者。

---

## 项目负责人

职责：

- 发出每个 Phase 的开发指令
- 提供 Agent 的完整执行结果
- 决定是否接受评审意见
- 决定什么时候进入下一阶段

---

## 技术评审 LLM

当前参与评审的模型包括：

```text
ChatGPT
Luna
DeepSeek V4 Flash
```

主要职责：

- 检查是否符合需求规范
- 检查是否超范围实现
- 检查技术架构
- 检查代码质量
- 检查测试结果
- 检查是否存在隐藏技术债
- 判断是否可以进入下一阶段

Coding Agent 不得假定自己已经通过评审。

---

# 3. 需求优先级

当信息冲突时，按以下优先级执行：

```text
1. 项目负责人最新明确指令
2. docs/YISHU_V1_SPEC.md
3. 本协作流程文档
4. 当前 Phase Prompt
5. Coding Agent 自己的实现偏好
```

Coding Agent 不得自行改变已经冻结的业务规则。

---

# 4. 每次开发前必须做什么

收到新的 Phase 指令后，Coding Agent 必须先：

1. 阅读 `docs/YISHU_V1_SPEC.md`
2. 阅读本协作流程文档
3. 明确当前 Phase 的边界
4. 检查当前 Git / 项目状态
5. 只修改本 Phase 必需内容

如果发现：

- 规范存在矛盾
- 当前代码状态阻塞开发
- 当前 Phase 无法在不修改架构的情况下实现

应先指出问题。

但如果问题可以在当前规范内自行解决：

```text
直接解决
不要把普通技术问题抛回给项目负责人
```

---

# 5. 一次只做一个 Phase

Coding Agent 必须严格限制开发范围。

例如当前指令：

```text
Phase 2：账号系统
```

则禁止顺手实现：

- Letter
- Journey
- 地图
- Worker
- Push
- 随机事件

即使 Coding Agent 认为：

```text
“顺手一起做更方便”
```

也禁止。

---

# 6. 不允许自行进入下一阶段

当前阶段完成后：

```text
必须停止
```

不得执行：

```text
Phase N
↓
Phase N+1
↓
Phase N+2
```

必须等项目负责人明确发送：

```text
开始 Phase N+1
```

之后才能继续。

---

# 7. 每个阶段必须实际执行

禁止只生成代码、不运行。

每个 Phase 完成后，Coding Agent 必须根据当前项目实际情况执行适用的检查。

至少包括：

```text
依赖安装
TypeScript Check
Lint
Unit Test
Integration Test（如本阶段涉及）
Build / Start 验证（如适用）
```

例如：

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

如果本阶段新增 API：

```text
必须实际启动 API 或执行 Integration Test
```

如果本阶段新增 Prisma：

```text
必须执行 Prisma Validate / Migration 相关检查
```

如果本阶段新增移动端：

```text
必须至少确认 Expo / React Native 项目可以启动
```

---

# 8. 遇到错误时的处理原则

如果出现：

- TypeScript Error
- Test Failure
- Prisma Error
- Build Error
- Lint Error
- Runtime Error
- Import Error
- Dependency Error

Coding Agent 应：

```text
读取错误
↓
定位原因
↓
修复
↓
重新执行
```

不要在第一次报错后直接宣布：

```text
“基本完成”
```

---

# 9. 禁止绕过错误

禁止为了让测试“绿色”而：

- 删除测试
- 注释测试
- 使用 `skip`
- 大量使用 `any`
- 使用 `@ts-ignore`
- 关闭 TypeScript strict
- 关闭 ESLint 规则
- 注释掉失败业务
- Fake / Hardcode 一个通过结果
- 把实际失败描述为成功

如果确实存在无法解决的问题：

```text
必须明确标记为 FAILED / BLOCKED
```

并提供真实错误。

---

# 10. Agent 必须汇报真实结果

每个 Phase 完成后，必须提供以下内容。

---

## 10.1 修改文件

列出：

```text
新增文件
修改文件
删除文件
```

例如：

```text
新增：
apps/api/src/server.ts
apps/api/src/routes/health.ts

修改：
package.json
pnpm-workspace.yaml
```

不要只说：

```text
“完成了后端搭建”
```

---

## 10.2 执行命令

必须列出实际执行的关键命令，例如：

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
docker compose up -d
```

---

## 10.3 测试结果

必须明确：

```text
PASS
FAIL
未执行
```

例如：

```text
TypeScript: PASS
ESLint: PASS
Vitest: 14 passed / 0 failed
API Health Check: PASS
```

---

## 10.4 遗留问题

必须明确列出。

如果没有：

```text
遗留问题：无
```

禁止隐藏。

---

## 10.5 超范围修改

必须说明：

```text
是否修改了当前 Phase 之外的功能
```

正常应该：

```text
否
```

如果确实为了修复基础架构不得不修改：

```text
必须解释原因
```

---

# 11. 标准阶段完成报告模板

Coding Agent 完成 Phase 后应使用以下格式：

```md
# Phase X 完成报告

## 1. 完成内容

- ...
- ...
- ...

## 2. 新增文件

- ...

## 3. 修改文件

- ...

## 4. 删除文件

- 无

## 5. 实际执行命令

```bash
...
```

## 6. 检查与测试

- TypeScript: PASS / FAIL
- ESLint: PASS / FAIL
- Unit Test: PASS / FAIL
- Integration Test: PASS / FAIL / N/A
- Build / Start: PASS / FAIL / N/A

## 7. 测试统计

- Tests: X passed, X failed

## 8. 遗留问题

- 无

或：

- 问题：
- 原因：
- 当前状态：

## 9. 是否存在超范围修改

否

## 10. 当前是否建议进入下一 Phase

从 Coding Agent 角度：
READY / NOT READY

注意：最终是否进入下一 Phase 由项目负责人和评审决定。
```

---

# 12. 评审流程

Agent 输出完成报告后：

```text
项目负责人
↓
将代码结果 / 执行结果 / 报错 / Agent 总结
发送给评审模型
↓
进行技术评审
```

评审重点包括：

### A. 需求一致性

- 是否符合 `YISHU_V1_SPEC.md`
- 是否擅自增加功能
- 是否删除必要功能
- 是否误解冻结规则

### B. 架构一致性

- 是否使用指定技术栈
- 是否出现不必要的新依赖
- 是否破坏 Monorepo
- 是否出现架构漂移

### C. 代码质量

- TypeScript strict
- 模块边界
- 命名
- 错误处理
- 安全
- 幂等
- 可测试性

### D. 测试真实性

- Agent 是否真的运行测试
- 是否存在失败
- 是否跳过测试
- 是否只写测试但未执行

### E. 范围控制

检查 Coding Agent 是否：

```text
偷偷提前实现后续 Phase
```

---

# 13. 评审结论

评审最终应给出：

## PASS

当前 Phase 通过。

允许：

```text
Git Commit
↓
进入下一 Phase
```

---

## PASS WITH FIXES

主体正确，但有小问题。

流程：

```text
先修复指定问题
↓
重新测试
↓
重新汇报
```

未经修复不得进入下一 Phase。

---

## FAIL

当前 Phase 存在明显问题。

流程：

```text
保持当前 Phase
↓
修复
↓
重新评审
```

---

# 14. Git 节奏

每个通过评审的 Phase 建议单独 Commit。

例如：

```bash
git add .
git commit -m "chore: initialize project workspace"
```

下一阶段：

```bash
git commit -m "feat: implement user authentication"
```

再下一阶段：

```bash
git commit -m "feat: implement letter core"
```

原则：

```text
一个 Phase
≈
一个清晰可回滚的开发节点
```

---

# 15. 修改 Bug 的流程

如果评审发现问题：

不要重新执行整个 Phase。

项目负责人可以指令：

```text
修复 Phase 2 评审问题。

只修复以下问题：

1. ...
2. ...
3. ...

不要增加新功能。
不要进入 Phase 3。

完成后：
- 重新运行相关测试
- 运行完整 typecheck
- 汇报修改文件和测试结果
- 停止
```

---

# 16. UI 调整规则

涉及 UI 时，优先限制修改范围。

例如：

```text
只允许修改：

apps/mobile/app/letter/[trackingNo].tsx
apps/mobile/components/RouteMap.tsx

不得修改：
API
Prisma
Worker
Simulation
Routing
```

避免 Agent 因为一个 UI 修改而进行大规模无关重构。

---

# 17. 禁止无授权的大规模重构

Coding Agent 不得自行：

- 更换 Fastify
- 更换 Expo
- 更换 Prisma
- 更换 PostgreSQL
- 更换 Redis / BullMQ
- 引入新的全局状态框架
- 改 Monorepo 工具
- 改身份体系
- 改 Letter 状态体系
- 改地图技术方案
- 改随机事件体系

如果认为现有技术方案存在严重问题：

```text
先提出建议
不要自行替换
```

---

# 18. 技术债原则

V1 可以存在合理技术债。

但必须：

```text
明确记录
```

不要为了“完美架构”阻碍 MVP。

也不要为了“先跑起来”破坏已经冻结的重要规则。

优先级：

```text
业务正确
>
安全与数据正确
>
可测试
>
可维护
>
架构优雅
>
过度优化
```

---

# 19. Agent 不得虚构执行结果

非常重要：

Coding Agent 只能报告：

```text
实际运行过的结果
```

如果无法运行某命令：

必须说：

```text
未执行
```

不得写：

```text
“理论上应该通过”
```

然后标记 PASS。

---

# 20. Phase 进入条件

只有满足以下条件才允许建议 READY：

- 当前 Phase 功能完成
- TypeScript 检查通过
- 相关测试通过
- 没有高优先级 Bug
- 没有违反规格
- 没有重大遗留问题
- 没有未解释的超范围修改

---

# 21. 开发阶段顺序

当前 V1 默认顺序：

```text
Phase 1
项目骨架

Phase 2
账号与身份系统

Phase 3
Letter 核心 + Mobile 基础信件流程

Phase 4
本地 Graph + Dijkstra

Phase 5
Simulation Core + Journey + Random Events

Phase 6
BullMQ Simulation Worker

Phase 7
地图与 Timeline

Phase 8
DEV Simulation Debug Panel

Phase 9
Polling + Push

Phase 10
V1 Final Audit
```

实际细分可以由项目负责人决定。

但：

```text
不得跳过评审机制
```

---

# 22. 每个 Phase 的标准结束指令

项目负责人通常会在 Prompt 末尾加入：

```text
完成当前 Phase 后：

1. 实际运行所有适用测试。
2. 实际运行 TypeScript 检查。
3. 如果出现错误，自行定位并修复。
4. 不允许通过删除测试或关闭检查绕过问题。
5. 给出完整 Phase 完成报告。
6. 完成后停止。
7. 不要进入下一 Phase。
8. 等待项目负责人评审。
```

Coding Agent 必须遵守。

---

# 23. 项目当前状态

当前阶段：

```text
Phase 1：项目骨架
```

当前目标：

```text
只建立可运行、可测试、可继续扩展的基础工程。
```

当前禁止提前开发：

- 用户业务
- Letter
- Journey
- Simulation
- 地图
- Push

---

# 24. Phase 1 当前执行要求

Phase 1 应完成：

```text
pnpm workspace

apps/mobile
apps/api
apps/worker

packages/shared
packages/simulation
packages/routing
packages/config

Prisma
PostgreSQL
Redis
Docker Compose

TypeScript strict
ESLint
Prettier
Vitest

.env.example

pnpm dev

API health check
```

完成后必须：

```text
运行
↓
检查
↓
修复
↓
汇报
↓
停止
```

不得开始 Phase 2。

---

# 25. Coding Agent 当前指令

如果当前还未开始 Phase 1，请执行：

```text
完整阅读：
1. docs/YISHU_V1_SPEC.md
2. 本开发协作流程文档

现在只执行 Phase 1：项目骨架。

严格控制范围，不实现任何业务逻辑。

完成后必须：
- 实际安装依赖
- 实际执行 TypeScript Check
- 实际执行 ESLint
- 实际执行 Vitest
- 实际验证 API Health Check
- 修复所有本阶段可修复错误

然后按照本文件定义的《Phase 完成报告模板》汇报。

完成后立即停止。

不要进入 Phase 2。
等待项目负责人和技术评审 LLM 的评审结果。
```

---

# 26. 最终原则

整个项目始终遵守：

```text
小步开发
小步验证
小步提交
```

而不是：

```text
一次生成整个项目
然后一起排错
```

Coding Agent 的任务是：

```text
把当前一步做到真的能跑
```

而不是：

```text
尽可能多写代码
```
