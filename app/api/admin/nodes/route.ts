import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { syncAliDnsRecord } from '@/lib/alidns';
import { buildNodeBootstrapConfig, buildNodeConnectCommand, MAX_BOOTSTRAP_RESPONSE_BYTES, MAX_CLOUD_LAUNCHER_BYTES } from '@/lib/install-command';
import { bootstrapDownloadExpiry } from '@/lib/bootstrap-download';
import { parseOfficialNyanpassCommand } from '@/lib/nyanpass-command';
import { publicOrigin } from '@/lib/public-origin';
import { newAgentToken, newBootstrapDownloadToken, sha256 } from '@/lib/security';
import { cleanText, normalizeDnsRr, normalizeDomainName, validDnsRr, validDomainName } from '@/lib/validation';
import { expireProvisionAttempts, isBootstrapLocked } from '@/lib/provision-lifecycle';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { nodeResponse } from '@/lib/node-response';
import { encryptBootstrapPayload } from '@/lib/bootstrap-payload';
import { buildNodeStartupLauncher } from '@/lib/startup-launcher';
import { trustedNyanpassRelease } from '@/lib/nyanpass-release';
import { dnsOwnershipConflictMessage, findDnsOwnershipConflict, isDnsOwnershipConstraintError } from '@/lib/dns-ownership';

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
  if (rootPassword.length < 8 || rootPassword.length > 128 || /[\x00-\x1f\x7f]/.test(rootPassword)) {
    return Response.json({ error: 'root 密码必须为 8-128 个字符，且不能包含控制字符' }, { status: 400 });
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

  const token = newAgentToken();
  const downloadToken = newBootstrapDownloadToken();
  const id = crypto.randomUUID();
  const provisionGeneration = 1;
  const now = new Date();
  const origin = publicOrigin(request);
  let nyanpassRelease;
  try {
    nyanpassRelease = await trustedNyanpassRelease();
  } catch {
    return Response.json({ error: 'Nyanpass 可信发布清单配置无效，请先修正主控环境变量' }, { status: 503 });
  }
  const bootstrapConfig = buildNodeBootstrapConfig({ nodeId: id, generation: provisionGeneration, origin, token, rootPassword, instances: preparedInstances, nyanpassRelease });
  if (new TextEncoder().encode(bootstrapConfig).byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) {
    return Response.json({ error: '节点配置数据超过 64 KiB 服务端安全上限；请减少首次预配实例，节点上线后再用远程同步添加' }, { status: 400 });
  }
  let bootstrapPayloadCiphertext = '';
  try {
    bootstrapPayloadCiphertext = await encryptBootstrapPayload({
      protocol: 1,
      agentToken: token,
      rootPassword,
      instances: preparedInstances.map(({ name: instanceName, optimize, args }) => ({ name: instanceName, optimize, args })),
    }, { nodeId: id, generation: provisionGeneration });
  } catch (error) {
    return Response.json({ error: safeBootstrapEncryptionError(error) }, { status: 503 });
  }
  const [tokenHash, bootstrapDownloadTokenHash] = await Promise.all([sha256(token), sha256(downloadToken)]);
  const installUrl = `${origin}/api/v1/bootstrap/${id}/${downloadToken}`;
  const connectCommand = buildNodeConnectCommand(installUrl);
  const startupScript = buildNodeStartupLauncher(id, installUrl, provisionGeneration);
  if (new TextEncoder().encode(startupScript).byteLength > MAX_CLOUD_LAUNCHER_BYTES) {
    return Response.json({ error: '开机启动器超过 AWS user-data 的 15 KiB 安全上限' }, { status: 500 });
  }

  await ensureSchema();
  const db = await getDb();
  const ownershipConflict = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6 });
  if (ownershipConflict) return Response.json({ error: dnsOwnershipConflictMessage(ownershipConflict) }, { status: 409 });
  try {
    await db.batch([
      db.insert(nodes).values({ id, name, region, tokenHash, provider: 'alidns', domainName, recordV4, recordV6, nyanpassStatus: 'awaiting', provisionGeneration, bootstrapPayloadCiphertext, bootstrapDownloadTokenHash, bootstrapDownloadExpiresAt: bootstrapDownloadExpiry(now), createdAt: now, updatedAt: now }),
      ...preparedInstances.map((instance) => db.insert(nyanpassInstances).values({ id: instance.id, nodeId: id, name: instance.name, role: instance.role, panelUrl: instance.panelUrl, status: 'bootstrap', bootstrapGeneration: provisionGeneration, optimize: instance.optimize, createdAt: now, updatedAt: now })),
      db.insert(events).values({ nodeId: id, kind: 'node_created', message: `${user.email} 创建了节点并预配 ${preparedInstances.length} 个 Nyanpass 实例`, createdAt: now }),
    ]);
  } catch (error) {
    if (!isDnsOwnershipConstraintError(error)) throw error;
    const concurrentOwner = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6 });
    return Response.json({ error: concurrentOwner ? dnsOwnershipConflictMessage(concurrentOwner) : '该 DNS 记录刚刚被其他节点占用，请刷新后重试' }, { status: 409 });
  }

  return Response.json({
    node: { id, name, region },
    installUrl,
    connectCommand,
    startupScript,
    instances: preparedInstances.map((instance) => ({ id: instance.id, nodeId: id, nodeName: name, name: instance.name, role: instance.role, panelUrl: instance.panelUrl, optimize: instance.optimize, status: 'bootstrap', hasCredential: false, lastReportedAt: null, syncError: null, activeTaskId: null, configRevision: 0, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null })),
  }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

function safeBootstrapEncryptionError(error: unknown) {
  return error instanceof Error && error.message.includes('PULSEDNS_TASK_ENCRYPTION_KEY')
    ? error.message
    : '开机脚本凭据加密失败，请检查主控密钥配置';
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
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试修改' }, { status: 409 });
  try {
    const [current] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!current) return Response.json({ error: '节点不存在' }, { status: 404 });

    if (syncEnabled) {
      const ownershipConflict = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6, excludeNodeId: id });
      if (ownershipConflict) return Response.json({ error: dnsOwnershipConflictMessage(ownershipConflict) }, { status: 409 });
    }

  const now = new Date();
  try {
    await db.update(nodes).set({ name, region, domainName, recordV4, recordV6, syncEnabled, updatedAt: now }).where(eq(nodes.id, id));
  } catch (error) {
    if (!isDnsOwnershipConstraintError(error)) throw error;
    const concurrentOwner = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6, excludeNodeId: id });
    return Response.json({ error: concurrentOwner ? dnsOwnershipConflictMessage(concurrentOwner) : '该 DNS 记录刚刚被其他节点占用，请刷新后重试' }, { status: 409 });
  }

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

  // Re-read addresses after publishing the new mapping. A probe report may
  // have committed a newer IP between the initial read and this update.
  const [addressState] = await db.select({ ipv4: nodes.ipv4, ipv6: nodes.ipv6 }).from(nodes).where(eq(nodes.id, id)).limit(1);
  const targets = [
    { type: 'A' as const, record: recordV4, ip: addressState?.ipv4 ?? null },
    { type: 'AAAA' as const, record: recordV6, ip: addressState?.ipv6 ?? null },
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

  const [latestNode] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    return Response.json({
      node: nodeResponse(latestNode ?? { ...current, name, region, domainName, recordV4, recordV6, syncEnabled, updatedAt: now }),
      events: returnedEvents,
      warnings,
    });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试删除' }, { status: 409 });
  try {
    await expireProvisionAttempts(db, new Date(), id);
    const [node] = await db.select({ nyanpassStatus: nodes.nyanpassStatus, provisionAttemptId: nodes.provisionAttemptId }).from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });
    if (isBootstrapLocked(node.nyanpassStatus) && searchParams.get('confirmProvisioning') !== 'checked') {
      return Response.json({ error: '节点尚未安全完成开机预配；明确确认脚本未执行或安装进程已停止后才能删除' }, { status: 409 });
    }
    const [activeTask] = await db.select({ id: agentTasks.id }).from(agentTasks)
      .where(and(eq(agentTasks.nodeId, id), inArray(agentTasks.status, ['queued', 'running']))).limit(1);
    if (activeTask) return Response.json({ error: '节点还有排队或执行中的同步任务；请先取消尚未领取的排队，机器开始安装后不能删除节点' }, { status: 409 });
    const [[uncertainInstance], [uncertainTask]] = await Promise.all([
      db.select({ id: nyanpassInstances.id }).from(nyanpassInstances)
        .where(and(eq(nyanpassInstances.nodeId, id), eq(nyanpassInstances.status, 'uncertain'))).limit(1),
      db.select({ id: agentTasks.id }).from(agentTasks)
        .where(and(eq(agentTasks.nodeId, id), eq(agentTasks.status, 'uncertain'))).limit(1),
    ]);
    if ((node.nyanpassStatus === 'failed' || uncertainInstance || uncertainTask) && searchParams.get('confirmUncertain') !== 'checked') {
      return Response.json({
        error: '节点存在结果未知的开机安装或远程任务；请先核查 VPS，明确确认后才能删除登记',
        requiresUncertainConfirmation: true,
      }, { status: 409 });
    }
    const attemptCondition = node.provisionAttemptId === null ? isNull(nodes.provisionAttemptId) : eq(nodes.provisionAttemptId, node.provisionAttemptId);
    const deleted = await db.delete(nodes).where(and(eq(nodes.id, id), eq(nodes.nyanpassStatus, node.nyanpassStatus), attemptCondition)).returning({ id: nodes.id });
    if (!deleted.length) return Response.json({ error: '节点开机安装状态已经变化，请刷新后重试' }, { status: 409 });
    return Response.json({ status: 'ok' });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
}
