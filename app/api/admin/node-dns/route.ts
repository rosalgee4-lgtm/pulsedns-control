import { eq } from 'drizzle-orm';
import { isDuplicateKeyError } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodeDnsRecords, nodes, users } from '@/db/schema';
import { requireApiUser } from '@/lib/auth';
import { syncAliDnsRecord } from '@/lib/alidns';
import { dnsOwnershipConflictMessage, findDnsOwnershipConflict } from '@/lib/dns-ownership';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { domainUsableBy, isSharedWith } from '@/lib/ownership';
import { dnsLabel } from '@/lib/shared-dns';
import { cleanText, normalizeDnsRr, normalizeDomainName, validDnsRr, validDomainName } from '@/lib/validation';

// 共享机器上的解析：被分享的用户用自己的主域名与阿里云账号，把记录指向这台机器；机器换 IP 时自动同步。
// 管理员也可以带上 userId，用自己的主域名给被分享用户分配解析；对方只能查看，不能修改或删除。

export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const nodeId = cleanText(body?.nodeId, 64);
  const domainName = normalizeDomainName(body?.domainName);
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  if (!nodeId) return Response.json({ error: '请选择共享机器' }, { status: 400 });
  if (!domainName || !validDomainName(domainName)) return Response.json({ error: '请选择主域名' }, { status: 400 });
  if (!recordV4 && !recordV6) return Response.json({ error: '至少填写一个 IPv4 或 IPv6 主机记录' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });
  const assigneeId = user.role === 'admin' ? cleanText(body?.userId, 64) : '';
  let owner = { id: user.id, username: user.username };
  if (assigneeId) {
    const [assignee] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, assigneeId)).limit(1);
    if (!assignee || !await isSharedWith(db, assignee.id, nodeId)) return Response.json({ error: '这台机器没有分享给该用户' }, { status: 404 });
    owner = assignee;
  } else if (!await isSharedWith(db, user.id, nodeId)) return Response.json({ error: '只能在分享给你的机器上添加解析' }, { status: 404 });
  if (!await domainUsableBy(db, user.id, domainName)) return Response.json({ error: `主域名 ${domainName} 不在你的「阿里云主域名」列表中，请先添加` }, { status: 400 });
  const assignedBy = assigneeId ? user.id : null;

  const operationId = await acquireNodeOperationLock(db, nodeId);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    const conflict = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6 });
    if (conflict) return Response.json({ error: dnsOwnershipConflictMessage(conflict) }, { status: 409 });
    const id = crypto.randomUUID();
    const now = new Date();
    try {
      await db.insert(nodeDnsRecords).values({ id, nodeId, ownerId: owner.id, domainName, recordV4, recordV6, assignedBy, createdAt: now });
    } catch (error) {
      if (isDuplicateKeyError(error)) return Response.json({ error: '该主机记录刚刚被其他解析占用，请刷新后重试' }, { status: 409 });
      throw error;
    }
    const [node] = await db.select({ name: nodes.name, ipv4: nodes.ipv4, ipv6: nodes.ipv6 }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    const labels = [recordV4 && `A ${dnsLabel(domainName, recordV4)}`, recordV6 && `AAAA ${dnsLabel(domainName, recordV6)}`].filter(Boolean).join('、');
    const returnedEvents = [];
    const created = { nodeId, level: 'info', kind: 'dns_record_added', message: assignedBy
      ? `${user.username} 给 ${owner.username} 分配了机器 ${node?.name ?? ''} 上的解析 ${labels}`
      : `${user.username} 在机器 ${node?.name ?? ''} 上添加了解析 ${labels}`, createdAt: now };
    const [{ id: createdEventId }] = await db.insert(events).values(created).$returningId();
    returnedEvents.push({ ...created, id: createdEventId, nodeName: node?.name ?? '' });

    // 立即按机器当前地址同步一次；之后由探针上报自动保持。
    const warnings: string[] = [];
    for (const target of [{ type: 'A' as const, record: recordV4, ip: node?.ipv4 ?? null }, { type: 'AAAA' as const, record: recordV6, ip: node?.ipv6 ?? null }]) {
      if (!target.record || !target.ip) continue;
      const label = dnsLabel(domainName, target.record);
      // 之前取消分享时可能在阿里云上暂停过，重新添加时一并恢复解析。
      const result = await syncAliDnsRecord(domainName, target.record, target.type, target.ip, { enable: true });
      if (!result.ok) warnings.push(`${target.type} 同步失败：${result.error}`);
      const dnsEvent = {
        nodeId,
        level: result.ok ? 'info' : 'error',
        kind: result.ok ? 'dns_synced' : 'dns_failed',
        message: result.ok ? `${target.type} 记录 ${label} 已同步` : `${target.type} 记录 ${label} 同步失败：${result.error}`,
        ipType: target.type,
        ip: target.ip,
        createdAt: now,
      };
      const [{ id: dnsEventId }] = await db.insert(events).values(dnsEvent).$returningId();
      returnedEvents.push({ id: dnsEventId, nodeId, level: dnsEvent.level, kind: dnsEvent.kind, message: dnsEvent.message, createdAt: now, nodeName: node?.name ?? '' });
    }
    return Response.json({
      record: { id, nodeId, nodeName: node?.name ?? '', ownerId: owner.id, ownerName: owner.username, domainName, recordV4, recordV6, assigned: Boolean(assignedBy), createdAt: now.toISOString() },
      events: returnedEvents.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
      warnings,
    }, { status: 201 });
  } finally {
    await releaseNodeOperationLock(db, nodeId, operationId);
  }
}

// 删除只停止同步，不会删除阿里云上已有的记录。添加者本人或管理员可以删除。
export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const id = cleanText(new URL(request.url).searchParams.get('id'), 64);
  if (!id) return Response.json({ error: '缺少解析 ID' }, { status: 400 });
  const [record] = await db.select().from(nodeDnsRecords).where(eq(nodeDnsRecords.id, id)).limit(1);
  if (!record || (user.role !== 'admin' && record.ownerId !== user.id)) return Response.json({ error: '解析不存在或不是你添加的' }, { status: 404 });
  if (record.assignedBy && user.role !== 'admin') return Response.json({ error: '这是管理员分配给你的解析，只有管理员能移除' }, { status: 403 });
  const operationId = await acquireNodeOperationLock(db, record.nodeId);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    await db.delete(nodeDnsRecords).where(eq(nodeDnsRecords.id, id));
    const [node] = await db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, record.nodeId)).limit(1);
    const labels = [record.recordV4 && `A ${dnsLabel(record.domainName, record.recordV4)}`, record.recordV6 && `AAAA ${dnsLabel(record.domainName, record.recordV6)}`].filter(Boolean).join('、');
    await db.insert(events).values({ nodeId: record.nodeId, kind: 'dns_record_removed', message: `${user.username} 移除了机器 ${node?.name ?? ''} 上的解析 ${labels}`, createdAt: new Date() });
    return Response.json({ status: 'ok', warnings: ['阿里云上已有的记录不会自动删除，如已不再使用请到阿里云控制台清理'] });
  } finally {
    await releaseNodeOperationLock(db, record.nodeId, operationId);
  }
}
