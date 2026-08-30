import { and, desc, eq, isNull } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { expireAgentTasks } from '@/lib/agent-task-lifecycle';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { nodeResponse } from '@/lib/node-response';
import { parseOfficialNyanpassCommand } from '@/lib/nyanpass-command';
import { encryptNyanpassCredential } from '@/lib/nyanpass-credential';
import { expireProvisionAttempts, isBootstrapLocked } from '@/lib/provision-lifecycle';
import { cleanText } from '@/lib/validation';
import { pruneEvents } from '@/lib/event-retention';

const busyStatuses = new Set(['pending', 'running']);

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  await ensureSchema();
  const db = await getDb();
  await expireProvisionAttempts(db, new Date());
  await expireAgentTasks(db, new Date());
  await pruneEvents(db).catch(() => undefined);
  const rows = await db.select({
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
  const nodeRows = await db.select().from(nodes).orderBy(desc(nodes.createdAt));
  const latestEvents = await db.select({
    id: events.id,
    nodeId: events.nodeId,
    nodeName: nodes.name,
    level: events.level,
    kind: events.kind,
    message: events.message,
    createdAt: events.createdAt,
  }).from(events).leftJoin(nodes, eq(events.nodeId, nodes.id)).orderBy(desc(events.createdAt)).limit(100);
  return Response.json({
    instances: rows.map(instanceResponse),
    nodes: nodeRows.map(nodeResponse),
    events: latestEvents.map((event) => ({ ...event, nodeName: event.nodeName ?? '已删除节点', createdAt: event.createdAt.toISOString() })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const nodeId = cleanText(body?.nodeId, 64);
  const name = cleanText(body?.name, 48);
  const optimize = body?.optimize === true || body?.optimize === 'on';
  const parsedCommand = parseOfficialNyanpassCommand(body?.command);
  if (!nodeId) return Response.json({ error: '请选择所属探针节点' }, { status: 400 });
  if (!validServiceName(name)) return Response.json({ error: '实例名只能包含字母、数字、点、下划线和短横线' }, { status: 400 });
  if (!parsedCommand.ok) return Response.json({ error: parsedCommand.error }, { status: 400 });

  await ensureSchema();
  const db = await getDb();
  const operationId = await acquireNodeOperationLock(db, nodeId);
  if (operationId === undefined) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    await expireProvisionAttempts(db, new Date(), nodeId);
    const [node] = await db.select({ id: nodes.id, name: nodes.name, nyanpassStatus: nodes.nyanpassStatus }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return Response.json({ error: '所属节点不存在' }, { status: 404 });
    if (isBootstrapLocked(node.nyanpassStatus)) return Response.json({ error: '节点的开机预配尚未安全完成；请先执行或按日志恢复同一份开机脚本' }, { status: 409 });
    const duplicate = await db.select({ id: nyanpassInstances.id }).from(nyanpassInstances)
      .where(and(eq(nyanpassInstances.nodeId, nodeId), eq(nyanpassInstances.name, name))).limit(1);
    if (duplicate.length) return Response.json({ error: '该节点已经登记了同名实例' }, { status: 409 });

    const id = crypto.randomUUID();
    const revision = 1;
    let credentialCiphertext = '';
    try {
      credentialCiphertext = await encryptNyanpassCredential(parsedCommand.clientToken, { nodeId, instanceId: id, revision });
    } catch (error) {
      return Response.json({ error: safeEncryptionError(error) }, { status: 503 });
    }

    const now = new Date();
    const roleLabel = parsedCommand.role === 'outbound' ? '出口' : '入口';
    await db.batch([
      db.insert(nyanpassInstances).values({
        id,
        nodeId,
        name,
        role: parsedCommand.role,
        panelUrl: parsedCommand.panelUrl,
        status: 'ready',
        optimize,
        credentialCiphertext,
        configRevision: revision,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(events).values({ nodeId, kind: 'nyanpass_created', message: `${user.email} 添加了${roleLabel}实例 ${name}，等待同步`, createdAt: now }),
    ]);

    return Response.json({
      instance: instanceResponse({ id, nodeId, nodeName: node.name, name, role: parsedCommand.role, panelUrl: parsedCommand.panelUrl, optimize, status: 'ready', hasCredential: true, lastReportedAt: null, syncError: null, activeTaskId: null, configRevision: revision, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null }),
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } finally {
    await releaseNodeOperationLock(db, nodeId, operationId);
  }
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = cleanText(body?.id, 64);
  const name = cleanText(body?.name, 48);
  const hasCommand = typeof body?.command === 'string' && body.command.trim().length > 0;
  const optimize = body?.optimize === true || body?.optimize === 'on';
  const confirmUncertain = body?.confirmUncertain === 'checked';
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400 });
  if (!validServiceName(name)) return Response.json({ error: '实例名只能包含字母、数字、点、下划线和短横线' }, { status: 400 });

  await ensureSchema();
  const db = await getDb();
  const [located] = await db.select({ nodeId: nyanpassInstances.nodeId }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!located) return Response.json({ error: '实例不存在' }, { status: 404 });
  const operationId = await acquireNodeOperationLock(db, located.nodeId);
  if (operationId === undefined) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
  const [current] = await db.select().from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!current) return Response.json({ error: '实例不存在' }, { status: 404 });
  await expireProvisionAttempts(db, new Date(), current.nodeId);
  if (busyStatuses.has(current.status)) return Response.json({ error: '实例正在等待或执行同步，暂时不能修改' }, { status: 409 });
  if (current.status === 'uncertain' && !confirmUncertain) {
    return Response.json({ error: '结果未知的任务仍可能在机器上运行；请先核查 VPS，并明确确认后再修改', requiresUncertainConfirmation: true }, { status: 409 });
  }
  if (!current.credentialCiphertext && !hasCommand) {
    return Response.json({ error: '该实例没有可再次下发的凭据，请重新粘贴官方命令' }, { status: 400 });
  }
  if (name !== current.name) return Response.json({ error: '机器服务名创建后不可修改；如需换名，请新增实例，确认新服务正常后再移除旧登记' }, { status: 409 });
  if (optimize !== current.optimize && !hasCommand) return Response.json({ error: '修改 OPTIMIZE 时请同时重新粘贴官方命令' }, { status: 400 });
  const [node] = await db.select({ id: nodes.id, name: nodes.name, nyanpassStatus: nodes.nyanpassStatus }).from(nodes).where(eq(nodes.id, current.nodeId)).limit(1);
  if (!node) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  if (isBootstrapLocked(node.nyanpassStatus)) return Response.json({ error: '节点的开机预配尚未安全完成，不能修改实例配置' }, { status: 409 });
  let role = current.role;
  let panelUrl = current.panelUrl;
  let status = current.status;
  let revision = current.configRevision;
  let credentialCiphertext = current.credentialCiphertext;
  let activeTaskId = current.activeTaskId;
  let syncError = current.syncError;
  if (hasCommand) {
    const parsed = parseOfficialNyanpassCommand(body?.command);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    revision += 1;
    try {
      credentialCiphertext = await encryptNyanpassCredential(parsed.clientToken, { nodeId: current.nodeId, instanceId: id, revision });
    } catch (error) {
      return Response.json({ error: safeEncryptionError(error) }, { status: 503 });
    }
    role = parsed.role;
    panelUrl = parsed.panelUrl;
    status = 'ready';
    activeTaskId = null;
    syncError = null;
  }

  const now = new Date();
  const activeTaskCondition = current.activeTaskId ? eq(nyanpassInstances.activeTaskId, current.activeTaskId) : isNull(nyanpassInstances.activeTaskId);
  const updated = await db.update(nyanpassInstances).set({
    name: current.name,
    role,
    panelUrl,
    optimize: hasCommand ? optimize : current.optimize,
    credentialCiphertext,
    configRevision: revision,
    status,
    activeTaskId,
    syncError,
    updatedAt: now,
  }).where(and(
    eq(nyanpassInstances.id, id),
    eq(nyanpassInstances.status, current.status),
    eq(nyanpassInstances.configRevision, current.configRevision),
    activeTaskCondition,
  )).returning({ id: nyanpassInstances.id });
  if (!updated.length) return Response.json({ error: '实例状态同时发生了变化，请刷新后重试' }, { status: 409 });
  const roleLabel = role === 'outbound' ? '出口' : '入口';
  const [updatedEvent] = await db.insert(events).values({
    nodeId: current.nodeId,
    kind: 'nyanpass_updated',
    message: `${user.email} 更新了${roleLabel}实例 ${current.name} 的同步配置`,
    createdAt: now,
  }).returning({ id: events.id, nodeId: events.nodeId, level: events.level, kind: events.kind, message: events.message, createdAt: events.createdAt });

  return Response.json({
    instance: instanceResponse({ id, nodeId: current.nodeId, nodeName: node.name, name: current.name, role, panelUrl, optimize: hasCommand ? optimize : current.optimize, status, hasCredential: Boolean(credentialCiphertext), lastReportedAt: current.lastReportedAt, syncError, activeTaskId, configRevision: revision, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null }),
    event: { ...updatedEvent, nodeName: node.name },
  }, { headers: { 'Cache-Control': 'no-store' } });
  } finally {
    await releaseNodeOperationLock(db, located.nodeId, operationId);
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const [located] = await db.select({ nodeId: nyanpassInstances.nodeId }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!located) return Response.json({ error: '实例不存在' }, { status: 404 });
  const operationId = await acquireNodeOperationLock(db, located.nodeId);
  if (operationId === undefined) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
  const [current] = await db.select({ nodeId: nyanpassInstances.nodeId, status: nyanpassInstances.status, configRevision: nyanpassInstances.configRevision, activeTaskId: nyanpassInstances.activeTaskId }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!current) return Response.json({ error: '实例不存在' }, { status: 404 });
  await expireProvisionAttempts(db, new Date(), current.nodeId);
  const [node] = await db.select({ nyanpassStatus: nodes.nyanpassStatus }).from(nodes).where(eq(nodes.id, current.nodeId)).limit(1);
  if (node && isBootstrapLocked(node.nyanpassStatus)) return Response.json({ error: '节点的开机预配尚未安全完成，不能单独移除预配实例' }, { status: 409 });
  if (busyStatuses.has(current.status)) return Response.json({ error: '实例正在等待或执行同步，不能删除' }, { status: 409 });
  if (current.status === 'uncertain' && searchParams.get('confirmUncertain') !== 'checked') {
    return Response.json({ error: '结果未知的任务仍可能回传；请先核查 VPS，并使用明确确认后再移除登记' }, { status: 409 });
  }
  const activeTaskCondition = current.activeTaskId ? eq(nyanpassInstances.activeTaskId, current.activeTaskId) : isNull(nyanpassInstances.activeTaskId);
  const deleted = await db.delete(nyanpassInstances).where(and(
    eq(nyanpassInstances.id, id),
    eq(nyanpassInstances.status, current.status),
    eq(nyanpassInstances.configRevision, current.configRevision),
    activeTaskCondition,
  )).returning({ id: nyanpassInstances.id });
  if (!deleted.length) return Response.json({ error: '实例状态同时发生了变化，请刷新后重试' }, { status: 409 });
  return Response.json({ status: 'ok' });
  } finally {
    await releaseNodeOperationLock(db, located.nodeId, operationId);
  }
}

function instanceResponse(instance: {
  id: string;
  nodeId: string;
  nodeName: string | null;
  name: string;
  role: 'inbound' | 'outbound';
  panelUrl: string;
  optimize: boolean;
  status: string;
  lastReportedAt: Date | null;
  syncError: string | null;
  activeTaskId: string | null;
  configRevision: number;
  hasCredential?: boolean;
  credentialCiphertext?: string | null;
  taskStatus: string | null;
  taskCreatedAt: Date | null;
  taskClaimedAt: Date | null;
  taskLeaseExpiresAt: Date | null;
}) {
  const { credentialCiphertext, ...safeInstance } = instance;
  return {
    ...safeInstance,
    hasCredential: instance.hasCredential ?? Boolean(credentialCiphertext),
    nodeName: instance.nodeName ?? '已删除节点',
    lastReportedAt: instance.lastReportedAt?.toISOString() ?? null,
    taskCreatedAt: instance.taskCreatedAt?.toISOString() ?? null,
    taskClaimedAt: instance.taskClaimedAt?.toISOString() ?? null,
    taskLeaseExpiresAt: instance.taskLeaseExpiresAt?.toISOString() ?? null,
  };
}

function validServiceName(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(value);
}

function safeEncryptionError(error: unknown) {
  return error instanceof Error && error.message.includes('PULSEDNS_TASK_ENCRYPTION_KEY')
    ? error.message
    : '同步凭据加密失败，请检查主控密钥配置';
}
