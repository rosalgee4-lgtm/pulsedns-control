import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { nodes } from '@/db/schema';

const lockLifetimeMs = 3 * 60 * 1000;

// The persisted columns retain their original dns_operation_* names for
// migration compatibility, but the lease now serializes every node mutation
// that can race with DNS updates, task delivery, or deletion.
export async function acquireNodeOperationLock(db: Awaited<ReturnType<typeof getDb>>, nodeId: string) {
  const operationId = crypto.randomUUID();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = new Date();
    const changed = await db.update(nodes).set({
      dnsOperationId: operationId,
      dnsOperationExpiresAt: new Date(now.getTime() + lockLifetimeMs),
    }).where(and(
      eq(nodes.id, nodeId),
      or(isNull(nodes.dnsOperationId), isNull(nodes.dnsOperationExpiresAt), lt(nodes.dnsOperationExpiresAt, now)),
    )).returning({ id: nodes.id });
    if (changed.length) return operationId;
    const [existing] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!existing) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function releaseNodeOperationLock(db: Awaited<ReturnType<typeof getDb>>, nodeId: string, operationId: string) {
  await db.update(nodes).set({ dnsOperationId: null, dnsOperationExpiresAt: null }).where(and(
    eq(nodes.id, nodeId),
    eq(nodes.dnsOperationId, operationId),
  ));
}
