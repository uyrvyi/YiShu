import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";

const db = createPrismaClient(loadConfig().DATABASE_URL);
try {
  const manifest = JSON.parse(await readFile(".local/production/source.json", "utf8"));
  const changed = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const names =
        await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      assert.deepEqual(
        names.map((row) => row.tablename),
        manifest.tables.map((row) => row.name)
      );
      const result = [];
      for (const table of manifest.tables) {
        assert.match(table.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        const [row] = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS checksum FROM "${table.name}" AS t`
        );
        if (row.count !== table.count || row.checksum !== table.checksum) result.push(table.name);
      }
      return result;
    },
    { isolationLevel: "RepeatableRead", timeout: 600000 }
  );
  console.log(
    JSON.stringify({
      status: changed.length ? "FINAL_SOURCE_CHANGED" : "FINAL_SOURCE_MATCH_PASS",
      changedTables: changed,
    })
  );
  process.exitCode = changed.length ? 1 : 0;
} catch {
  console.error("final_source_check_failed");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
