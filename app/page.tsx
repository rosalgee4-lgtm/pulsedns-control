import { desc, eq } from 'drizzle-orm';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import Dashboard from './dashboard';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { nodeResponse } from '@/lib/node-response';
import { expireProvisionAttempts } from '@/lib/provision-lifecycle';
import { pruneEvents } from '@/lib/event-retention';

export const dynamic = 'force-dynamic';

export default function Home() {
  return <AuthenticatedDashboard />;
}

async function AuthenticatedDashboard() {
  const user = await requireChatGPTUser('/');
  const configuredBasePath = process.env.PULSEDNS_BASE_PATH?.trim() ?? '';
  const basePath = /^\/[a-f0-9]{32}$/.test(configuredBasePath) ? configuredBasePath : '';
  await ensureSchema();
  const db = await getDb();
  await expireProvisionAttempts(db, new Date());
  await pruneEvents(db).catch(() => undefined);
  const nodeRows = await db.select().from(nodes).orderBy(desc(nodes.createdAt));
  const eventRows = await db.select({
    id: events.id,
    nodeId: events.nodeId,
    nodeName: nodes.name,
    level: events.level,
    kind: events.kind,
    message: events.message,
    createdAt: events.createdAt,
  }).from(events).leftJoin(nodes, eq(events.nodeId, nodes.id)).orderBy(desc(events.createdAt)).limit(100);
  const nyanpassRows = await db.select({
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
    .leftJoin(nodes, eq(nyanpassInstances.nodeId, nodes.id))
    .leftJoin(agentTasks, eq(nyanpassInstances.activeTaskId, agentTasks.id))
    .orderBy(desc(nyanpassInstances.createdAt));

  return <Dashboard
    basePath={basePath}
    user={{ name: user.displayName, email: user.email }}
    initialNodes={nodeRows.map(nodeResponse)}
    initialEvents={eventRows.map((event) => ({ ...event, createdAt: event.createdAt.toISOString(), nodeName: event.nodeName ?? '已删除节点' }))}
    initialNyanpass={nyanpassRows.map((instance) => ({
      id: instance.id,
      nodeId: instance.nodeId,
      nodeName: instance.nodeName ?? '已删除节点',
      name: instance.name,
      role: instance.role,
      panelUrl: instance.panelUrl,
      optimize: instance.optimize,
      status: instance.status,
      hasCredential: Boolean(instance.credentialCiphertext),
      syncError: instance.syncError,
      activeTaskId: instance.activeTaskId,
      configRevision: instance.configRevision,
      taskStatus: instance.taskStatus,
      lastReportedAt: instance.lastReportedAt?.toISOString() ?? null,
      taskCreatedAt: instance.taskCreatedAt?.toISOString() ?? null,
      taskClaimedAt: instance.taskClaimedAt?.toISOString() ?? null,
      taskLeaseExpiresAt: instance.taskLeaseExpiresAt?.toISOString() ?? null,
    }))}
  />;
}
