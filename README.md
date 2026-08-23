# 驿书 V1 (MVP)

「现代世界 + 古代通信方式」的点对点通信 App。

> 当前阶段：**Phase 2：账号与身份系统**
> 当前状态：Phase 2 implementation complete · Final Gate pending re-review
> 已完成账号/身份能力，尚未实现 Letter / Journey / Simulation / 地图 / Push 等后续业务。

## 技术栈（规划）

| 模块     | 技术                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| Mobile   | React Native / Expo SDK 57 / React Native 0.86 / Expo Router / TypeScript strict |
| Server   | Node.js 24 LTS / Fastify 5 / TypeScript                                          |
| Database | PostgreSQL 17 / Prisma 7                                                         |
| Worker   | Redis / BullMQ                                                                   |
| Test     | Vitest                                                                           |
| 质量     | TypeScript strict / ESLint / Prettier                                            |
| 包管理   | pnpm workspace                                                                   |

## 目录结构

```
yishu/
├─ apps/
│  ├─ mobile/          # Expo Router App（Phase 1 占位首页）
│  ├─ api/             # Fastify API（含 /api/v1/health）
│  └─ worker/          # Simulation Worker 骨架
├─ packages/
│  ├─ shared/          # 共享基础设施（API_PREFIX）
│  ├─ db/              # Prisma PostgreSQL Runtime（API/Worker 共用，正式接受）
│  ├─ simulation/      # 骨架（Phase 5 实现）
│  ├─ routing/         # 骨架（Phase 4 实现）
│  └─ config/          # Zod 环境配置加载 + 根 .env
├─ data/               # 本地静态数据（占位）
├─ prisma/
│  ├─ schema.prisma    # Phase 2 业务模型：User / Block / RefreshToken（后续 Letter/Journey 等待引入）
│  └─ migrations/
├─ prisma.config.ts    # Prisma 7 配置文件
├─ docker-compose.yml  # PostgreSQL 17 + Redis
├─ pnpm-workspace.yaml
└─ package.json
```

## 环境要求

- **Node.js**: `>=24.3.0 <25`（React Native 0.86.2 要求 Node >= 24.3.0；当前使用 24.14.0）
- **pnpm**: `>=11.0.0 <12`（当前使用 11.22.0，见 `packageManager`）
- **Docker**: 用于本地 PostgreSQL / Redis

### TypeScript 版本策略

- **Node 侧**（`packages/*`、`apps/api`、`apps/worker`）：TypeScript 5.x（`tsconfig.base.json` 严格配置）。
- **Mobile**（`apps/mobile`）：TypeScript ~6.0（Expo SDK 57 模板锁定），`tsconfig.json` 继承 `expo/tsconfig.base`。
- `strict` 全局开启；禁止 `any` / `@ts-ignore`。
- `skipLibCheck`：Node 端与 Expo 的依赖类型（如 RN）存在相互不兼容的 `d.ts`，是实际工程兼容需要，故开启（见 `tsconfig.base.json` 注释）。业务代码本身仍接受完整类型检查。

## 安装依赖（含 Prisma Client 自动生成）

```bash
pnpm install
```

`pnpm install` 的 `postinstall` 会自动执行 `prisma generate`，将 Prisma Client 生成到 `generated/prisma`（已 gitignore，不提交）。因此：

- 干净 clone 后只需 `pnpm install`，无需手动 `prisma generate`。
- typecheck / build / test / dev 不因 `generated/` 缺失而失败。
- generate 不依赖真实私密 `.env`（`prisma.config.ts` 提供默认 `DATABASE_URL` 回退）。
- `generated/` 永不提交 Git。

## 环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

支持变量：

```text
NODE_ENV=development
API_PORT=4000
API_HOST=0.0.0.0
DATABASE_URL=postgresql://yishu:yishu@localhost:5432/yishu?schema=public
TEST_DATABASE_URL=postgresql://yishu:yishu@localhost:5432/yishu_test?schema=public
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN_SECONDS=900
REFRESH_TOKEN_DAYS=30
```

- API / Worker 统一通过 `@yishu/config` 的 `loadConfig()` 读取，不散落读取 `process.env`。
- 根 `.env` 由 `@yishu/config` 自动加载。
- **连接串结构校验**（URL 解析）：`DATABASE_URL` 校验 protocol（`postgresql:`/`postgres:`）、hostname、database/path；`REDIS_URL` 校验 protocol（`redis:`/`rediss:`）、hostname。
- **`NODE_ENV=production` 时，`DATABASE_URL`/`REDIS_URL`/`JWT_SECRET` 必须显式提供**，禁止静默回退到 localhost 默认值，否则配置加载抛错。
- **测试数据库隔离**：破坏性集成测试只允许在 `TEST_DATABASE_URL` 指向的 `*_test` 库执行清库。`requireTestDatabaseUrl()` 强制保护——未提供 `TEST_DATABASE_URL` 或数据库名不含 `_test` 时直接拒绝，**禁止 fallback 到开发库**。
- **日志安全**：Worker/API 不输出完整连接串（`DATABASE_URL` / `REDIS_URL`），避免泄露用户名、密码、token。

## 启动基础设施（PostgreSQL + Redis）

```bash
docker compose up -d
```

验证状态（已在当前机器实际执行并通过）：

```text
docker compose config   PASS
docker compose up -d    PASS
PostgreSQL 17 healthy   PASS
Redis 7.4 healthy       PASS
PostgreSQL 连接         PASS（SELECT 1 → ok）
Redis 连接              PASS（redis-cli ping → PONG）
Prisma SELECT 1         PASS（@yishu/db 实际连接）
```

> `docker-compose.yml` 仅运行 PostgreSQL 17 与 Redis（**不容器化** Mobile/API/Worker），端口仅绑定 localhost。

## 开发启动（三端 + 内部包 watch）

```bash
pnpm dev
```

同时启动：

- `mobile`：Expo Router（Metro `http://localhost:8081`）
- `api`：Fastify（`http://localhost:4000`）
- `worker`：Simulation Worker 骨架
- `packages/*`：TypeScript `tsc -w` watch 编译，保证修改共享代码后不读取过期产物

> api/worker 的 dev 使用 Node 24 原生 `--watch`（`node --watch --import tsx`），保证与 `pnpm --parallel` 并行启动兼容。

## 常用脚本

```bash
pnpm dev               # 三端 + packages watch 并行启动
pnpm build             # 全 workspace 构建（TS build；mobile 为 expo export native bundle）
pnpm typecheck         # 先构建 packages，再全 workspace TS 检查
pnpm lint              # 全 workspace ESLint
pnpm test              # 全 workspace Vitest
pnpm format            # Prettier 格式化
pnpm format:check      # Prettier 检查
pnpm prisma:validate   # Prisma schema 校验
pnpm prisma:generate   # 生成 Prisma Client 到 generated/prisma
pnpm prisma:studio     # Prisma Studio
```

### Build 语义说明

- 根 `pnpm build` 的 TypeScript 构建（`packages/*`、`apps/api`、`apps/worker`）与 **Expo / native bundle**（`apps/mobile` 的 `expo export`）是两件事。
- `apps/mobile` 的 `build` 脚本执行 `expo export --platform android`（native bundle 验证），由根 `pnpm build` 通过 `--if-present` 一并触发。
- 单独验证 Mobile bundle：`cd apps/mobile && pnpm build` 或 `npx expo export --platform android`。
- **生产 build 排除测试文件**：`packages/*`、`apps/api`、`apps/worker` 使用 `tsconfig.build.json`（exclude `*.test.*`），生产 `dist` 不含测试产物。

## API 健康检查

```bash
curl http://localhost:4000/api/v1/health
```

返回：

```json
{
  "status": "ok",
  "service": "yishu-api",
  "uptimeSeconds": 1.23,
  "timestamp": "2026-08-21T10:00:00.000Z"
}
```

## Phase 2 API（账号与身份）

认证与用户 API（前缀 `/api/v1`）：

```text
POST   /api/v1/auth/register    # 注册（account/password/nickname/province/city/district）
POST   /api/v1/auth/login       # 登录（account/password → access + refresh token）
POST   /api/v1/auth/refresh     # 用 refresh token 换取新 access token
POST   /api/v1/auth/logout      # 注销（撤销 refresh token）
GET    /api/v1/users/me         # 当前用户（需 Bearer access token）
GET    /api/v1/users/search?q=  # 搜索（account 或 8 位 UID）
POST   /api/v1/users/:uid/block # 拉黑用户（需认证）
```

要点：

- **Account**：4~24 字符（a-z/0-9/_），保存前统一转小写，全局唯一。
- **Password**：8~72 字符，Argon2id 哈希存储，永不明文。
- **UID**：8 位随机数字，首位非 0，全局唯一（碰撞自动重试）。
- **Access Token**：JWT，15 分钟；`sub` 为**对外 UID**（绝不使用 internal id）。**Refresh Token**：随机 opaque token，30 天，数据库只存 SHA-256 哈希。
- **用户搜索**：`GET /users/search?q=` 为**精确认收件人**（完整 account 或完整 8 位 UID），返回**单个**安全用户对象；不存在返回 `404 user_not_found`。不做模糊/多结果搜索。
- **Mobile Token 存储**：Refresh Token 仅存 `expo-secure-store`（`apps/mobile/src/auth/tokenStorage.ts`），禁止 AsyncStorage、禁止日志打印；logout 必须删除。
- **Mobile Auth Service**（`apps/mobile/src/auth/authService.ts`）：最小认证流程——register/login 成功后 `saveRefreshToken()`、refresh 从 `getRefreshToken()` 读取并更新、logout 用 try/finally 确保 `deleteRefreshToken()`。通过注入 `ApiClient` 实现可测试性（mock API + SecureStore 测试）。
- **安全**：响应不暴露 `passwordHash` 与 internal BIGINT `id`；JWT 不含 internal id；日志/错误不泄漏 token 与连接串。

## Prisma

```bash
pnpm prisma:validate    # Prisma schema 校验
pnpm prisma:generate    # 生成 Prisma Client 到 generated/prisma（install 时自动执行）
```

Phase 2 schema 包含业务模型：**User**、**Block**、**RefreshToken**。以下模型属于后续 Phase，尚未实现：Letter、Journey、TransportLeg、WorldEvent、TimelineEvent、RecipientState、SenderState。

## packages/db（已正式接受为 API/Worker 共用数据库基础设施）

`packages/db` 由项目负责人正式接受，作为 API / Worker 共用的数据库基础设施 package。

**职责**：

- 封装 Prisma 7 PostgreSQL driver adapter（`@prisma/adapter-pg` + `pg`）。
- 提供可复用的 Prisma Client 工厂与连接健康检查。
- 生成真正的 JS `dist`，API / Worker 生产 `node dist/*.js` 可直接导入，**不依赖 tsx**。

**关键实现**：

- `schema.prisma` 的 generator 配置 `importFileExtension = "js"` + `moduleFormat = "esm"`，使生成的 TS client 用 `.js` 相对导入，可被 tsc 编译为 Node 可运行的 ESM。
- `packages/db` 的 `build`（tsc）把 `generated/prisma` 编译进自身 `dist`，`main`/`types` 指向 `dist/packages/db/src/index.js`。
- 导出 `createPrismaClient(databaseUrl)` 与 `pingDatabase(databaseUrl)`（`SELECT 1` 连接健康检查）。

**API 真实消费**：`apps/api/src/server.ts` 在生产代码路径 `import { createPrismaClient } from "@yishu/db"`，构造 PostgreSQL adapter + PrismaClient（惰性连接），并在 shutdown 时 `$disconnect`。Worker 同样通过 workspace 依赖 `@yishu/db` 复用。

**运行时测试**：`packages/db` 提供可重复的构造测试（无需 PostgreSQL 在线即可构造 adapter + PrismaClient 并 disconnect）；当 Docker 可用时，`pingDatabase` 可执行真实 `SELECT 1` 连接验证（已在当前机器验证 PASS）。

## 状态与已完成能力

### 已完成（Phase 2：账号与身份系统）

- **User 模型**：BIGINT 自增 id（仅数据库内部）、8 位对外 UID、account（唯一、强制小写）、nickname、province/city/district、createdAt/updatedAt
- **账号注册 / 登录**：account + password，Argon2id 密码哈希，重复 account 明确 409
- **UID**：8 位随机数字，首位非 0，全局唯一（碰撞自动重试，最大 10 次）
- **JWT Access Token**：15 分钟，`sub` 为对外 UID（不泄露 internal id）
- **Refresh Token**：随机 opaque token，30 天，数据库只存 SHA-256 hash；logout 撤销
- **用户 API**：`users/me`、`users/search`（account / 8 位 UID 精准搜索，404 处理）、`users/:uid/block`（Block 模型）
- **TEST_DATABASE_URL 测试隔离**：破坏性集成测试仅允许在 `*_test` 库（requireTestDatabaseUrl 强制）
- **Mobile SecureStore**：`expo-secure-store` 封装（tokenStorage.ts）
- **Mobile AuthService**：`authService.ts`，register/login 保存 Refresh Token、refresh 读取更新、logout try/finally 删除
- **PostgreSQL / Prisma**：User/Block/RefreshToken 模型 + migration + validate/generate
- **Phase 2 测试**：全 workspace 66+ tests（含认证/用户集成测试、JWT sub、malformed JSON、UID 碰撞重试、SecureStore/AuthService）

### 未完成（后续 Phase）

以下业务**尚未实现**：Letter、Journey、TransportLeg、Routing 正式业务、Simulation、地图、Push、BullMQ Worker、TransportType / LetterStatus 等领域类型。

## 当前已知问题

- **评审报告**: 根目录 `Phase1_全仓库技术评审报告.md` 为 Phase 1「首次评审」结论，已标记为**已过期 / STALE**，不作为当前验收依据。
- `generated/`（Prisma 生成产物）已加入 `.gitignore`。
- Mobile 业务 UI 未实现，首页仅为占位。
- Docker 容器（PostgreSQL/Redis）由 `docker compose up -d` 启动，运行验证已通过；停止可执行 `docker compose down`。
