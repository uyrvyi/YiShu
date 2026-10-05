import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@yishu/db";
import { loadConfig } from "@yishu/config";
import { buildApp } from "../app.js";

describe("Phase 12 exact proxy trust", () => {
  it("enables PID 1 reaping for cloud gateway health-check children", () => {
    const compose = readFileSync(
      new URL("../../../../docker-compose.cloud.yml", import.meta.url),
      "utf8"
    );
    expect(compose).toMatch(/^  caddy:\s*\n    init: true\s*$/m);
  });
  it("only advertises TCP-compatible protocols on the TCP-only cloud ingress", () => {
    const config = readFileSync(
      new URL("../../../../deploy/Caddyfile.cloud", import.meta.url),
      "utf8"
    );
    expect(config).toContain("protocols h1 h2");
    expect(config).toContain("header Alt-Svc clear");
    expect(config).not.toContain("protocols h1 h2 h3");
  });
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  it.each([
    ["172.31.231.2", "203.0.113.9"],
    ["172.31.231.3", "172.31.231.3"],
  ])("only accepts forwarded IP from Caddy %s", async (socket, expected) => {
    const app = buildApp(loadConfig({ NODE_ENV: "test", TRUSTED_PROXY_IP: "172.31.231.2" }), {
      prisma: {} as PrismaClient,
    });
    apps.push(app);
    app.get("/test-ip", (req: FastifyRequest) => ({ ip: req.ip }));
    const response = await app.inject({
      url: "/test-ip",
      remoteAddress: socket,
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.json()).toEqual({ ip: expected });
  });
  it.each(["true", "*", "0.0.0.0/0", "127.0.0.1,10.0.0.1"])(
    "rejects blanket proxy setting %s",
    (value) => {
      expect(() => loadConfig({ TRUSTED_PROXY_IP: value })).toThrow();
    }
  );
});
