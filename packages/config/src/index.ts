import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * 驿书 V1 基础设施环境配置加载（Phase 1）。
 *
 * - 由仓库根目录的 `.env` 加载环境变量。
 * - 使用 Zod 统一校验并导出类型安全的配置对象。
 * - API / Worker 通过本包读取配置，禁止各自散落读取 `process.env`。
 * - 业务 / Simulation 相关配置在后续 Phase 引入，不在本阶段冻结。
 */

/** 开发环境默认数据库连接串（仅限 development/test 使用）。 */
export const DEFAULT_DATABASE_URL = "postgresql://yishu:yishu@localhost:5432/yishu?schema=public";

/** 开发环境默认 Redis 连接串（仅限 development/test 使用）。 */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** 开发环境默认 JWT 签名密钥（仅限 development/test 使用）。 */
export const DEFAULT_JWT_SECRET = "yishu-dev-jwt-secret-change-me";

/** 测试专用数据库连接串（默认 yishu_test，仅用于集成测试）。 */
export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://yishu:yishu@localhost:5432/yishu_test?schema=public";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
    // 测试数据库（集成测试专用），须为独立 *_test 库。
    TEST_DATABASE_URL: z.string().default(DEFAULT_TEST_DATABASE_URL),
    REDIS_URL: z.string().default(DEFAULT_REDIS_URL),
    // Access Token（JWT）签名密钥；production 必须显式提供。
    JWT_SECRET: z.string().min(16).default(DEFAULT_JWT_SECRET),
    // Access Token 有效期（秒），默认 15 分钟。
    JWT_EXPIRES_IN_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    // Refresh Token 有效期（天），默认 30 天。
    REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === "production") {
      // production 禁止静默回退到 localhost，必须显式提供 DATABASE_URL / REDIS_URL。
      if (val.DATABASE_URL === DEFAULT_DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL"],
          message: "DATABASE_URL must be explicitly provided when NODE_ENV=production",
        });
      }
      if (val.REDIS_URL === DEFAULT_REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REDIS_URL"],
          message: "REDIS_URL must be explicitly provided when NODE_ENV=production",
        });
      }
      if (val.JWT_SECRET === DEFAULT_JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["JWT_SECRET"],
          message: "JWT_SECRET must be explicitly provided when NODE_ENV=production",
        });
      }
    }
    // 连接串结构校验（使用 URL 解析，验证 protocol / hostname / database）
    if (val.DATABASE_URL) {
      const dbErr = validateDatabaseUrl(val.DATABASE_URL);
      if (dbErr) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: dbErr });
      }
    }
    if (val.REDIS_URL) {
      const redisErr = validateRedisUrl(val.REDIS_URL);
      if (redisErr) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REDIS_URL"], message: redisErr });
      }
    }
  });

/** 校验 PostgreSQL 连接串：protocol 为 postgresql:/postgres:，hostname 存在，database/path 有效。 */
function validateDatabaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "DATABASE_URL must be a valid URL";
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return "DATABASE_URL protocol must be postgresql:// or postgres://";
  }
  if (!parsed.hostname) {
    return "DATABASE_URL must include a hostname";
  }
  // database 即 pathname 去掉前导 `/`，须非空
  const database = parsed.pathname.replace(/^\/+/, "");
  if (!database) {
    return "DATABASE_URL must include a database name in the path";
  }
  return null;
}

/** 校验 Redis 连接串：protocol 为 redis:/rediss:，hostname 存在。 */
function validateRedisUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "REDIS_URL must be a valid URL";
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    return "REDIS_URL protocol must be redis:// or rediss://";
  }
  if (!parsed.hostname) {
    return "REDIS_URL must include a hostname";
  }
  return null;
}

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * 从当前模块位置向上查找仓库根（第一个含 `pnpm-workspace.yaml` 的目录）。
 * 兼容源码（src/index.ts）与编译产物（dist/index.js）两种路径深度。
 */
export function resolveRepoRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

let loaded = false;

/** 从仓库根目录加载 `.env`（幂等，仅执行一次）。显式进程环境优先。 */
function ensureEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  const repoRoot = resolveRepoRoot();
  dotenv.config({ path: path.join(repoRoot, ".env"), override: false });
}

/**
 * 加载并校验配置。
 * @param source 可选环境变量来源，缺省为 `process.env`（已加载根 `.env`）。
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  ensureEnvLoaded();
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment config: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 从 PostgreSQL 连接串中解析数据库名（pathname 去掉前导 `/`）。 */
export function resolveDatabaseName(connectionUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new Error("Invalid connection URL");
  }
  return parsed.pathname.replace(/^\/+/, "").split("?")[0] ?? "";
}

/**
 * 安全获取测试数据库连接串（用于破坏性集成测试）。
 *
 * 安全保护：
 * - 未提供 TEST_DATABASE_URL 时拒绝。
 * - 数据库名不包含 `_test` 时拒绝。
 * - 禁止 fallback 到 DATABASE_URL 后执行破坏性操作。
 *
 * @throws 若测试数据库连接不安全。
 */
export function requireTestDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  ensureEnvLoaded();
  const testUrl = source.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required to run destructive integration tests; refusing to fallback to DATABASE_URL"
    );
  }
  const dbName = resolveDatabaseName(testUrl);
  if (!dbName.includes("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must point to a *_test database; got "${dbName}". Refusing to run destructive tests.`
    );
  }
  return testUrl;
}
