import type { FastifyInstance } from "fastify";

export async function healthRoutes(
  app: FastifyInstance,
  options: { readinessCheck?: () => Promise<void> }
): Promise<void> {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "yishu-api",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });
  app.get("/ready", async (_req, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!options.readinessCheck) throw new Error("readiness_not_configured");
      await Promise.race([
        options.readinessCheck(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("dependency_timeout")), 2000);
        }),
      ]);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    } finally {
      clearTimeout(timer);
    }
  });
}
