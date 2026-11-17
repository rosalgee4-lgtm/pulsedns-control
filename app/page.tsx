import { asc, count } from 'drizzle-orm';
import Dashboard from './dashboard';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { nodes, users } from '@/db/schema';
import { listAccounts } from '@/lib/aliyun-accounts';
import { basePath, requirePageUser } from '@/lib/auth';
import { listEvents, listInstances, listNodes } from '@/lib/dashboard-data';
import { listDomains } from '@/lib/domains';
import { pruneEvents } from '@/lib/event-retention';
import { expireProvisionAttempts } from '@/lib/provision-lifecycle';
import { multiUserEnabled } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await ensureSchema();
  const user = await requirePageUser();
  const db = await getDb();
  await expireProvisionAttempts(db, new Date());
  await pruneEvents(db).catch(() => undefined);

  let admin: { multiUserEnabled: boolean; users: Array<{ id: string; username: string; role: string; nodeCount: number; createdAt: string }> } | null = null;
  if (user.role === 'admin') {
    const rows = await db.select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt }).from(users).orderBy(asc(users.createdAt));
    const counts = await db.select({ ownerId: nodes.ownerId, total: count() }).from(nodes).groupBy(nodes.ownerId);
    const byOwner = new Map(counts.map((row) => [row.ownerId, row.total]));
    admin = {
      multiUserEnabled: await multiUserEnabled(db),
      users: rows.map((row) => ({ ...row, nodeCount: byOwner.get(row.id) ?? 0, createdAt: row.createdAt.toISOString() })),
    };
  }

  return <Dashboard
    basePath={basePath()}
    user={{ id: user.id, name: user.username, role: user.role }}
    initialNodes={await listNodes(db, user)}
    initialDomains={await listDomains(db, user)}
    initialAliyun={await listAccounts(db, user)}
    initialEvents={await listEvents(db, user)}
    initialNyanpass={await listInstances(db, user)}
    initialAdmin={admin}
  />;
}
