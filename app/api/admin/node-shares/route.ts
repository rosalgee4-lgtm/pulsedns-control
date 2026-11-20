import { and, eq } from 'drizzle-orm';
import { isDuplicateKeyError, type AppDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodeDnsRecords, nodes, nodeShares, nyanpassInstances, users } from '@/db/schema';
import { requireApiUser } from '@/lib/auth';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { removeReinstallInstance } from '@/lib/reinstall-plan';
import { pauseAliDnsRecord } from '@/lib/alidns';
import { dnsLabel } from '@/lib/shared-dns';
import { cleanText } from '@/lib/validation';

// 机器分享：只有管理员可以把机器分享给普通用户或取消分享。
// 被分享的用户可以在机器上添加自己的解析与 Nyanpass 实例，看不到安装命令、开机脚本与 root 密码。

const busyStatuses = ['pending', 'running'];

async function locate(db: AppDb, nodeId: string, userId: string) {
  const [node] = await db.select({ id: nodes.id, name: nodes.name, ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  const [target] = await db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return { node, target };
}

export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const nodeId = cleanText(body?.nodeId, 64);
  const userId = cleanText(body?.userId, 64);
  if (!nodeId || !userId) return Response.json({ error: '请选择机器和要分享的用户' }, { status: 400 });
  const { node, target } = await locate(db, nodeId, userId);
  if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (!target || target.role !== 'user') return Response.json({ error: '只能分享给普通用户' }, { status: 400 });
  if (target.id === node.ownerId) return Response.json({ error: '该用户已经是这台机器的所属用户' }, { status: 409 });
  const now = new Date();
  try {
    await db.insert(nodeShares).values({ nodeId, userId, createdAt: now });
  } catch (error) {
    if (isDuplicateKeyError(error)) return Response.json({ error: `已经分享给 ${target.username}` }, { status: 409 });
    throw error;
  }
  await db.insert(events).values({ nodeId, kind: 'node_shared', message: `${user.username} 把机器 ${node.name} 分享给了 ${target.username}`, createdAt: now });
  return Response.json({ share: { nodeId, userId, username: target.username } }, { status: 201 });
}

// 取消分享时一并移除该用户在这台机器上的 Nyanpass 实例登记（并从换机重装清单中去掉）和解析：
// 解析停止同步，并在阿里云上把对应记录设为暂停（不删除）。不会卸载当前机器上已经安装的服务。
export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const searchParams = new URL(request.url).searchParams;
  const nodeId = cleanText(searchParams.get('nodeId'), 64);
  const userId = cleanText(searchParams.get('userId'), 64);
  if (!nodeId || !userId) return Response.json({ error: '缺少机器或用户' }, { status: 400 });
  const { node, target } = await locate(db, nodeId, userId);
  if (!node || !target) return Response.json({ error: '分享不存在' }, { status: 404 });

  const operationId = await acquireNodeOperationLock(db, nodeId);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    const outcome = await db.transaction(async (tx) => {
      const [share] = await tx.select({ nodeId: nodeShares.nodeId }).from(nodeShares)
        .where(and(eq(nodeShares.nodeId, nodeId), eq(nodeShares.userId, userId))).for('update');
      if (!share) return { error: '分享不存在', status: 404 } as const;
      const owned = await tx.select({ name: nyanpassInstances.name, status: nyanpassInstances.status }).from(nyanpassInstances)
        .where(and(eq(nyanpassInstances.nodeId, nodeId), eq(nyanpassInstances.ownerId, userId))).for('update');
      const busy = owned.find((instance) => busyStatuses.includes(instance.status));
      if (busy) return { error: `${target.username} 的实例 ${busy.name} 正在等待或执行同步，请等它结束（或先取消排队）后再取消分享`, status: 409 } as const;
      const records = await tx.select({ id: nodeDnsRecords.id, domainName: nodeDnsRecords.domainName, recordV4: nodeDnsRecords.recordV4, recordV6: nodeDnsRecords.recordV6 }).from(nodeDnsRecords)
        .where(and(eq(nodeDnsRecords.nodeId, nodeId), eq(nodeDnsRecords.ownerId, userId)));
      await tx.delete(nyanpassInstances).where(and(eq(nyanpassInstances.nodeId, nodeId), eq(nyanpassInstances.ownerId, userId)));
      await tx.delete(nodeDnsRecords).where(and(eq(nodeDnsRecords.nodeId, nodeId), eq(nodeDnsRecords.ownerId, userId)));
      await tx.delete(nodeShares).where(and(eq(nodeShares.nodeId, nodeId), eq(nodeShares.userId, userId)));
      await tx.insert(events).values({
        nodeId,
        kind: 'node_unshared',
        message: `${user.username} 取消了 ${target.username} 对机器 ${node.name} 的分享，移除了 ${owned.length} 个实例登记和 ${records.length} 组解析`,
        createdAt: new Date(),
      });
      return { removedInstances: owned.map((instance) => instance.name), removedRecords: records } as const;
    });
    if ('error' in outcome) return Response.json({ error: outcome.error }, { status: outcome.status });
    for (const name of outcome.removedInstances) await removeReinstallInstance(db, nodeId, name).catch(() => false);
    const warnings: string[] = [];
    for (const record of outcome.removedRecords) {
      for (const target of [{ type: 'A' as const, rr: record.recordV4 }, { type: 'AAAA' as const, rr: record.recordV6 }]) {
        if (!target.rr) continue;
        const label = dnsLabel(record.domainName, target.rr);
        const result = await pauseAliDnsRecord(record.domainName, target.rr, target.type);
        if (!result.ok) warnings.push(`${target.type} ${label} 暂停失败：${result.error}`);
        await db.insert(events).values({
          nodeId,
          level: result.ok ? 'info' : 'error',
          kind: result.ok ? 'dns_paused' : 'dns_pause_failed',
          message: result.ok
            ? `${target.type} 记录 ${label} 已停止同步，并在阿里云上暂停解析`
            : `${target.type} 记录 ${label} 已停止同步，但阿里云暂停解析失败：${result.error}；请到阿里云控制台手动暂停`,
          ipType: target.type,
          createdAt: new Date(),
        });
      }
    }
    return Response.json({ status: 'ok', removedInstances: outcome.removedInstances.length, removedRecords: outcome.removedRecords.length, warnings });
  } finally {
    await releaseNodeOperationLock(db, nodeId, operationId);
  }
}
