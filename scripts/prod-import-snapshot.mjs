import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { loadConfig } from "../packages/config/dist/index.js";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import { decryptContent } from "../apps/api/dist/lib/crypto.js";

const directory = ".local/production";
const dumpPath = `${directory}/source.dump`;
const config = loadConfig();
assert.equal(config.NODE_ENV, "development", "Run only in the development container");
// Reject development placeholders before preserving the key for production.
loadConfig({
  ...process.env,
  NODE_ENV: "production",
  SIMULATION_CLOCK_OFFSET_MS: "0",
  JWT_SECRET: randomBytes(32).toString("hex"),
  CONTENT_ENCRYPTION_KEY: config.CONTENT_ENCRYPTION_KEY,
});
const db = createPrismaClient(config.DATABASE_URL);
let ownedPartial = false;
let ownedSession = false;
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const name of [
    "local.env",
    "source.dump",
    "source.json",
    "snapshot.id",
    "dump.ready",
    "dump.abort",
  ]) {
    try {
      await stat(`${directory}/${name}`);
      throw new Error("existing_import_evidence_refusing_overwrite");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const partial = await open(`${dumpPath}.partial`, "wx", 0o600);
  ownedPartial = true;
  ownedSession = true;
  let evidence;
  try {
    // The manifest and pg_dump share one exported MVCC snapshot, even if dev keeps running.
    evidence = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const [{ snapshot }] = await tx.$queryRaw`SELECT pg_export_snapshot() AS snapshot`;
        const tables = await tx.$queryRaw`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
        const manifest = [];
        for (const { tablename } of tables) {
          assert.match(tablename, /^[A-Za-z_][A-Za-z0-9_]*$/);
          const [entry] = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS checksum FROM "${tablename}" AS t`
          );
          manifest.push({ name: tablename, ...entry });
        }
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
        assert.match(snapshot, /^[0-9A-F-]+$/);
        const snapshotFile = await open(`${directory}/snapshot.id`, "wx", 0o600);
        try {
          await snapshotFile.writeFile(snapshot);
        } finally {
          await snapshotFile.close();
        }
        // The host wrapper invokes pg_dump inside the PostgreSQL 17 container.
        const deadline = Date.now() + 300000;
        for (;;) {
          if (await stat(`${directory}/dump.abort`).catch(() => null)) {
            throw new Error("source_dump_aborted");
          }
          if (await stat(`${directory}/dump.ready`).catch(() => null)) break;
          assert.ok(Date.now() < deadline, "source_dump_timeout");
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.ok((await partial.stat()).size > 0);
        return {
          capturedAt: new Date().toISOString(),
          sourceClockOffsetMs: config.SIMULATION_CLOCK_OFFSET_MS,
          targetClockOffsetMs: 0,
          encryptedLettersVerified: letters.length,
          tables: manifest,
          cutover: "SNAPSHOT_ONLY_NOT_LIVE_SYNC",
        };
      },
      { isolationLevel: "RepeatableRead", timeout: 600000 }
    );
  } finally {
    await partial.close();
  }
  await rename(`${dumpPath}.partial`, dumpPath);
  ownedPartial = false;
  evidence.dumpSha256 = createHash("sha256")
    .update(await readFile(dumpPath))
    .digest("hex");
  const manifestFile = await open(`${directory}/source.json`, "wx", 0o600);
  try {
    await manifestFile.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await manifestFile.close();
  }
  const envFile = await open(`${directory}/local.env`, "wx", 0o600);
  try {
    const values = [
      `RELEASE_TAG=import-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`,
      ...["POSTGRES_PASSWORD", "APP_POSTGRES_PASSWORD", "REDIS_PASSWORD", "JWT_SECRET"].map(
        (name) => `${name}=${randomBytes(32).toString("hex")}`
      ),
      `CONTENT_ENCRYPTION_KEY=${config.CONTENT_ENCRYPTION_KEY}`,
    ];
    await envFile.writeFile(`${values.join("\n")}\n`);
  } finally {
    await envFile.close();
  }
  console.log(
    JSON.stringify({
      status: "SOURCE_SNAPSHOT_PASS",
      tables: evidence.tables.length,
      encryptedLettersVerified: evidence.encryptedLettersVerified,
      sourceClockOffsetMs: evidence.sourceClockOffsetMs,
    })
  );
} catch {
  console.error("source_snapshot_failed_no_existing_files_overwritten");
  process.exitCode = 1;
} finally {
  if (ownedPartial) await unlink(`${dumpPath}.partial`).catch(() => {});
  if (ownedSession) {
    for (const name of ["snapshot.id", "dump.ready", "dump.abort"]) {
      await unlink(`${directory}/${name}`).catch(() => {});
    }
  }
  await db.$disconnect();
}
