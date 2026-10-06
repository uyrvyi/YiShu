import type { PrismaClient } from "@yishu/db";
import type { SimulationClock } from "@yishu/simulation";
import { advanceJourneyWithinTransaction } from "@yishu/domain";
import { resolveStationForRegion } from "./stationGraph.js";
import { assertDistrictTransportRegion } from "./district-transport-validation.js";
import { createJourneyWithinTransaction } from "./journey.js";

interface ProfileUpdate {
  nickname?: string;
  region?: { province: string; city: string; district: string };
}
const terminal = new Set(["DELIVERED", "PERMANENTLY_LOST", "DESTROYED"]);

export async function updateProfile(
  prisma: PrismaClient,
  uid: string,
  input: ProfileUpdate,
  clock: SimulationClock
) {
  const user = await prisma.user.findUnique({ where: { uid } });
  if (!user) return null;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`profile:${user.id}`}, 0))`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      const region = input.region;
      const regionChanged =
        region &&
        (region.province !== current.province ||
          region.city !== current.city ||
          region.district !== current.district);
      if (regionChanged) {
        const now = clock.now();
        const fixedClock = { now: () => now } as SimulationClock;
        const letters = await tx.letter.findMany({
          where: {
            recipientId: current.id,
            status: { notIn: ["DELIVERED", "PERMANENTLY_LOST", "DESTROYED"] },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        for (const candidate of letters) {
          let journey = await tx.journey.findUnique({ where: { letterId: candidate.id } });
          if (!journey) {
            const original = await tx.letter.findUniqueOrThrow({ where: { id: candidate.id } });
            // Freeze and advance the original address before recording a 1.1 destination edit.
            if (original.rulesVersion === "1.1" && original.status === "CREATED")
              journey = (await createJourneyWithinTransaction(tx, original)).journey;
          }
          // Catch up old transport before enqueueing the new destination. Lock order is Journey -> Letter.
          if (journey) await advanceJourneyWithinTransaction(tx, candidate.id, fixedClock);
          const letter = await tx.letter.findUniqueOrThrow({ where: { id: candidate.id } });
          if (terminal.has(letter.status)) continue;
          if (letter.rulesVersion === "1.1")
            assertDistrictTransportRegion(region, letter.graphVersion, "destination");
          const destinationNodeId = resolveStationForRegion(region, letter.graphVersion);
          if (journey) {
            const updated = await tx.journey.findUniqueOrThrow({ where: { id: journey.id } });
            await tx.destinationChange.updateMany({
              where: { journeyId: journey.id, status: "PENDING" },
              data: { status: "SUPERSEDED" },
            });
            await tx.destinationChange.create({
              data: {
                journeyId: journey.id,
                requestedAtSim: new Date(
                  Math.max(now, updated.lastAdvancedAtSim?.getTime() ?? now)
                ),
                destinationNodeId,
                targetProvince: region.province,
                targetCity: region.city,
                targetDistrict: region.district,
                previousTargetProvince: letter.targetProvince,
                previousTargetCity: letter.targetCity,
                previousTargetDistrict: letter.targetDistrict,
              },
            });
          }
          await tx.letter.update({
            where: { id: letter.id },
            data: {
              targetProvince: region.province,
              targetCity: region.city,
              targetDistrict: region.district,
            },
          });
          // At a station (including last-mile delivery), apply now. An active leg keeps its original next station.
          if (journey) await advanceJourneyWithinTransaction(tx, candidate.id, fixedClock, true);
        }
      }
      return tx.user.update({
        where: { id: current.id },
        data: {
          ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
          ...(region
            ? { province: region.province, city: region.city, district: region.district }
            : {}),
        },
      });
    },
    { timeout: 30000 }
  );
}
