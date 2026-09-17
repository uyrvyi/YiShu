import type { PrismaClient } from "@yishu/db";
import { materializeVisibleTimeline, advanceJourneyToNow } from "@yishu/domain";
import { reconcileLetterPush } from "@yishu/domain/push";
import type { SimulationClock } from "@yishu/simulation";
import { PAGE_SIZE, TERMINAL, WAKE_INTERVAL_MS, type Queues } from "./queue.js";

/** Stable state revision identity: retries reuse the key; failed domain jobs stay inspectable. */
export async function scheduleJourney(
  db: PrismaClient,
  queues: Queues,
  journeyId: bigint,
  delay = WAKE_INTERVAL_MS
): Promise<void> {
  const j = await db.journey.findUnique({
    where: { id: journeyId },
    select: { id: true, lastAdvancedAtSim: true, letter: { select: { status: true } } },
  });
  if (!j || TERMINAL.some((s) => s === j.letter.status)) return;
  await queues.journey.add(
    "advance",
    { journeyId: String(j.id) },
    {
      jobId: `j-${j.id}-${j.lastAdvancedAtSim?.getTime() ?? "start"}`,
      delay,
    }
  );
}

export async function processJourney(
  db: PrismaClient,
  queues: Queues,
  clock: SimulationClock,
  journeyId: bigint
): Promise<void> {
  const j = await db.journey.findUnique({
    where: { id: journeyId },
    include: { letter: { select: { status: true } } },
  });
  if (!j) return;
  // Stale terminal jobs must not even advance the terminal audit cursor.
  if (!TERMINAL.some((s) => s === j.letter.status))
    await advanceJourneyToNow(db, j.letterId, clock);
  await materializeVisibleTimeline(db, j.letterId, clock.now());
  await reconcileLetterPush(db, j.letterId, clock.now());
  await scheduleJourney(db, queues, j.id);
}

/** Startup + durable recurring scan repairs crash-after-commit and Redis data loss gaps.
 * Cursor pagination bounds memory. PostgreSQL, never Redis, is the canonical candidate set.
 */
export async function reconcile(
  db: PrismaClient,
  queues: Queues,
  clock: SimulationClock
): Promise<void> {
  let cursor = 0n;
  for (;;) {
    const rows = await db.journey.findMany({
      where: { id: { gt: cursor }, letter: { status: { notIn: [...TERMINAL] } } },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    for (const row of rows) await scheduleJourney(db, queues, row.id, 0);
    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1]?.id ?? cursor;
  }
  cursor = 0n;
  for (;;) {
    // Includes CREATED letters and terminal journeys after a crash before notification materialization.
    const rows = await db.letter.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    for (const row of rows) await reconcileLetterPush(db, row.id, clock.now());
    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1]?.id ?? cursor;
  }
  cursor = 0n;
  for (;;) {
    const rows = await db.pushDispatch.findMany({
      where: { id: { gt: cursor }, status: "PENDING" },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    for (const row of rows)
      await queues.push.add("deliver", { dispatchId: String(row.id) }, { jobId: `p-${row.id}` });
    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1]?.id ?? cursor;
  }
}
