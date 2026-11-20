import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { agentTasks, events, nodeDnsRecords, nodes, nodeShares, nyanpassInstances, users } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';
import { nodeResponse } from '@/lib/node-response';

// 控制台数据：管理员看到全部，普通用户看到自己的节点和分享给自己的机器上的数据。

function ownedBy(db: AppDb, user: CurrentUser) {
  if (user.role === 'admin') return undefined;
  const sharedNodeIds = db.select({ nodeId: nodeShares.nodeId }).from(nodeShares).where(eq(nodeShares.userId, user.id));
  return or(eq(nodes.ownerId, user.id), inArray(nodes.id, sharedNodeIds));
}

export async function listNodes(db: AppDb, user: CurrentUser) {
  const rows = await db.select({ node: nodes, ownerName: users.username }).from(nodes)
    .innerJoin(users, eq(nodes.ownerId, users.id)).where(ownedBy(db, user)).orderBy(desc(nodes.createdAt));
  // 管理员看到每台机器分享给了谁；被分享的用户只知道这台机器是共享给自己的。
  const shares = user.role === 'admin' && rows.length
    ? await db.select({ nodeId: nodeShares.nodeId, userId: nodeShares.userId, username: users.username })
      .from(nodeShares).innerJoin(users, eq(nodeShares.userId, users.id)).orderBy(asc(users.username))
    : [];
  return rows.map(({ node, ownerName }) => ({
    ...nodeResponse(node),
    ownerName,
    sharedWithMe: user.role !== 'admin' && node.ownerId !== user.id,
    sharedWith: shares.filter((share) => share.nodeId === node.id).map(({ userId, username }) => ({ userId, username })),
  }));
}

// 共享机器上被分享用户添加的解析。
export async function listDnsRecords(db: AppDb, user: CurrentUser) {
  const rows = await db.select({
    id: nodeDnsRecords.id,
    nodeId: nodeDnsRecords.nodeId,
    nodeName: nodes.name,
    ownerId: nodeDnsRecords.ownerId,
    ownerName: users.username,
    domainName: nodeDnsRecords.domainName,
    recordV4: nodeDnsRecords.recordV4,
    recordV6: nodeDnsRecords.recordV6,
    assignedBy: nodeDnsRecords.assignedBy,
    createdAt: nodeDnsRecords.createdAt,
  }).from(nodeDnsRecords)
    .innerJoin(nodes, eq(nodeDnsRecords.nodeId, nodes.id))
    .innerJoin(users, eq(nodeDnsRecords.ownerId, users.id))
    .where(ownedBy(db, user))
    .orderBy(asc(nodes.name), asc(nodeDnsRecords.createdAt));
  return rows.map(({ assignedBy, ...record }) => ({ ...record, assigned: Boolean(assignedBy), createdAt: record.createdAt.toISOString() }));
}

export async function listInstances(db: AppDb, user: CurrentUser) {
  const rows = await db.select({
    id: nyanpassInstances.id,
    nodeId: nyanpassInstances.nodeId,
    nodeName: nodes.name,
    ownerId: nyanpassInstances.ownerId,
    ownerName: users.username,
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
    .innerJoin(users, eq(nyanpassInstances.ownerId, users.id))
    .leftJoin(agentTasks, eq(nyanpassInstances.activeTaskId, agentTasks.id))
    .where(ownedBy(db, user))
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
    .where(and(ownedBy(db, user), beforeId === undefined ? undefined : lt(events.id, beforeId)))
    .orderBy(desc(events.id)).limit(limit);
  return rows.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() }));
}

export function instanceResponse(instance: {
  id: string;
  nodeId: string;
  nodeName: string | null;
  ownerId: string;
  ownerName?: string | null;
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
