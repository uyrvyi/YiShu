import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import { decryptContent } from "../apps/api/dist/lib/crypto.js";

assert.ok(
  process.argv.includes("--approved-revoke-sessions"),
  "Explicit session revocation approval required"
);
const config = loadConfig();
assert.equal(config.NODE_ENV, "production");
assert.equal(config.SIMULATION_CLOCK_OFFSET_MS, 0);
const db = createPrismaClient(config.DATABASE_URL);
try {
  const manifest = JSON.parse(await readFile("/evidence/source.json", "utf8"));
  const evidence = await db.$transaction(
    async (tx) => {
      async function inventory() {
        const entries = [];
        for (const table of manifest.tables) {
          assert.match(table.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
          const [row] = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS checksum FROM "${table.name}" AS t`
          );
          entries.push({ name: table.name, ...row });
        }
        return entries;
      }
      assert.deepEqual(
        await inventory(),
        manifest.tables,
        "Target changed; do not overwrite or finalize blindly"
      );
      const letters = await tx.letter.findMany();
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
      const revoked = await tx.refreshToken.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const tables = await inventory();
      assert.deepEqual(
        tables.filter((row) => row.name !== "RefreshToken"),
        manifest.tables.filter((row) => row.name !== "RefreshToken")
      );
      return {
        status: "TRIAL_CUTOVER_DATA_PASS",
        capturedAt: new Date().toISOString(),
        revokedSessions: revoked.count,
        encryptedLettersVerified: letters.length,
        clockOffsetMs: 0,
        tables,
      };
    },
    { isolationLevel: "Serializable", timeout: 600000 }
  );
  console.log(JSON.stringify(evidence));
} catch {
  console.error("trial_finalization_failed_transaction_rolled_back");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
