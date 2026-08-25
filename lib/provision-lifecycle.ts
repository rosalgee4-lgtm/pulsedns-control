import { and, eq, lt } from 'drizzle-orm';
import { getDb } from '@/db';
import { events, nodes, nyanpassInstances } from '@/db/schema';

export const bootstrapLockedStatuses = new Set(['awaiting', 'provisioning', 'failed', 'uncertain']);

export function isBootstrapLocked(status: string) {
  return bootstrapLockedStatuses.has(status);
}

export async function expireProvisionAttempts(
  db: Awaited<ReturnType<typeof getDb>>,
  now: Date,
  nodeId?: string,
) {
  const conditions = [
    eq(nodes.nyanpassStatus, 'provisioning'),
    lt(nodes.provisionLeaseExpiresAt, now),
  ];
  if (nodeId) conditions.push(eq(nodes.id, nodeId));
  const expired = await db.select({
    id: nodes.id,
    name: nodes.name,
    generation: nodes.provisionGeneration,
    attemptId: nodes.provisionAttemptId,
    leaseExpiresAt: nodes.provisionLeaseExpiresAt,
  }).from(nodes).where(and(...conditions));

  for (const node of expired) {
    if (!node.attemptId || !node.leaseExpiresAt) continue;
    const transitioned = await db.update(nodes).set({
      nyanpassStatus: 'uncertain',
      updatedAt: now,
    }).where(and(
      eq(nodes.id, node.id),
      eq(nodes.nyanpassStatus, 'provisioning'),
      eq(nodes.provisionGeneration, node.generation),
      eq(nodes.provisionAttemptId, node.attemptId),
      eq(nodes.provisionLeaseExpiresAt, node.leaseExpiresAt),
    )).returning({ id: nodes.id });
    if (!transitioned.length) continue;
    await db.batch([
      db.update(nyanpassInstances).set({
        status: 'uncertain',
        syncError: '开机安装心跳已超时，机器可能发生部分变更；请先核查 VPS',
        updatedAt: now,
      }).where(and(
        eq(nyanpassInstances.nodeId, node.id),
        eq(nyanpassInstances.bootstrapGeneration, node.generation),
        eq(nyanpassInstances.status, 'bootstrap'),
      )),
      db.insert(events).values({
        nodeId: node.id,
        level: 'error',
        kind: 'nyanpass_bootstrap_uncertain',
        message: `节点 ${node.name} 的开机安装心跳已超时，结果未知`,
        createdAt: now,
      }),
    ]);
  }
}
