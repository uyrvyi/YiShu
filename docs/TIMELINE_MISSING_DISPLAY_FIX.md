# 失联与到站展示修复

日期：2026-10-08

## 修复范围

- 同一运输段、节点及完成时刻存在 canonical `COURIER_MISSING` 时，不投影冲突的 `ARRIVED_STATION`。
- 不从隐藏原因或当前异常状态推断动态；恢复后也不补造原失联时刻的到站事实。
- 读取只返回当前 canonical 来源，旧版已物化的冲突行保留审计存储但不再展示。API、地图与推送入队共用此来源。
- 不修改运输结果、恢复计划、业务时钟、正文或图片，不执行数据清理和 schema migration。

## 验证与上线

- 5 项纯函数及 3 项隔离数据库集成回归通过，覆盖正常到站、失联、恢复、不同段/时间、隐藏原因、旧动态双方读取与刷新一致性。
- API 与领域模块 TypeScript 检查通过，领域模块构建通过。
- 16:02 发布 API `timeline-display-20261008-api-r1`、Worker `timeline-display-20261008-worker-r1`，容器均 healthy。
- 公网分别验证 `YS-20261003-AU5X1` 寄件人及收件人视图：失联动态存在，同刻到站动态不返回，双方结果一致；旧到站行与 WorldEvent 完整保留。
- Postgres、Redis、HTTPS 网关、地图服务及 Expo 预览的镜像与启动时间未改变。
- 回退文件保留于 `/opt/yishu/releases/timeline-display-20261008`：`cloud.env.before`、`compose.before.yml`；旧镜像保留。
- Worker 使用独立 `WORKER_RELEASE_TAG`，不改变原迁移镜像对应的 `NEXT_RELEASE_TAG`。
