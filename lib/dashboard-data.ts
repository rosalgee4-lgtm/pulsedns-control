import { and, desc, eq, lt } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { agentTasks, events, nodes, nyanpassInstances, users } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';
import { nodeResponse } from '@/lib/node-response';

// 控制台数据：管理员看到全部，普通用户只看到自己节点上的数据。

function ownedBy(user: CurrentUser) {
  return user.role === 'admin' ? undefined : eq(nodes.ownerId, user.id);
}

export async function listNodes(db: AppDb, user: CurrentUser) {
  const rows = await db.select({ node: nodes, ownerName: users.username }).from(nodes)
    .innerJoin(users, eq(nodes.ownerId, users.id)).where(ownedBy(user)).orderBy(desc(nodes.createdAt));
  return rows.map(({ node, ownerName }) => ({ ...nodeResponse(node), ownerName }));
}

export async function listInstances(db: AppDb, user: CurrentUser) {
  const rows = await db.select({
    id: nyanpassInstances.id,
    nodeId: nyanpassInstances.nodeId,
    nodeName: nodes.name,
    name: nyanpassInstances.name,
    role: nyanpassInstances.role,
    panelUrl: nyanpassInstances.panelUrl,
    optimize: nyanpassInstances.optimize,
    status: nyanpassInstances.status,
    lastReportedAt: nyanpassInstances.lastReportedAt,
    syncError: nyanpassInstances.syncError,
    activeTaskId: nyanpassInstances.activeTaskId,
    configRevision: nyanpassInstances.configRevision,
    credentialCiphertext: nyanpassInstances.credentialCiphertext,
    taskStatus: agentTasks.status,
    taskCreatedAt: agentTasks.updatedAt,
    taskClaimedAt: agentTasks.claimedAt,
    taskLeaseExpiresAt: agentTasks.leaseExpiresAt,
  }).from(nyanpassInstances)
    .innerJoin(nodes, eq(nyanpassInstances.nodeId, nodes.id))
    .leftJoin(agentTasks, eq(nyanpassInstances.activeTaskId, agentTasks.id))
    .where(ownedBy(user))
    .orderBy(desc(nyanpassInstances.createdAt));
  return rows.map(instanceResponse);
}

export const EVENT_PAGE_SIZE = 100;

// 事件按 id 倒序（即写入顺序）分页：beforeId 为空时取最新一页，否则取比它更早的一页。
export async function listEvents(db: AppDb, user: CurrentUser, limit = EVENT_PAGE_SIZE, beforeId?: number) {
  const rows = await db.select({
    id: events.id,
    nodeId: events.nodeId,
    nodeName: nodes.name,
    level: events.level,
    kind: events.kind,
    message: events.message,
    createdAt: events.createdAt,
  }).from(events).innerJoin(nodes, eq(events.nodeId, nodes.id))
    .where(and(ownedBy(user), beforeId === undefined ? undefined : lt(events.id, beforeId)))
    .orderBy(desc(events.id)).limit(limit);
  return rows.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() }));
}

export function instanceResponse(instance: {
  id: string;
  nodeId: string;
  nodeName: string | null;
  name: string;
  role: 'inbound' | 'outbound';
  panelUrl: string;
  optimize: boolean;
  status: typeof nyanpassInstances.$inferSelect['status'];
  lastReportedAt: Date | null;
  syncError: string | null;
  activeTaskId: string | null;
  configRevision: number;
  hasCredential?: boolean;
  credentialCiphertext?: string | null;
  taskStatus: string | null;
  taskCreatedAt: Date | null;
  taskClaimedAt: Date | null;
  taskLeaseExpiresAt: Date | null;
}) {
  const { credentialCiphertext, ...safeInstance } = instance;
  return {
    ...safeInstance,
    hasCredential: instance.hasCredential ?? Boolean(credentialCiphertext),
    nodeName: instance.nodeName ?? '已删除节点',
    lastReportedAt: instance.lastReportedAt?.toISOString() ?? null,
    taskCreatedAt: instance.taskCreatedAt?.toISOString() ?? null,
    taskClaimedAt: instance.taskClaimedAt?.toISOString() ?? null,
    taskLeaseExpiresAt: instance.taskLeaseExpiresAt?.toISOString() ?? null,
  };
}
