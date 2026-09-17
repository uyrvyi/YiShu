import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
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
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
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

  // 注入 Prisma Client 与配置，供路由层访问。
  app.decorate("prisma", deps.prisma);
  app.decorate("config", config);
  // 统一模拟时钟（默认生产 speed = 1；测试可注入 TestSimulationClock）
  app.decorate("simulationClock", deps.simulationClock ?? new SystemSimulationClock(1));

  // 认证 preHandler：校验 Bearer JWT，失败返回 401。
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  // 统一安全错误处理：校验/body 解析错误返回 400，其余返回通用 500（不泄漏内部信息）。
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { code?: string }).code;
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error" });
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

  void app.register(healthRoutes, { prefix: API_PREFIX });
  void app.register(authRoutes, { prefix: API_PREFIX });
  void app.register(userRoutes, { prefix: API_PREFIX });
  void app.register(letterRoutes, { prefix: API_PREFIX });
  void app.register(journeyRoutes, { prefix: API_PREFIX });
  void app.register(timelineRoutes, { prefix: API_PREFIX });
  void app.register(mapRoutes, { prefix: API_PREFIX });
  void app.register(pushRoutes, { prefix: API_PREFIX });

  return app;
}
