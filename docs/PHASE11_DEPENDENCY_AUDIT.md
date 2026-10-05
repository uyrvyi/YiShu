# Phase 11 依赖审计

> 2026-09-30 · npm registry 在线审计 · 非零公告，不标记 audit PASS

## 实测与兼容补丁

```bash
sh scripts/dev.sh exec -T dev pnpm audit --prod --audit-level high --json
```

补丁前为 **30 HIGH / 7 Moderate / 0 Critical**；通过 `pnpm-workspace.yaml` 的精确范围 override 安装兼容补丁后，为 **4 HIGH / 3 Moderate / 0 Critical**。审计仍退出 1，不能表述为零漏洞或 `pnpm audit PASS`。

| 依赖           | 原版本          | 最终版本        | 范围                                                             |
| -------------- | --------------- | --------------- | ---------------------------------------------------------------- |
| fast-uri       | 3.1.5 / 4.1.2   | 3.1.8 / 4.2.1   | Fastify / Ajv / JSON serializer；同主版本修复全部已报告 URI 公告 |
| @xmldom/xmldom | 0.8.14 / 0.9.11 | 0.8.15 / 0.9.12 | Expo XML/plist 工具链；保持对应 0.x 版本线                       |
| js-yaml        | 4.3.1           | 4.3.2           | YAML 工具链；不强制升级到主版本 5                                |

Expo SDK `57.0.15`、Prisma `7.9.1`、BullMQ `6.3.6` 未升级。`pnpm install --frozen-lockfile` 与供给链策略通过；补丁后全量 503/0、typecheck、lint、build（Android 3321 modules / 5.5 MB）均通过。风险可达性由独立 Reviewer 复核，不能仅按包路径或 severity 数值直接宣布安全。

## 剩余公告

| 依赖/版本                  | 严重性   | 公告                                                                   | 路径与约束                                                                                             |
| -------------------------- | -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| deepmerge-ts 7.1.5         | HIGH     | [递归对象栈耗尽](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)    | Prisma 配置工具链；不接受不可信配置对象，不把本地 CLI 合并能力暴露为 API                               |
| mysql2 3.15.3              | HIGH     | [认证插件降级](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)      | Prisma 的可选 MySQL 驱动；本项目仅允许 PostgreSQL 连接串且使用 PG adapter，禁止启用 MySQL 后沿用本结论 |
| image-size 1.2.1           | HIGH     | [JXL/HEIF 无限循环](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) | Metro 构建图片解析；仅构建可信资产，不能接入不可信图片上传或公开 Metro；扩展名不是安全边界             |
| image-size 1.2.1           | HIGH     | [ICNS 无限循环](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)     | 同上；上游 2.0.4 已可安装，但 Metro 使用 1.x API，不能未经兼容回归强制跨主版本覆盖                     |
| uuid 7.0.3                 | Moderate | [公告](https://github.com/advisories/GHSA-w5hq-g745-h8pq)              | Expo/Xcode 工具链；不用于本项目 UID、Refresh Token 或认证随机性                                        |
| decode-uri-component 0.2.2 | Moderate | [公告](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)              | query-string / Expo Router 链；不能直接假定为纯 CLI 风险，Deep Link 边界须在发布前复验                 |
| mysql2 3.15.3              | Moderate | [公告](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)              | 可选 MySQL 驱动，不用于当前 PostgreSQL 数据路径                                                        |

这些公告未被宣称修复。构建/配置输入信任边界、MySQL 禁用与 Metro 仅限受控开发网络必须保持；任何改变都需要重审。生产依赖裁剪、兼容升级和剩余公告处置仍属于 Release Gate 开放项。

## 独立复审结论

独立 Reviewer 本轮实读依赖链与应用源码，确认当前 API/Worker 未发现 deepmerge-ts 不可信配置入口、MySQL 连接或图片上传解析链。image-size 的构建输入必须可信，不能按扩展名过滤后宣称安全。decode-uri-component 则确实存在客户端依赖：当前 Expo 57 主 Deep Link query 路径使用 `new URL(...).searchParams`，遗留 React Navigation 路径才调用该解码器，未证实本应用当前触发。禁止未经重评切换至遗留解析路径；Phase 12 须对实际签名构建补做恶意链接复验。

独立定向复跑 **302/0 = API 163 + Config 29 + Worker 4 + Mobile 106**。Reviewer 在上述限定边界下维持 **Phase 11 FINAL GATE PASS / COMPLETE**，不把公告或 Expo 检查标成 PASS，也不授权生产发布。审查与探针进程均已退出。

## Expo 版本诊断

```bash
sh scripts/dev.sh exec -T dev pnpm --filter @yishu/mobile exec expo install --check
```

本轮实际 **退出 1**，提示 SDK 57 的新推荐补丁：Expo `~57.0.26`、constants `~57.0.20`、linking `~57.0.11`、notifications `~57.0.21`、router `~57.0.24`、secure-store `~57.0.4`、React Native `0.86.3`。这不是本轮构建或 503 项测试失败，但不能沿用旧报告中的“当前 expo check PASS”。

保持曾通过 iPhone 核心流程的现有 SDK 版本，未盲目升级。Phase 12 版本冻结时须决定兼容升级/锁定方案，复跑构建、检查和真机验收；不能将推荐版本诊断或成功 Android export 写成真实 iOS Release Gate PASS。
