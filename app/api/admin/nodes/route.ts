import { eq } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes, nyanpassInstances } from '@/db/schema';
import { syncAliDnsRecord } from '@/lib/alidns';
import { buildNodeStartupScript } from '@/lib/install-command';
import { parseOfficialNyanpassCommand } from '@/lib/nyanpass-command';
import { publicOrigin } from '@/lib/public-origin';
import { newAgentToken, sha256 } from '@/lib/security';
import { cleanText, normalizeDnsRr, normalizeDomainName, validDnsRr, validDomainName } from '@/lib/validation';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = cleanText(body?.name, 60);
  const region = cleanText(body?.region, 40) || 'unknown';
  const domainName = normalizeDomainName(body?.domainName) || null;
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  const rootPassword = typeof body?.rootPassword === 'string' ? body.rootPassword : '';
  const nyanpassInput = Array.isArray(body?.nyanpass) ? body.nyanpass : [];
  if (!name) return Response.json({ error: '节点名称不能为空' }, { status: 400 });
  if (rootPassword.length < 8 || rootPassword.length > 128 || /[\r\n]/.test(rootPassword)) {
    return Response.json({ error: 'root 密码必须为 8-128 个字符，且不能包含换行' }, { status: 400 });
  }
  if (!nyanpassInput.length || nyanpassInput.length > 16) {
    return Response.json({ error: '请预先配置 1-16 个 Nyanpass 实例' }, { status: 400 });
  }
  if ((recordV4 || recordV6) && !domainName) return Response.json({ error: '配置 DNS 记录时必须填写阿里云主域名' }, { status: 400 });
  if (domainName && !validDomainName(domainName)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });

  const instanceNames = new Set<string>();
  const preparedInstances: Array<{
    id: string; name: string; args: string; panelUrl: string; role: 'inbound' | 'outbound'; optimize: boolean;
  }> = [];
  for (const input of nyanpassInput) {
    if (!input || typeof input !== 'object') return Response.json({ error: 'Nyanpass 实例参数无效' }, { status: 400 });
    const entry = input as Record<string, unknown>;
    const instanceName = cleanText(entry.name, 48);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(instanceName)) {
      return Response.json({ error: 'Nyanpass 实例名只能包含字母、数字、点、下划线和短横线' }, { status: 400 });
    }
    if (instanceNames.has(instanceName)) return Response.json({ error: `Nyanpass 实例名重复：${instanceName}` }, { status: 400 });
    const parsed = parseOfficialNyanpassCommand(entry.command);
    if (!parsed.ok) return Response.json({ error: `${instanceName}：${parsed.error}` }, { status: 400 });
    instanceNames.add(instanceName);
    preparedInstances.push({ id: crypto.randomUUID(), name: instanceName, args: parsed.args, panelUrl: parsed.panelUrl, role: parsed.role, optimize: entry.optimize === true });
  }

  await ensureSchema();
  const db = await getDb();
  const token = newAgentToken();
  const now = new Date();
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(nodes).values({ id, name, region, tokenHash: await sha256(token), provider: 'alidns', domainName, recordV4, recordV6, createdAt: now, updatedAt: now }),
    ...preparedInstances.map((instance) => db.insert(nyanpassInstances).values({ id: instance.id, nodeId: id, name: instance.name, role: instance.role, panelUrl: instance.panelUrl, createdAt: now, updatedAt: now })),
    db.insert(events).values({ nodeId: id, kind: 'node_created', message: `${user.email} 创建了节点并预配 ${preparedInstances.length} 个 Nyanpass 实例`, createdAt: now }),
  ]);

  const origin = publicOrigin(request);
  const installCommand = buildNodeStartupScript({ nodeId: id, origin, token, rootPassword, instances: preparedInstances });
  return Response.json({
    node: { id, name, region },
    token,
    installCommand,
    instances: preparedInstances.map((instance) => ({ id: instance.id, nodeId: id, nodeName: name, name: instance.name, role: instance.role, panelUrl: instance.panelUrl })),
  }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = cleanText(body?.id, 64);
  const name = cleanText(body?.name, 60);
  const region = cleanText(body?.region, 40) || 'unknown';
  const domainName = normalizeDomainName(body?.domainName) || null;
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  const syncEnabled = body?.syncEnabled;
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  if (!name) return Response.json({ error: '节点名称不能为空' }, { status: 400 });
  if (typeof syncEnabled !== 'boolean') return Response.json({ error: '同步状态参数无效' }, { status: 400 });
  if ((recordV4 || recordV6) && !domainName) return Response.json({ error: '配置 DNS 记录时必须填写阿里云主域名' }, { status: 400 });
  if (domainName && !validDomainName(domainName)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });

  await ensureSchema();
  const db = await getDb();
  const [current] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!current) return Response.json({ error: '节点不存在' }, { status: 404 });

  const now = new Date();
  await db.update(nodes).set({ name, region, domainName, recordV4, recordV6, syncEnabled, updatedAt: now }).where(eq(nodes.id, id));

  const returnedEvents: Array<{ id: number; nodeId: string; nodeName: string; level: string; kind: string; message: string; createdAt: Date }> = [];
  const [updatedEvent] = await db.insert(events).values({
    nodeId: id,
    kind: 'node_updated',
    message: `${user.email} 修改了节点 ${name} 的控制台配置`,
    createdAt: now,
  }).returning({ id: events.id, nodeId: events.nodeId, level: events.level, kind: events.kind, message: events.message, createdAt: events.createdAt });
  returnedEvents.push({ ...updatedEvent, nodeName: name });

  const warnings: string[] = [];
  const dnsMappingChanged = current.domainName !== domainName || current.recordV4 !== recordV4 || current.recordV6 !== recordV6;
  if (dnsMappingChanged && current.domainName && (current.recordV4 || current.recordV6)) {
    warnings.push('旧的阿里云 DNS 记录不会自动删除，如已不再使用请到阿里云控制台清理');
  }

  const targets = [
    { type: 'A' as const, record: recordV4, ip: current.ipv4 },
    { type: 'AAAA' as const, record: recordV6, ip: current.ipv6 },
  ];
  if (syncEnabled && domainName) {
    for (const target of targets) {
      if (!target.record || !target.ip) continue;
      const result = await syncAliDnsRecord(domainName, target.record, target.type, target.ip);
      if (!result.ok) warnings.push(`${target.type} 同步失败：${result.error}`);
      const [dnsEvent] = await db.insert(events).values({
        nodeId: id,
        level: result.ok ? 'info' : 'error',
        kind: result.ok ? 'dns_synced' : 'dns_failed',
        message: result.ok ? `${target.type} 记录 ${target.record} 已按修改后的配置同步` : `${target.type} 同步失败：${result.error}`,
        ipType: target.type,
        ip: target.ip,
        createdAt: now,
      }).returning({ id: events.id, nodeId: events.nodeId, level: events.level, kind: events.kind, message: events.message, createdAt: events.createdAt });
      returnedEvents.push({ ...dnsEvent, nodeName: name });
    }
  }

  return Response.json({
    node: { ...current, name, region, domainName, recordV4, recordV6, syncEnabled, updatedAt: now },
    events: returnedEvents,
    warnings,
  });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  await db.delete(nodes).where(eq(nodes.id, id));
  return Response.json({ status: 'ok' });
}
