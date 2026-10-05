import { spawnSync } from "node:child_process";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";

async function main() {
  const config = loadConfig();
  const password = process.env.APP_POSTGRES_PASSWORD;
  if (!/^[0-9a-f]{64}$/.test(password ?? "")) throw new Error("app_password_invalid");
  const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("migration_failed");
  const db = createPrismaClient(config.DATABASE_URL);
  try {
    const roles =
      await db.$queryRaw`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'yishu_app'`;
    if (roles.length === 0) {
      const [statement] =
        await db.$queryRaw`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'yishu_app', ${password}::text) AS sql`;
      await db.$executeRawUnsafe(statement.sql);
    } else if (Object.values(roles[0]).some(Boolean)) {
      throw new Error("runtime_role_overprivileged");
    }
    await db.$executeRawUnsafe('GRANT CONNECT ON DATABASE "yishu" TO yishu_app');
    await db.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO yishu_app");
    await db.$executeRawUnsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yishu_app"
    );
    await db.$executeRawUnsafe(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yishu_app"
    );
    await db.$executeRawUnsafe('REVOKE ALL ON TABLE "_prisma_migrations" FROM yishu_app');
    await db.$executeRawUnsafe('GRANT SELECT ON TABLE "_prisma_migrations" TO yishu_app');
    console.log("migration_and_runtime_grants_ready");
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error("migration_or_runtime_grants_failed");
  process.exitCode = 1;
});
