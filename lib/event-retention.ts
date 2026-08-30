import { desc, lt } from 'drizzle-orm';
import { getDb } from '@/db';
import { events } from '@/db/schema';

const retainedEventCount = 10_000;
const pruneEvery = 100;
const maintenanceIntervalMs = 60 * 60 * 1000;

let lastMaintenanceAt = 0;

export async function pruneEventsAfterInsert(db: Awaited<ReturnType<typeof getDb>>, eventId: number) {
  if (eventId % pruneEvery !== 0) return;
  await pruneEvents(db, Date.now(), true);
}

export async function pruneEvents(db: Awaited<ReturnType<typeof getDb>>, now = Date.now(), force = false) {
  if (!force && now - lastMaintenanceAt < maintenanceIntervalMs) return;
  lastMaintenanceAt = now;
  try {
    const [oldestRetained] = await db.select({ id: events.id }).from(events)
      .orderBy(desc(events.id)).limit(1).offset(retainedEventCount - 1);
    if (!oldestRetained) return;
    await db.delete(events).where(lt(events.id, oldestRetained.id));
  } catch (error) {
    lastMaintenanceAt = 0;
    throw error;
  }
}
