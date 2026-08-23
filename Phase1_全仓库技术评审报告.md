# Phase 1 全仓库技术评审报告

> ## ⚠️ 已过期 / STALE
>
> **本文档是 Phase 1 的「首次评审」结论，所描述的仓库状态为评审时的历史快照，不代表当前仓库状态。**
>
> 自本次评审后，Coding Agent 已按评审意见完成 Phase 1 修复轮次，包括：
> - 接入 Expo Router（`expo-router` + `app/_layout.tsx` / `app/index.tsx`）
> - 安装并配置 Prisma 7（`prisma.config.ts`、validate/generate 通过）
> - 修复根 `pnpm dev` 三端启动
> - 统一环境变量加载与 workspace 开发链
>
> **请勿以本文档作为当前 Phase 1 的验收依据。当前状态请以最新完成报告与 README 为准。**
> 历史评审内容保留如下，供追溯。

---

本轮仅做 Review，未修改项目源码、配置或业务实现，也未进入 Phase 2。

当前评审环境没有可调用的 `node`、`pnpm`、`docker`、`git`，因此无法独立重跑 typecheck、lint、test、Prisma、Expo 或 Docker。仓库中的构建产物、Vitest 缓存和 Expo export 日志能佐证此前执行过部分验证，但不能替代本轮复测。

## BLOCKER

### 1. Expo Router 实际未配置

文件 / 位置：

- `apps/mobile/package.json:5`
- `apps/mobile/index.ts:1`
- `apps/mobile/App.tsx:4`

问题：

移动端使用传统 `registerRootComponent(App)` + `App.tsx` 入口。没有 `expo-router` 依赖、没有 `app/` 路由目录，`main` 也不是 `expo-router/entry`。当前页面仍是 Expo 模板文本。

为什么：

开发规范明确要求 Expo Router，当前完成报告中“Expo Router 已配置”的说法与仓库实际状态不符。现有 Android bundle 日志也明确使用 `apps/mobile/index.ts` 作为入口。

影响：

移动端核心骨架不符合冻结技术栈。后续再切换 Router 会改变入口、目录布局、导航和测试结构。

推荐修复：

使用 Expo SDK 57 对应版本安装并初始化 Expo Router；将入口改为 `expo-router/entry`，创建最小 `app/_layout.tsx` 与 `app/index.tsx`，补齐 Router 插件配置，并重新执行 Expo Doctor、typecheck 和 Android/iOS bundle 验证。

---

### 2. Prisma 7 没有安装，现有 schema 也不是完整的 Prisma 7 配置

文件 / 位置：

- `package.json:20`
- `pnpm-lock.yaml:1`
- `prisma/schema.prisma:5`

问题：

所有 package manifest 和 lockfile 中均没有 `prisma`、`@prisma/client` 或 Prisma 7 所需运行组件，也没有 Prisma validate/generate 脚本。当前 schema 使用：

```prisma
provider = "prisma-client-js"
url      = env("DATABASE_URL")
```

这是旧版配置形态；仓库也没有 Prisma 7 的 `prisma.config.ts`。

为什么：

只有一个名为 `schema.prisma` 的文件不等于“Prisma 7 已配置”，也无法实际执行 `prisma validate`、`generate` 或后续迁移。

影响：

Phase 2 无法可靠创建 User 模型、生成 Client 或执行迁移；当前“Prisma 7”完成声明不成立。

推荐修复：

安装并锁定 Prisma 7 CLI 及其所需运行依赖，按 Prisma 7 方式配置 generator、输出目录和 `prisma.config.ts`，保持 schema 暂无业务模型，然后实际运行 `prisma validate` 和 `prisma generate`。

---

### 3. 根目录 `pnpm dev` 不会启动 Mobile

文件 / 位置：

- `package.json:12`
- `apps/mobile/package.json:18`
- `README.md:54`

问题：

根脚本执行：

```text
pnpm --parallel -r run dev
```

API 和 Worker 有 `dev`，Mobile 只有 `start`，没有 `dev`。因此递归脚本不会启动 Expo。

为什么：

规范明确要求 `pnpm dev` 同时启动 mobile、api、worker，README 也做出了相同承诺。

影响：

Phase 1 的主要启动入口行为不符合规范，新开发者按 README 操作无法启动完整开发环境。

推荐修复：

为 Mobile 提供 `dev`，或在根脚本中显式调用 Mobile 的 `start`、API/Worker 的 `dev`；随后实际确认三个进程都启动且任一失败能向上传递非零退出状态。

## HIGH

### 1. `.env` 文件不会被 API/Worker 自动加载，配置包也没有覆盖基础设施变量

文件 / 位置：

- `.env.example:5`
- `packages/config/src/index.ts:10`
- `apps/api/src/server.ts:5`
- `README.md:88`

问题：

README 要求复制根 `.env.example` 为 `.env`，但 API/Worker 启动脚本没有加载该文件。`loadConfig` 只处理 `NODE_ENV` 和两个 Simulation 字段；`PORT`、`HOST`、`DATABASE_URL`、`REDIS_URL`、`SIMULATION_SEED` 均未校验。API 又绕过配置包直接读取 `process.env`。

为什么：

Node/tsx 不会因为根目录存在 `.env` 就自动加载它。默认端口恰好相同，只是掩盖了问题。

影响：

修改 `.env` 后 API/Worker 可能仍使用默认值；Phase 2 的数据库连接配置将不可靠。

推荐修复：

统一加载根环境文件，并由 `@yishu/config` 校验和导出 API、PostgreSQL、Redis 等基础设施配置；API 和 Worker 不再各自解析环境变量。

---

### 2. Workspace 包依赖构建后的 `dist`，但开发期间没有 watch

文件 / 位置：

- `package.json:12`
- `packages/shared/package.json:6`
- `packages/config/package.json:6`

问题：

内部包的入口均指向 `dist`。根 `dev` 只在启动前构建一次，而各 packages 没有 `dev`/watch 脚本。

为什么：

Phase 2 开发时若修改 shared/config，API、Worker 或 Metro 可能继续使用旧的 `dist`，必须手动重新构建。

影响：

容易产生“源码已改但运行的是旧代码”的隐蔽问题，热更新和开发反馈不可靠。

推荐修复：

选择并固定一种策略：为内部包提供 TypeScript watch，或让开发入口安全地消费源码；同时确保生产构建仍消费明确的编译产物。

---

### 3. 提前声明了多个后续 Phase 的业务类型

文件 / 位置：

- `packages/shared/src/index.ts:10`
- `packages/routing/src/index.ts:8`
- `packages/simulation/src/index.ts:8`

问题：

Phase 1 已加入 TransportType、LetterStatus、RecipientReadState、StationNode、RouteEdge、SimulationClock 等 Phase 3–5 类型。

为什么：

这些内容虽然来自正式规范，不属于“未授权功能”，但违反协作流程中“一次只做一个 Phase”和当前不得提前实现 Routing/Simulation/Letter 的边界。

影响：

过早冻结后续包的公共接口，并通过测试使其看起来已完成部分后续阶段。

推荐修复：

Phase 1 只保留包骨架和当前健康检查确实需要的基础常量；领域类型在对应 Phase 经过评审后引入。

---

### 4. Docker 尚未进行任何运行验证

文件 / 位置：

- `docker-compose.yml:1`

问题：

当前机器没有 Docker，未执行 `docker compose config`、`up -d`、容器 health check 或数据库/Redis 连通测试。

为什么：

Compose 静态配置总体合理，但“看起来正确”和“已实际运行”不是同一结论。

影响：

PostgreSQL/Redis 镜像启动、volume、端口占用、healthcheck 和真实连接尚无证据。Phase 2 将直接依赖数据库。

推荐修复：

在具备 Docker 的机器或 CI 上执行 `docker compose config`、`up -d`，等待两个服务 healthy，并分别执行 PostgreSQL、Redis 连通验证。

严重程度判断：**HIGH**。它不是已经证实的代码缺陷，因此不单独定为 BLOCKER；但它阻止 Phase 1 获得无条件 PASS，且应在进入数据库相关开发前补齐。

## MEDIUM

### 1. TypeScript 并非完全统一，且存在全局 `skipLibCheck`

文件 / 位置：

- `tsconfig.base.json:7`
- `apps/mobile/tsconfig.json:1`
- `apps/mobile/package.json:15`

问题：

服务端/packages 使用 TypeScript 5.9，Mobile 使用 6.0。Mobile 直接继承 Expo 配置，没有继承根配置中的 `noUncheckedIndexedAccess` 等规则。根配置与 Expo 配置都启用了 `skipLibCheck`。

为什么：

`strict: true` 确实已启用，也没有发现 `any`、`@ts-ignore` 或 `eslint-disable` 滥用；但“统一 TypeScript 配置”的完成度有限，`skipLibCheck` 会隐藏声明文件兼容问题。

影响：

跨 workspace 类型行为可能不一致，尤其是 TypeScript 5.9/6.0 与 ESLint parser 组合。

推荐修复：

统一或明确记录 TypeScript 版本策略；让 Mobile 在兼容 Expo 的前提下继承项目公共严格选项。若保留 `skipLibCheck`，应记录为明确例外。

---

### 2. 11 个测试中多数验证价值较低，构建还会输出测试文件

文件 / 位置：

- `apps/mobile/src/utils/format.test.ts:4`
- `apps/worker/src/constants.test.ts:4`
- `packages/routing/src/index.test.ts:4`
- `packages/simulation/src/index.test.ts:4`
- `apps/api/tsconfig.json:7`

问题：

API 的 Fastify `inject` 测试和 config 的 Zod 测试有实际价值；其余多为常量、任意 `pad2` 工具、类型样例或重新导出验证。它们不是 `expect(true)`，但测试数明显高于有效覆盖面。所有 `src` 被构建，导致 `*.test.js`、声明及 source map 进入 `dist`。

影响：

“11 tests passed”容易高估骨架质量，生产构建还携带测试产物。Mobile 测试并未加载 React Native 组件或验证入口。

推荐修复：

保留最小但有价值的边界测试；为 build 排除测试文件，并将 Mobile 的验证聚焦于真实入口/组件或 Expo bundle。

---

### 3. 根 `build` 不构建或 bundle Mobile

文件 / 位置：

- `package.json:13`
- `apps/mobile/package.json:18`
- `README.md:69`

问题：

Mobile 没有 `build` 脚本，因此 `pnpm --if-present -r run build` 会跳过它；README 却称其为“全 workspace 构建”。

影响：

根构建成功不能证明移动端可以 bundle。现有 Expo export 日志显示此前 Android bundle 成功过，但该验证不属于根 build 契约。

推荐修复：

增加明确的 Mobile bundle/check 脚本，或修正 README，明确 native build 与 workspace TypeScript build 的差异。

---

### 4. Node/pnpm 支持范围描述不够准确

文件 / 位置：

- `package.json:7`
- `README.md:39`

问题：

项目允许 Node `>=24.0.0`，但已安装的 React Native 0.86.2 要求 Node `^24.3.0`。项目固定 `pnpm@11.22.0`，同时 engines/README 又声称 pnpm 10+。

影响：

符合 README 的环境仍可能出现 engine warning、行为差异或不支持 workspace 配置字段。

推荐修复：

将 Node 限定到兼容的 Node 24 LTS 范围，并统一 README、engines 和 `packageManager` 的 pnpm 版本策略。

---

### 5. Docker 静态配置还有可改进点

文件 / 位置：

- `docker-compose.yml:7`

问题：

PostgreSQL healthcheck 没有显式指定 `${POSTGRES_DB}`；当数据库名和用户名不同时可能探测错误。数据库和 Redis 端口默认监听所有主机接口；固定 `container_name` 会影响多 checkout 并行运行。Redis 镜像仅固定到主版本 `redis:7`。

正面确认：

- PostgreSQL 确实为 17。
- 默认账号、密码、数据库及 `.env.example` 的 `DATABASE_URL` 相互匹配。
- Redis、volume、restart 和基础 healthcheck 均存在。
- API 在宿主机运行时使用 `localhost` 是正确的。

推荐修复：

healthcheck 同时指定用户和数据库；本地数据库端口考虑绑定 `127.0.0.1`；避免固定 container name，并按需要固定 Redis 小版本。

---

### 6. README 与真实仓库存在多处偏差

文件 / 位置：

- `README.md:7`

问题：

README 声称 Prisma 7、`pnpm dev` 同时启动三端、`pnpm build` 构建全 workspace，但当前都不成立；同时没有说明规范强制的 Expo Router。

影响：

新开发者会得到错误的安装和启动预期。

推荐修复：

在实际修复完成后同步 README，并区分“V1 最终技术栈”“Phase 1 已安装能力”和“后续 Phase 计划”。

---

### 7. 环境文件忽略规则不完整

文件 / 位置：

- `.gitignore:1`

问题：

只忽略 `.env` 和 `.env.local`，未覆盖 `.env.production`、`.env.test` 等常见敏感环境文件。

影响：

后续环境配置可能被误提交。

推荐修复：

使用覆盖 `.env*` 且保留 `.env.example` 的规则。当前 `.env.example` 未发现真实 Secret。

## LOW

### 1. 内部包没有 `exports` 边界

文件 / 位置：

- `packages/shared/package.json:1`
- `packages/config/package.json:1`

问题：

包仅通过 `main`/`types` 暴露入口，没有 `exports`。

影响：

当前可用，但未来容易出现非公开深层导入，且 ESM、类型和 React Native 入口边界不够明确。

推荐修复：

在包接口稳定时增加显式 exports map。

---

### 2. 存在明显仓库残留

文件 / 位置：

- `$null`
- `apps/mobile/.claude/settings.json:1`
- `apps/mobile/App.tsx:7`

问题：

根目录 `$null` 是一段乱码错误输出；Mobile 保留本地 Claude 插件配置和默认模板提示文字。

影响：

不影响运行，但降低仓库卫生和评审可信度。

推荐修复：

确认无用途后清理，并避免提交个人 IDE/Agent 配置。未发现 `AGENTS.md`、`CLAUDE.md` 或 `LICENSE` 缺失会影响运行。

## 审查中的正面结论

- Expo 57.0.15 自带兼容清单要求 React 19.2.3、React Native 0.86.2；当前版本精确匹配。
- Fastify 实际锁定为 5.12.1，`app.ts`/`server.ts` 分离合理。
- `/api/v1/health` 使用真实 Fastify `inject` 测试。
- API 默认绑定 `0.0.0.0`，不存在固定 localhost 导致真机/容器无法访问的问题。
- Workspace 依赖图没有发现循环依赖。
- Worker 明确说明 BullMQ 在 Phase 6 接入，没有假装 Redis/BullMQ 已连接，也没有提前实现 Simulation。
- Prisma schema 没有提前添加 User、Letter 等业务模型。
- 没有发现好友、聊天、Letter API、Journey、地图或 Push 等未授权业务实现。
- `.gitignore` 已覆盖 node_modules、dist、build、coverage、Expo 产物和基础 `.env`。
- 构建产物与 Vitest 缓存显示此前七个测试文件均曾成功，源码中共 11 个 test case，与报告数字一致；但本轮未能复测。

# 总评

```text
FAIL
```

## Phase 1 是否可以视为完成？

```text
NO
```

Expo Router、Prisma 7 和根 `pnpm dev` 三项明确不符合 Phase 1 要求。

## 是否允许进入 Phase 2？

```text
NO
```

必须先修复：

1. 正确初始化 Expo Router。
2. 安装并验证 Prisma 7。
3. 让 `pnpm dev` 确实启动 mobile、api、worker。
4. 修正环境变量加载与 workspace 开发构建链。
5. 在具备 Docker 的环境完成 PostgreSQL/Redis 启动验证。

## Docker 未实际运行验证如何处理？

```text
HIGH
```

静态配置整体合理，因此不是已证实的代码 BLOCKER；但它属于 Phase 1 完成证据缺口，阻止当前阶段获得 PASS，并应在 Phase 2 数据库开发前补齐。

## 最优先需要处理的 3 个问题

1. Expo Router 完全缺失，当前仍是传统 `App.tsx` 入口。
2. Prisma 7 未安装且 schema 配置不符合 Prisma 7 完整要求。
3. 根 `pnpm dev` 不会启动 Mobile，且内部 packages 的开发构建可能使用过期 `dist`。
