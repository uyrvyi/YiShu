import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { loadConfig, type AppConfig } from "@yishu/config";
import { API_PREFIX } from "@yishu/shared";
import type { PrismaClient } from "@yishu/db";
import { SystemSimulationClock, type SimulationClock } from "@yishu/simulation";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { letterRoutes } from "./routes/letters.js";
import { journeyRoutes } from "./routes/journeys.js";
import { timelineRoutes } from "./routes/timelines.js";
import { mapRoutes } from "./routes/maps.js";
import { pushRoutes } from "./routes/push.js";
import { estimateRoutes } from "./routes/estimates.js";
import { mediaRoutes } from "./routes/media.js";
import { MediaError } from "./lib/media.js";
import { InvalidTransportRegionError } from "./lib/district-transport-validation.js";
import { RegionServiceUnavailableError } from "./lib/service-area.js";
import { encryptionRoutes } from "./routes/encryption.js";

/**
 * buildApp 所需依赖（便于测试注入）。
 */
export interface AppDeps {
  /** PostgreSQL Prisma Client 实例。 */
  prisma: PrismaClient;
  /**
   * 模拟时钟（Phase 7：Timeline 可见性判定）。
   * 生产/默认：SystemSimulationClock(speed = 1)；测试可注入 TestSimulationClock 控制时间。
   */
  simulationClock?: SimulationClock;
  /** 生产环境共享的限流 Redis；测试可省略并使用实例内存计数。 */
  rateLimitRedis?: Redis;
  /** 仅供独立限流测试覆盖，普通测试避免共享 IP 额度互相干扰。 */
  enableRateLimits?: boolean;
  /** Isolated namespace for shared Redis integration tests. */
  rateLimitNamespace?: string;
  /** Capturable logger destination for privacy regression tests. */
  loggerStream?: { write: (message: string) => void };
  readinessCheck?: () => Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    config: AppConfig;
    /** 统一业务时钟：simulationClock.now()（禁止业务直接 Date.now()）。 */
    simulationClock: SimulationClock;
    /** 校验 Authorization Bearer JWT，失败返回 401。 */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

/**
 * 构建 Fastify 实例（不含 listen，便于测试与注入）。
 * 配置统一来自 @yishu/config，依赖（如 PrismaClient）由调用方注入。
 */
export function buildApp(
  config: AppConfig = loadConfig(),
  deps: AppDeps
): ReturnType<typeof Fastify> {
  if (
    config.NODE_ENV === "production" &&
    (!deps.rateLimitRedis || deps.enableRateLimits === false)
  ) {
    throw new Error("production_rate_limit_redis_required");
  }
  const app = Fastify({
    trustProxy: config.TRUSTED_PROXY_IP ? [config.TRUSTED_PROXY_IP] : false,
    bodyLimit: 1024 * 1024,
    logger:
      config.NODE_ENV === "test" && !deps.loggerStream
        ? false
        : {
            stream: deps.loggerStream,
            serializers: {
              req: (req: FastifyRequest) => ({
                method: req.method,
                route: req.routeOptions?.url ?? "unmatched",
                remoteAddress: req.ip,
              }),
              err: (error: unknown) => ({
                type: error instanceof Error ? error.name : "UnknownError",
                message: "redacted",
                stack: "",
              }),
            },
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body",
                "req.query",
                "res.headers['set-cookie']",
                "password",
                "passwordHash",
                "accessToken",
                "refreshToken",
                "token",
                "DATABASE_URL",
                "REDIS_URL",
                "JWT_SECRET",
                "CONTENT_ENCRYPTION_KEY",
              ],
              remove: true,
            },
            transport:
              config.NODE_ENV === "development"
                ? {
                    target: "pino-pretty",
                    options: { colorize: true },
                  }
                : undefined,
          },
  });

  void app.register(fastifyJwt, { secret: config.JWT_SECRET });
  if (deps.enableRateLimits ?? config.NODE_ENV !== "test") {
    void app.register(rateLimit, {
      global: false,
      redis: deps.rateLimitRedis,
      skipOnError: false,
      nameSpace: deps.rateLimitNamespace ?? "yishu-auth-limit-",
      errorResponseBuilder: () => ({ statusCode: 429, error: "rate_limited" }),
    });
  }

  // 注入 Prisma Client 与配置，供路由层访问。
  app.decorate("prisma", deps.prisma);
  app.decorate("config", config);
  // 统一模拟时钟（默认生产 speed = 1；测试可注入 TestSimulationClock）
  app.decorate(
    "simulationClock",
    deps.simulationClock ??
      new SystemSimulationClock(1, Date.now(), config.SIMULATION_CLOCK_OFFSET_MS)
  );

  // 认证 preHandler：校验 Bearer JWT，失败返回 401。
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  // 统一安全错误处理：输入错误保留 4xx，其余返回通用 500（不泄漏内部信息）。
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { code?: string }).code;
    if (
      err instanceof MediaError ||
      err instanceof InvalidTransportRegionError ||
      err instanceof RegionServiceUnavailableError
    ) {
      return reply.code(err.statusCode).send({ error: err.code });
    }
    if (code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ error: "image_too_large" });
    }
    if (code === "FST_FILES_LIMIT" || code === "FST_FIELDS_LIMIT" || code === "FST_PARTS_LIMIT") {
      return reply.code(400).send({ error: "one_image_per_upload" });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error" });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "payload_too_large" });
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send({ error: "unsupported_media_type" });
    }
    // malformed JSON / body 解析错误 → 400（稳定、安全的错误）
    if (
      code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      code === "FST_ERR_INVALID_JSON_BODY"
    ) {
      return reply.code(400).send({ error: "validation_error" });
    }
    // Driver errors may embed bound tokens / credentials. Never serialize the raw error.
    app.log.error(
      { errorClass: err instanceof Error ? err.name : "UnknownError" },
      "request_failed"
    );
    return reply.code(500).send({ error: "internal_error" });
  });

  // Fastify's default 404 message includes the raw URL in both logs and response.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  void app.register(healthRoutes, { prefix: API_PREFIX, readinessCheck: deps.readinessCheck });
  void app.register(authRoutes, { prefix: API_PREFIX });
  void app.register(userRoutes, { prefix: API_PREFIX });
  void app.register(letterRoutes, { prefix: API_PREFIX });
  void app.register(journeyRoutes, { prefix: API_PREFIX });
  void app.register(timelineRoutes, { prefix: API_PREFIX });
  void app.register(mapRoutes, { prefix: API_PREFIX });
  void app.register(pushRoutes, { prefix: API_PREFIX });
  void app.register(estimateRoutes, { prefix: API_PREFIX });
  void app.register(mediaRoutes, { prefix: API_PREFIX });
  void app.register(encryptionRoutes, { prefix: API_PREFIX });

  return app;
}
