import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { domains, nodes } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';

// 多用户：普通用户只能操作自己的节点；管理员可以操作全部。
// 不属于当前用户的节点一律按「不存在」处理，不泄露其他用户的数据。
export async function canAccessNode(db: AppDb, user: CurrentUser, nodeId: string) {
  const [node] = await db.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return Boolean(node && (user.role === 'admin' || node.ownerId === user.id));
}

export async function nodeOwner(db: AppDb, nodeId: string) {
  const [node] = await db.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return node?.ownerId ?? null;
}

// 节点只能使用其所属用户自己的主域名。
export async function domainUsableBy(db: AppDb, ownerId: string, domainName: string) {
  const [domain] = await db.select({ ownerId: domains.ownerId }).from(domains).where(eq(domains.name, domainName)).limit(1);
  return domain?.ownerId === ownerId;
}
