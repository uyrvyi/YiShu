import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseEnv = {
  ...process.env,
  APP_POSTGRES_PASSWORD: "compose-parse-only",
  POSTGRES_PASSWORD: "compose-parse-only",
  REDIS_PASSWORD: "compose-parse-only",
  JWT_SECRET: "compose-parse-only",
  CONTENT_ENCRYPTION_KEY: "compose-parse-only",
  RELEASE_TAG: "compose-parse-only",
  CLOUD_PUBLIC_IP: "192.0.2.71",
};

function render(version) {
  const env = { ...baseEnv };
  delete env.NEW_LETTER_RULES_VERSION;
  if (version !== undefined) env.NEW_LETTER_RULES_VERSION = version;
  return JSON.parse(execFileSync("docker", [
    "compose", "--env-file", "/dev/null", "--profile", "delivery",
    "-f", "docker-compose.prod.yml",
    "-f", "docker-compose.import.yml",
    "-f", "docker-compose.cloud.yml",
    "config", "--format", "json",
  ], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

test("cloud defaults to legacy rules without starting or changing services", () => {
  const config = render();
  assert.equal(config.services.api.environment.NEW_LETTER_RULES_VERSION, "1.0");
  assert.equal(config.services.worker.environment.NEW_LETTER_RULES_VERSION, undefined);
  for (const name of ["api", "worker", "postgres", "redis"]) {
    assert.equal(config.services[name].ports, undefined);
  }
  assert.deepEqual(config.services.caddy.ports.map((p) => [p.published, p.target, p.protocol]),
    [["443", 443, "tcp"]]);
});

test("explicit 1.0 keeps the complete rendered configuration unchanged", () => {
  assert.deepEqual(render("1.0"), render());
});

test("explicit 1.1 changes only the API creation rule switch", () => {
  const legacy = render("1.0");
  const next = render("1.1");
  assert.equal(next.services.api.environment.NEW_LETTER_RULES_VERSION, "1.1");
  next.services.api.environment.NEW_LETTER_RULES_VERSION = "1.0";
  assert.deepEqual(next, legacy);
});
