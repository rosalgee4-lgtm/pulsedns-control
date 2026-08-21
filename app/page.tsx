import { desc, eq } from 'drizzle-orm';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import Dashboard from './dashboard';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes, nyanpassInstances } from '@/db/schema';

export const dynamic = 'force-dynamic';

export default function Home() {
  return <AuthenticatedDashboard />;
}

async function AuthenticatedDashboard() {
  const user = await requireChatGPTUser('/');
  await ensureSchema();
  const db = await getDb();
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
  }).from(nyanpassInstances).leftJoin(nodes, eq(nyanpassInstances.nodeId, nodes.id)).orderBy(desc(nyanpassInstances.createdAt));

  return <Dashboard
    user={{ name: user.displayName, email: user.email }}
    initialNodes={nodeRows.map((node) => ({ ...node, lastSeenAt: node.lastSeenAt?.toISOString() ?? null, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() }))}
    initialEvents={eventRows.map((event) => ({ ...event, createdAt: event.createdAt.toISOString(), nodeName: event.nodeName ?? '已删除节点' }))}
    initialNyanpass={nyanpassRows.map((instance) => ({ ...instance, nodeName: instance.nodeName ?? '已删除节点' }))}
  />;
}
