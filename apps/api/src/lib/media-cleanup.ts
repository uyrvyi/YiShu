import type { PrismaClient } from "@yishu/db";
import { removeMediaFile, STAGED_MEDIA_TTL_MS } from "./media.js";

export async function cleanupExpiredMedia(
  prisma: PrismaClient,
  directory: string,
  now = Date.now()
) {
  const cutoff = new Date(now - STAGED_MEDIA_TTL_MS);
  const expired = { letterId: null, avatarFor: { is: null }, createdAt: { lte: cutoff } } as const;
  const candidates = await prisma.mediaAsset.findMany({
    where: expired,
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, ownerId: true },
  });
  let removed = 0;
  for (const asset of candidates) {
    removed += await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:${asset.ownerId}`}, 0))`;
      const where = { id: asset.id, ownerId: asset.ownerId, ...expired };
      if (!(await tx.mediaAsset.findFirst({ where, select: { id: true } }))) return 0;
      // Keep expired metadata on file errors so the next scheduled batch retries it.
      await removeMediaFile(directory, asset.id);
      return (await tx.mediaAsset.deleteMany({ where })).count;
    });
  }
  return removed;
}

export function startMediaCleanup(run: () => Promise<unknown>, onError: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const tick = async () => {
    try {
      await run();
    } catch {
      onError();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          pending = tick();
        }, 60_000);
        timer.unref();
      }
    }
  };
  pending = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
