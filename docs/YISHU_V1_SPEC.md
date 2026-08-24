# 驿书 V1 需求规范

驿书 V1 的唯一业务需求来源为项目根目录下的：

- `驿书_V1_Coding_Agent_开发规范.md`

本文件为指向该规范的状态说明。开发规范位于仓库根目录，执行 Phase 开发时请以根目录规范文档为准。

## Phase 开发顺序

按根目录《驿书 V1 — Coding Agent 协作开发流程》中定义的阶段顺序执行。
**Phase 编号、阶段边界与功能归属的唯一来源是根目录《驿书_V1_Coding_Agent_阶段规划.md》**；本表仅为速览，若与本文件不一致，一律以阶段规划为准：

```
Phase 1   项目骨架与基础设施
Phase 2   账号与身份系统
Phase 3   Letter 核心与基础信件流程
Phase 4   Journey + Routing + TransportLeg
Phase 5   Simulation Core + Transport Progression
Phase 6   Random Events + Recovery + World Truth
Phase 7   Timeline + 用户可见运输事实
Phase 8   Local Map + Journey Visualization
Phase 9   Worker Scheduling + Push + Refresh（BullMQ / Polling / Push）
Phase 10  Mobile V1 Integration + UX Closure
Phase 11  Security / Reliability / Performance Hardening
Phase 12  Deployment + Release Gate
```
