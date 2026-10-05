import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { loadConfig, requireTestDatabaseUrl } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";

async function main() {
  const config = loadConfig();
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const entries = await readdir(directory, { withFileTypes: true });
  const canonical = new Map();
  for (const entry of entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await readFile(new URL(`${entry.name}/migration.sql`, directory));
    canonical.set(entry.name, createHash("sha256").update(content).digest("hex"));
  }
  if (canonical.size === 0) throw new Error("missing_migration_history");

  const databases = [];
  // Read-only checks; neither migrations nor business data are changed.
  for (const [name, url] of [
    ["development", config.DATABASE_URL],
    ["test", requireTestDatabaseUrl(process.env)],
  ]) {
    const prisma = createPrismaClient(url);
    try {
      const rows = await prisma.$queryRaw`
        SELECT migration_name, checksum, finished_at, rolled_back_at
        FROM "_prisma_migrations" ORDER BY migration_name
      `;
      const drift = rows
        .filter((row) => canonical.get(row.migration_name) !== row.checksum)
        .map((row) => row.migration_name);
      const unfinished = rows.filter(
        (row) => row.finished_at === null && row.rolled_back_at === null
      ).length;
      const rolledBack = rows.filter((row) => row.rolled_back_at !== null).length;
      const applied = rows.filter((row) => row.finished_at !== null && row.rolled_back_at === null);
      const missing = [...canonical.keys()].filter(
        (migration) => !applied.some((row) => row.migration_name === migration)
      );
      const duplicate = applied.length - new Set(applied.map((row) => row.migration_name)).size;
      databases.push({
        name,
        recorded: rows.length,
        applied: applied.length,
        drift,
        unfinished,
        rolledBack,
        missing,
        duplicate,
        pass:
          rows.length === canonical.size &&
          drift.length === 0 &&
          unfinished === 0 &&
          rolledBack === 0 &&
          missing.length === 0 &&
          duplicate === 0,
      });
    } finally {
      await prisma.$disconnect();
    }
  }
  const pass = databases.every((database) => database.pass);
  console.log(
    JSON.stringify({ status: pass ? "PASS" : "FAIL", disk: canonical.size, databases }, null, 2)
  );
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error("migration_check_failed", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
