import assert from "node:assert/strict";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import { decryptContent } from "../apps/api/dist/lib/crypto.js";

const database = process.argv[2];
assert.match(database ?? "", /^yishu_restore_check_[0-9_]+$/);
const config = loadConfig();
const restoredUrl = new URL(config.DATABASE_URL);
restoredUrl.pathname = `/${database}`;
const source = createPrismaClient(config.DATABASE_URL);
const restored = createPrismaClient(restoredUrl.toString());
try {
  const tables =
    await source.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  for (const { tablename } of tables) {
    assert.match(tablename, /^[A-Za-z_][A-Za-z0-9_]*$/);
    const sql = `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS checksum FROM "${tablename}" AS t`;
    assert.deepEqual(
      await restored.$queryRawUnsafe(sql),
      await source.$queryRawUnsafe(sql),
      `restore mismatch: ${tablename}`
    );
  }
  const letters = await restored.letter.findMany();
  for (const letter of letters) {
    decryptContent(
      { ciphertext: letter.encryptedContent, iv: letter.contentIv, authTag: letter.contentAuthTag },
      config.CONTENT_ENCRYPTION_KEY
    );
  }
  console.log(
    JSON.stringify({
      status: "RESTORE_CHECK_PASS",
      tables: tables.length,
      encryptedLettersVerified: letters.length,
    })
  );
} catch {
  console.error("restore_check_failed");
  process.exitCode = 1;
} finally {
  await Promise.all([source.$disconnect(), restored.$disconnect()]);
}
