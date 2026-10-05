import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import {
  requireTestDatabaseUrl,
  DEFAULT_CONTENT_ENCRYPTION_KEY,
} from "../packages/config/dist/index.js";
import { readEncryptedMedia, inspectImage } from "../apps/api/dist/lib/media.js";

const url = new URL(requireTestDatabaseUrl(process.env));
assert.equal(url.hostname, "postgres");
assert.equal(url.pathname, "/yishu_test");
const source = createPrismaClient(url.toString());
url.pathname = "/yishu_media_restore_test";
const restored = createPrismaClient(url.toString());
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
  const assets = await restored.mediaAsset.findMany();
  assert.ok(assets.length > 0, "empty media backup cannot verify restoration");
  for (const asset of assets) {
    const original = await readFile(`/runtime-media/${asset.id}.enc`);
    const copied = await readFile(`/restore-media/${asset.id}.enc`);
    assert.ok(original.equals(copied), "encrypted archive mismatch");
    const pixels = await readEncryptedMedia(
      "/restore-media",
      asset.id,
      DEFAULT_CONTENT_ENCRYPTION_KEY
    );
    assert.equal(pixels.length, asset.byteSize);
    assert.deepEqual(await inspectImage(pixels), {
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    });
  }
  console.log(
    JSON.stringify({
      status: "NEXT_VERSION_DATABASE_AND_MEDIA_RESTORE_PASS",
      tables: tables.length,
      encryptedAssets: assets.length,
    })
  );
} finally {
  await source.$disconnect();
  await restored.$disconnect();
}
