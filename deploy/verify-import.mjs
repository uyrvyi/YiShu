import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import { decryptContent } from "../apps/api/dist/lib/crypto.js";

const config = loadConfig();
assert.equal(config.NODE_ENV, "production");
const db = createPrismaClient(config.DATABASE_URL);
try {
  const directory = process.argv[2];
  assert.ok(directory, "Evidence directory required");
  const manifest = JSON.parse(await readFile(`${directory}/source.json`, "utf8"));
  const dump = await readFile(`${directory}/source.dump`);
  assert.equal(createHash("sha256").update(dump).digest("hex"), manifest.dumpSha256);
  assert.equal(config.SIMULATION_CLOCK_OFFSET_MS, manifest.targetClockOffsetMs);
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const tables = await tx.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      assert.deepEqual(
        tables.map((row) => row.tablename),
        manifest.tables.map((row) => row.name)
      );
      for (const { name, count, checksum } of manifest.tables) {
        assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        const [entry] = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS checksum FROM "${name}" AS t`
        );
        assert.deepEqual(entry, { count, checksum }, `import mismatch: ${name}`);
      }
      const letters = await tx.letter.findMany();
      assert.equal(letters.length, manifest.encryptedLettersVerified);
      for (const letter of letters) {
        decryptContent(
          {
            ciphertext: letter.encryptedContent,
            iv: letter.contentIv,
            authTag: letter.contentAuthTag,
          },
          config.CONTENT_ENCRYPTION_KEY
        );
      }
      const [role] = await tx.$queryRaw`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`;
      assert.ok(role && Object.values(role).every((value) => value === false));
      const [permissions] = await tx.$queryRaw`
      SELECT has_table_privilege(current_user, '_prisma_migrations', 'SELECT') AS readable,
        has_table_privilege(current_user, '_prisma_migrations', 'UPDATE') AS writable`;
      assert.equal(permissions.readable, true);
      assert.equal(permissions.writable, false);
    },
    { isolationLevel: "RepeatableRead", timeout: 600000 }
  );
  console.log(
    JSON.stringify({
      status: "DEV_DATA_IMPORT_PASS",
      tables: manifest.tables.length,
      encryptedLettersVerified: manifest.encryptedLettersVerified,
      clockOffsetMs: 0,
      runtimeRole: "least-privilege",
      cutover: manifest.cutover,
    })
  );
} catch {
  console.error("dev_data_import_verification_failed");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
