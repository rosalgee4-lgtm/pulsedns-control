import { asc, eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { domains, users } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';

// 管理员看到全部主域名（并显示所属用户），普通用户只看到自己的。
export async function listDomains(db: AppDb, user: CurrentUser) {
  const query = db.select({ name: domains.name, ownerId: domains.ownerId, ownerName: users.username, accountId: domains.accountId, createdAt: domains.createdAt })
    .from(domains).innerJoin(users, eq(domains.ownerId, users.id));
  const rows = await (user.role === 'admin' ? query : query.where(eq(domains.ownerId, user.id))).orderBy(asc(domains.name));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
