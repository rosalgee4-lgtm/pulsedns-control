import { and, eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { domains, nodes, nodeShares, nyanpassInstances } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';

// 多用户：普通用户只能管理自己的节点；管理员可以管理全部。
// 不属于当前用户的节点一律按「不存在」处理，不泄露其他用户的数据。
export async function canAccessNode(db: AppDb, user: CurrentUser, nodeId: string) {
  const [node] = await db.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return Boolean(node && (user.role === 'admin' || node.ownerId === user.id));
}

// 机器分享：当前用户是否被分享了这台机器。
export async function isSharedWith(db: AppDb, userId: string, nodeId: string) {
  const [share] = await db.select({ nodeId: nodeShares.nodeId }).from(nodeShares)
    .where(and(eq(nodeShares.nodeId, nodeId), eq(nodeShares.userId, userId))).limit(1);
  return Boolean(share);
}

// 能否使用这台机器（查看、添加自己的实例）：管理员、所属用户，或被分享的用户。
export async function canUseNode(db: AppDb, user: CurrentUser, nodeId: string) {
  return await canAccessNode(db, user, nodeId) || (await nodeExists(db, nodeId) && await isSharedWith(db, user.id, nodeId));
}

async function nodeExists(db: AppDb, nodeId: string) {
  const [node] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return Boolean(node);
}

// Nyanpass 实例只能由添加它的用户（或管理员）修改、同步和移除。返回实例所在节点，无权时返回 null。
export async function modifiableInstanceNode(db: AppDb, user: CurrentUser, instanceId: string) {
  const [instance] = await db.select({ nodeId: nyanpassInstances.nodeId, ownerId: nyanpassInstances.ownerId })
    .from(nyanpassInstances).where(eq(nyanpassInstances.id, instanceId)).limit(1);
  if (!instance) return null;
  if (user.role === 'admin' || instance.ownerId === user.id) return { nodeId: instance.nodeId };
  return null;
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
