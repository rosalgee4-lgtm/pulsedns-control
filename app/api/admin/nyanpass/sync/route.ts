import { and, eq, exists, gt, isNull } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { cleanText } from '@/lib/validation';
import { expireProvisionAttempts, isBootstrapLocked } from '@/lib/provision-lifecycle';

const maxPollAgeMs = 2 * 60 * 1000;
const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401, headers: noStoreHeaders });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = cleanText(body?.id, 64);
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400, headers: noStoreHeaders });

  await ensureSchema();
  const db = await getDb();
  const [located] = await db.select({ nodeId: nyanpassInstances.nodeId }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!located) return Response.json({ error: '实例不存在' }, { status: 404, headers: noStoreHeaders });
  const operationId = await acquireNodeOperationLock(db, located.nodeId);
  if (operationId === undefined) return Response.json({ error: '所属节点不存在' }, { status: 404, headers: noStoreHeaders });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试同步' }, { status: 409, headers: noStoreHeaders });
  try {
  await expireProvisionAttempts(db, new Date(), located.nodeId);
  const [instance] = await db.select({
    id: nyanpassInstances.id,
    nodeId: nyanpassInstances.nodeId,
    nodeName: nodes.name,
    name: nyanpassInstances.name,
    role: nyanpassInstances.role,
    panelUrl: nyanpassInstances.panelUrl,
    optimize: nyanpassInstances.optimize,
    status: nyanpassInstances.status,
    credentialCiphertext: nyanpassInstances.credentialCiphertext,
    configRevision: nyanpassInstances.configRevision,
    activeTaskId: nyanpassInstances.activeTaskId,
    lastReportedAt: nyanpassInstances.lastReportedAt,
    agentVersion: nodes.agentVersion,
    lastTaskPollAt: nodes.lastTaskPollAt,
    nodeProvisionStatus: nodes.nyanpassStatus,
  }).from(nyanpassInstances).leftJoin(nodes, eq(nyanpassInstances.nodeId, nodes.id)).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!instance) return Response.json({ error: '实例不存在' }, { status: 404, headers: noStoreHeaders });
  if (!instance.nodeName) return Response.json({ error: '所属节点不存在' }, { status: 404, headers: noStoreHeaders });
  if (isBootstrapLocked(instance.nodeProvisionStatus ?? '')) {
    return Response.json({ error: '节点的开机预配尚未安全完成，不能下发远程任务' }, { status: 409, headers: noStoreHeaders });
  }
  const requestTime = new Date();
  if (!supportsRemoteSync(instance.agentVersion)) {
    return Response.json({ error: '探针版本不支持远程同步，请先在 VPS 执行一次升级命令' }, { status: 409, headers: noStoreHeaders });
  }
  const [activeNodeTask] = await db.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.nodeId, instance.nodeId),
    eq(agentTasks.status, 'running'),
    gt(agentTasks.leaseExpiresAt, requestTime),
  )).limit(1);
  if ((!instance.lastTaskPollAt || requestTime.getTime() - instance.lastTaskPollAt.getTime() > maxPollAgeMs) && !activeNodeTask) {
    return Response.json({ error: '探针最近 2 分钟没有领取任务心跳，请先检查 ddns-monitor 服务和网络' }, { status: 409, headers: noStoreHeaders });
  }
  if (instance.status === 'pending' || instance.status === 'running') {
    return Response.json({ error: '该实例已经在同步队列中' }, { status: 409, headers: noStoreHeaders });
  }
  if (instance.status === 'uncertain') {
    return Response.json({ error: '上一次执行结果未知，请先检查 VPS，再编辑并重新粘贴官方命令' }, { status: 409, headers: noStoreHeaders });
  }
  if (!['ready', 'failed'].includes(instance.status)) {
    return Response.json({ error: '当前实例状态不能直接同步，请先修改并重新粘贴官方命令' }, { status: 409, headers: noStoreHeaders });
  }
  if (!instance.credentialCiphertext || instance.configRevision < 1) {
    return Response.json({ error: '没有可同步的加密凭据，请先点击修改并重新粘贴官方命令' }, { status: 409, headers: noStoreHeaders });
  }

  const [existingTask] = await db.select({ id: agentTasks.id, status: agentTasks.status, updatedAt: agentTasks.updatedAt }).from(agentTasks)
    .where(and(eq(agentTasks.instanceId, id), eq(agentTasks.revision, instance.configRevision))).limit(1);
  const reusable = existingTask && ['failed', 'canceled'].includes(existingTask.status);
  if (existingTask && !reusable) {
    return Response.json({ error: '该配置已经下发，请刷新状态' }, { status: 409, headers: noStoreHeaders });
  }

  const now = existingTask
    ? new Date(Math.max(requestTime.getTime(), existingTask.updatedAt.getTime() + 1))
    : requestTime;
  const taskId = existingTask?.id ?? crypto.randomUUID();
  const expectedActiveTask = instance.activeTaskId ? eq(nyanpassInstances.activeTaskId, instance.activeTaskId) : isNull(nyanpassInstances.activeTaskId);
  try {
    if (existingTask && reusable) {
      await db.batch([
        db.update(agentTasks).set({
          status: 'queued',
          leaseTokenHash: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
          claimedAt: null,
          finishedAt: null,
        }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, existingTask.status), eq(agentTasks.revision, instance.configRevision))),
        db.update(nyanpassInstances).set({ status: 'pending', activeTaskId: taskId, syncError: null, updatedAt: now }).where(and(
          eq(nyanpassInstances.id, id),
          eq(nyanpassInstances.status, instance.status),
          eq(nyanpassInstances.configRevision, instance.configRevision),
          expectedActiveTask,
        )),
      ]);
    } else {
      await db.batch([
        db.insert(agentTasks).values({
          id: taskId,
          nodeId: instance.nodeId,
          instanceId: id,
          kind: 'nyanpass_apply_v1',
          revision: instance.configRevision,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        }),
        db.update(nyanpassInstances).set({ status: 'pending', activeTaskId: taskId, syncError: null, updatedAt: now }).where(and(
          eq(nyanpassInstances.id, id),
          eq(nyanpassInstances.status, instance.status),
          eq(nyanpassInstances.configRevision, instance.configRevision),
          expectedActiveTask,
        )),
      ]);
    }
  } catch {
    return Response.json({ error: '该配置状态已经变化，请刷新后重试' }, { status: 409, headers: noStoreHeaders });
  }

  const [queued] = await db.select({
    status: agentTasks.status,
    createdAt: agentTasks.createdAt,
    claimedAt: agentTasks.claimedAt,
    leaseExpiresAt: agentTasks.leaseExpiresAt,
  }).from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.instanceId, id), eq(agentTasks.revision, instance.configRevision))).limit(1);
  const [current] = await db.select({
    status: nyanpassInstances.status,
    activeTaskId: nyanpassInstances.activeTaskId,
    configRevision: nyanpassInstances.configRevision,
    syncError: nyanpassInstances.syncError,
    lastReportedAt: nyanpassInstances.lastReportedAt,
    credentialCiphertext: nyanpassInstances.credentialCiphertext,
  })
    .from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  const activeProgress = Boolean(
    queued && current && current.configRevision === instance.configRevision && current.activeTaskId === taskId
      && ((queued.status === 'queued' && current.status === 'pending')
        || (queued.status === 'running' && current.status === 'running')
        || (queued.status === 'failed' && current.status === 'failed')
        || (queued.status === 'uncertain' && current.status === 'uncertain')),
  );
  const completedBeforeResponse = Boolean(
    queued?.status === 'succeeded' && current?.configRevision === instance.configRevision
      && current.status === 'success' && current.activeTaskId === null,
  );
  if (!activeProgress && !completedBeforeResponse) {
    if (current?.activeTaskId !== taskId) {
      await db.delete(agentTasks).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'queued'))).catch(() => undefined);
    }
    return Response.json({ error: '实例配置同时被修改，任务没有下发，请刷新后重试' }, { status: 409, headers: noStoreHeaders });
  }

  await db.insert(events).values({
    nodeId: instance.nodeId,
    kind: 'nyanpass_sync_queued',
    message: `${user.email} 将实例 ${instance.name}${existingTask ? '重新' : ''}加入机器同步队列`,
    createdAt: now,
  });
  return Response.json({
    instance: instanceResponse({
      ...instance,
      status: current!.status,
      syncError: current!.syncError,
      activeTaskId: current!.activeTaskId,
      lastReportedAt: current!.lastReportedAt,
      hasCredential: Boolean(current!.credentialCiphertext),
      taskStatus: current!.activeTaskId === taskId ? queued!.status : null,
      taskCreatedAt: current!.activeTaskId === taskId ? queued!.createdAt : null,
      taskClaimedAt: current!.activeTaskId === taskId ? queued!.claimedAt : null,
      taskLeaseExpiresAt: current!.activeTaskId === taskId ? queued!.leaseExpiresAt : null,
    }),
  }, { headers: noStoreHeaders });
  } finally {
    await releaseNodeOperationLock(db, located.nodeId, operationId);
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401, headers: noStoreHeaders });
  const id = cleanText(new URL(request.url).searchParams.get('id'), 64);
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400, headers: noStoreHeaders });
  await ensureSchema();
  const db = await getDb();
  const [located] = await db.select({ nodeId: nyanpassInstances.nodeId }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!located) return Response.json({ error: '实例不存在' }, { status: 404, headers: noStoreHeaders });
  const operationId = await acquireNodeOperationLock(db, located.nodeId);
  if (operationId === undefined) return Response.json({ error: '所属节点不存在' }, { status: 404, headers: noStoreHeaders });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试取消' }, { status: 409, headers: noStoreHeaders });
  try {
  const [instance] = await db.select({
    id: nyanpassInstances.id,
    nodeId: nyanpassInstances.nodeId,
    name: nyanpassInstances.name,
    status: nyanpassInstances.status,
    activeTaskId: nyanpassInstances.activeTaskId,
    configRevision: nyanpassInstances.configRevision,
  }).from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!instance || instance.status !== 'pending' || !instance.activeTaskId) {
    return Response.json({ error: '只有尚未被探针领取的排队任务可以取消' }, { status: 409, headers: noStoreHeaders });
  }
  const [queuedTask] = await db.select({ status: agentTasks.status, queuedAt: agentTasks.updatedAt }).from(agentTasks).where(and(
    eq(agentTasks.id, instance.activeTaskId),
    eq(agentTasks.nodeId, instance.nodeId),
  )).limit(1);
  if (!queuedTask || queuedTask.status !== 'queued') {
    return Response.json({ error: '探针已经领取任务，不能远程取消安装' }, { status: 409, headers: noStoreHeaders });
  }
  const now = new Date(Math.max(Date.now(), queuedTask.queuedAt.getTime() + 1));
  const taskCanceled = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.id, instance.activeTaskId),
    eq(agentTasks.status, 'canceled'),
    eq(agentTasks.updatedAt, now),
  )));
  await db.batch([
    db.update(agentTasks).set({
      status: 'canceled',
      errorCode: 'canceled_by_admin',
      errorMessage: '管理员在探针领取前取消了排队',
      updatedAt: now,
      finishedAt: now,
    }).where(and(
      eq(agentTasks.id, instance.activeTaskId),
      eq(agentTasks.nodeId, instance.nodeId),
      eq(agentTasks.status, 'queued'),
      eq(agentTasks.updatedAt, queuedTask.queuedAt),
    )),
    db.update(nyanpassInstances).set({ status: 'ready', activeTaskId: null, syncError: '排队已取消，配置仍可再次同步', updatedAt: now }).where(and(
      eq(nyanpassInstances.id, id),
      eq(nyanpassInstances.status, 'pending'),
      eq(nyanpassInstances.activeTaskId, instance.activeTaskId),
      eq(nyanpassInstances.configRevision, instance.configRevision),
      taskCanceled,
    )),
  ]);
  const [task] = await db.select({ status: agentTasks.status, updatedAt: agentTasks.updatedAt }).from(agentTasks).where(eq(agentTasks.id, instance.activeTaskId)).limit(1);
  if (task?.status !== 'canceled' || task.updatedAt.getTime() !== now.getTime()) {
    return Response.json({ error: '探针已经领取任务，不能远程取消安装' }, { status: 409, headers: noStoreHeaders });
  }
  await db.insert(events).values({ nodeId: instance.nodeId, kind: 'nyanpass_sync_canceled', message: `${user.email} 取消了实例 ${instance.name} 的排队任务`, createdAt: now });
  return Response.json({ status: 'ok' }, { headers: noStoreHeaders });
  } finally {
    await releaseNodeOperationLock(db, located.nodeId, operationId);
  }
}

function supportsRemoteSync(version: string | null) {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 8;
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
  syncError: string | null;
  activeTaskId: string | null;
  lastReportedAt: Date | null;
  configRevision: number;
  hasCredential: boolean;
  taskStatus: string | null;
  taskCreatedAt: Date | null;
  taskClaimedAt: Date | null;
  taskLeaseExpiresAt: Date | null;
}) {
  return {
    id: instance.id,
    nodeId: instance.nodeId,
    nodeName: instance.nodeName ?? '已删除节点',
    name: instance.name,
    role: instance.role,
    panelUrl: instance.panelUrl,
    optimize: instance.optimize,
    status: instance.status,
    lastReportedAt: instance.lastReportedAt?.toISOString() ?? null,
    syncError: instance.syncError,
    activeTaskId: instance.activeTaskId,
    configRevision: instance.configRevision,
    hasCredential: instance.hasCredential,
    taskStatus: instance.taskStatus,
    taskCreatedAt: instance.taskCreatedAt?.toISOString() ?? null,
    taskClaimedAt: instance.taskClaimedAt?.toISOString() ?? null,
    taskLeaseExpiresAt: instance.taskLeaseExpiresAt?.toISOString() ?? null,
  };
}
