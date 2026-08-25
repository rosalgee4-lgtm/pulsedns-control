import { and, asc, eq, exists, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { expireAgentTasks } from '@/lib/agent-task-lifecycle';
import { decryptNyanpassCredential } from '@/lib/nyanpass-credential';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { bearerToken, newAgentToken, sha256 } from '@/lib/security';
import { cleanText } from '@/lib/validation';
import { expireProvisionAttempts, isBootstrapLocked } from '@/lib/provision-lifecycle';

const leaseDurationMs = 20 * 60 * 1000;
const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };
const failureMessages: Record<string, string> = {
  installer_download: 'Nyanpass 官方安装器下载失败',
  installer_invalid: '下载的安装器未通过校验',
  validation_failed: '探针拒绝了无效的结构化任务参数',
  install_failed: 'Nyanpass 官方安装器返回失败，机器可能已发生部分变更',
  install_timeout: 'Nyanpass 安装超过 10 分钟，机器可能仍有部分变更',
  local_state: '探针在重启后发现未完成的本地任务状态',
};
const retryableFailureCodes = new Set(['installer_download', 'installer_invalid', 'validation_failed']);
const uncertainFailureCodes = new Set(['install_failed', 'install_timeout', 'local_state']);

export async function GET(request: Request) {
  const authenticated = await authenticateAgent(request);
  if ('response' in authenticated) return authenticated.response;
  const { db, node } = authenticated;
  const operationId = await acquireNodeOperationLock(db, node.id);
  if (!operationId) return idleResponse();
  try {
  const now = new Date();
  const agentVersion = cleanText(request.headers.get('x-agent-version'), 30);

  // Expire against the heartbeat that existed when this request authenticated.
  // Refreshing first would let a probe that was offline for hours claim a stale
  // queued install before the five-minute safety window can close it.
  await expireAgentTasks(db, now, node.id);
  await expireProvisionAttempts(db, now, node.id);
  if (!node.lastTaskPollAt || now.getTime() - node.lastTaskPollAt.getTime() >= 60_000 || (agentVersion && agentVersion !== node.agentVersion)) {
    await db.update(nodes).set({ lastTaskPollAt: now, agentVersion: agentVersion || node.agentVersion, updatedAt: now }).where(eq(nodes.id, node.id));
  }
  // The probe service is started before the original bootstrap Nyanpass batch
  // finishes. Never lease Web-added work until that batch has reported a
  // terminal outcome; the machine-side flock is a second serialization layer.
  const [provisionState] = await db.select({ status: nodes.nyanpassStatus }).from(nodes).where(eq(nodes.id, node.id)).limit(1);
  if (provisionState && isBootstrapLocked(provisionState.status)) return idleResponse();

  const [alreadyRunning] = await db.select({ id: agentTasks.id }).from(agentTasks)
    .where(and(eq(agentTasks.nodeId, node.id), eq(agentTasks.status, 'running'))).limit(1);
  if (alreadyRunning) return idleResponse();

  const [task] = await db.select({
    id: agentTasks.id,
    instanceId: agentTasks.instanceId,
    revision: agentTasks.revision,
    name: nyanpassInstances.name,
    role: nyanpassInstances.role,
    panelUrl: nyanpassInstances.panelUrl,
    optimize: nyanpassInstances.optimize,
    credentialCiphertext: nyanpassInstances.credentialCiphertext,
    activeTaskId: nyanpassInstances.activeTaskId,
    instanceRevision: nyanpassInstances.configRevision,
  }).from(agentTasks).innerJoin(nyanpassInstances, eq(agentTasks.instanceId, nyanpassInstances.id))
    .where(and(eq(agentTasks.nodeId, node.id), eq(agentTasks.status, 'queued'))).orderBy(asc(agentTasks.createdAt)).limit(1);

  if (!task) return idleResponse();
  if (task.activeTaskId !== task.id || task.instanceRevision !== task.revision || !task.credentialCiphertext) {
    await failInvalidTask(db, node.id, task.id, task.instanceId, task.revision, now);
    return idleResponse();
  }

  let clientToken = '';
  try {
    clientToken = await decryptNyanpassCredential(task.credentialCiphertext, { nodeId: node.id, instanceId: task.instanceId, revision: task.revision });
  } catch {
    await failInvalidTask(db, node.id, task.id, task.instanceId, task.revision, now);
    return idleResponse();
  }

  const leaseToken = newAgentToken();
  const leaseTokenHash = await sha256(leaseToken);
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const taskWasClaimed = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.id, task.id),
    eq(agentTasks.nodeId, node.id),
    eq(agentTasks.status, 'running'),
    eq(agentTasks.leaseTokenHash, leaseTokenHash),
  )));
  try {
    await db.batch([
      db.update(agentTasks).set({
        status: 'running',
        leaseTokenHash,
        leaseExpiresAt,
        attempts: 1,
        claimedAt: now,
        updatedAt: now,
        finishedAt: null,
      }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.nodeId, node.id), eq(agentTasks.status, 'queued'))),
      db.update(nyanpassInstances).set({ status: 'running', syncError: null, updatedAt: now }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.status, 'pending'),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        taskWasClaimed,
      )),
    ]);
  } catch {
    return idleResponse();
  }
  const [claimed] = await db.select({ status: agentTasks.status, leaseTokenHash: agentTasks.leaseTokenHash })
    .from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
  if (claimed?.status !== 'running' || claimed.leaseTokenHash !== leaseTokenHash) return idleResponse();

  // The task is already leased. An audit-write failure must not strand the
  // probe without the payload/lease it needs to finish and acknowledge it.
  await db.insert(events).values({ nodeId: node.id, kind: 'nyanpass_sync_started', message: `探针已领取实例 ${task.name} 的同步任务`, createdAt: now }).catch(() => undefined);
  return Response.json({
    status: 'job',
    protocol: 1,
    job: {
      id: task.id,
      action: 'nyanpass_apply_v1',
      revision: task.revision,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      payload: {
        instanceId: task.instanceId,
        serviceName: task.name,
        role: task.role,
        panelUrl: task.panelUrl,
        clientToken,
        optimize: task.optimize,
      },
    },
  }, { headers: noStoreHeaders });
  } finally {
    await releaseNodeOperationLock(db, node.id, operationId);
  }
}

export async function POST(request: Request) {
  const authenticated = await authenticateAgent(request);
  if ('response' in authenticated) return authenticated.response;
  const { db, node } = authenticated;
  const operationId = await acquireNodeOperationLock(db, node.id);
  if (operationId === undefined) return errorResponse('未知探针', 401);
  // The probe treats 429 as transient and retains the durable local ACK.
  // A 409 is reserved for an actually invalid lease and is rejected locally.
  if (operationId === null) return errorResponse('节点正在处理其他操作，请稍后重试回执', 429);
  try {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).some((key) => !['jobId', 'leaseToken', 'outcome', 'errorCode'].includes(key))) {
    return errorResponse('回执格式无效', 400);
  }
  const jobId = cleanText(body.jobId, 64);
  const leaseToken = typeof body.leaseToken === 'string' ? body.leaseToken : '';
  const outcome = body.outcome;
  const errorCode = cleanText(body.errorCode, 40);
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !/^pd_[a-f0-9]{64}$/.test(leaseToken) || !['succeeded', 'failed', 'uncertain'].includes(String(outcome))) {
    return errorResponse('回执参数无效', 400);
  }
  if (outcome === 'succeeded' && errorCode) return errorResponse('成功回执不能包含失败代码', 400);
  if (outcome === 'failed' && !retryableFailureCodes.has(errorCode)) return errorResponse('失败代码无效', 400);
  if (outcome === 'uncertain' && !uncertainFailureCodes.has(errorCode)) return errorResponse('未知结果代码无效', 400);

  const [task] = await db.select().from(agentTasks).where(and(eq(agentTasks.id, jobId), eq(agentTasks.nodeId, node.id))).limit(1);
  if (!task) return errorResponse('任务不存在', 404);
  const normalizedOutcome = outcome as 'succeeded' | 'failed' | 'uncertain';
  if (task.status === normalizedOutcome) {
    let terminalErrorCode = task.errorCode ?? '';
    if (task.status === 'uncertain' && task.leaseTokenHash) {
      if (task.leaseTokenHash !== await sha256(leaseToken)) return errorResponse('任务租约无效', 409);
      const acknowledgedAt = new Date();
      terminalErrorCode = errorCode;
      await db.update(agentTasks).set({
        leaseTokenHash: null,
        leaseExpiresAt: null,
        errorCode,
        errorMessage: failureMessages[errorCode],
        updatedAt: acknowledgedAt,
        finishedAt: acknowledgedAt,
      }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'uncertain'), eq(agentTasks.leaseTokenHash, task.leaseTokenHash)));
    }
    await reconcileTerminalInstance(db, task, normalizedOutcome, terminalErrorCode, new Date());
    return okResponse();
  }
  if ((task.status !== 'running' && task.status !== 'uncertain') || !task.leaseTokenHash || task.leaseTokenHash !== await sha256(leaseToken)) {
    return errorResponse('任务租约无效', 409);
  }

  const [instance] = await db.select({
    id: nyanpassInstances.id,
    name: nyanpassInstances.name,
    activeTaskId: nyanpassInstances.activeTaskId,
    configRevision: nyanpassInstances.configRevision,
  }).from(nyanpassInstances).where(eq(nyanpassInstances.id, task.instanceId)).limit(1);
  const now = new Date();
  const errorMessage = normalizedOutcome === 'succeeded' ? null : failureMessages[errorCode];
  const taskTransitioned = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.id, task.id),
    eq(agentTasks.status, normalizedOutcome),
    eq(agentTasks.updatedAt, now),
  )));
  const instanceMatches = Boolean(instance && instance.activeTaskId === task.id && instance.configRevision === task.revision);
  const taskUpdate = db.update(agentTasks).set({
    status: normalizedOutcome,
    leaseTokenHash: null,
    leaseExpiresAt: null,
    errorCode: normalizedOutcome === 'succeeded' ? null : errorCode,
    errorMessage,
    updatedAt: now,
    finishedAt: now,
  }).where(and(
    eq(agentTasks.id, task.id),
    eq(agentTasks.nodeId, node.id),
    inArray(agentTasks.status, ['running', 'uncertain']),
    eq(agentTasks.leaseTokenHash, task.leaseTokenHash),
  ));
  const nodeUpdate = db.update(nodes).set({
    lastTaskPollAt: now,
    agentVersion: cleanText(request.headers.get('x-agent-version'), 30) || node.agentVersion,
    updatedAt: now,
  }).where(eq(nodes.id, node.id));

  if (instanceMatches && normalizedOutcome === 'succeeded') {
    await db.batch([
      taskUpdate,
      db.update(nyanpassInstances).set({
        status: 'success',
        credentialCiphertext: null,
        activeTaskId: null,
        syncError: null,
        lastReportedAt: now,
        updatedAt: now,
      }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        taskTransitioned,
      )),
      nodeUpdate,
    ]);
  } else if (instanceMatches && normalizedOutcome === 'failed') {
    await db.batch([
      taskUpdate,
      db.update(nyanpassInstances).set({ status: 'failed', syncError: errorMessage, updatedAt: now }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        taskTransitioned,
      )),
      nodeUpdate,
    ]);
  } else if (instanceMatches) {
    await db.batch([
      taskUpdate,
      db.update(nyanpassInstances).set({
        status: 'uncertain',
        credentialCiphertext: null,
        syncError: `${errorMessage}；请检查 VPS 后再决定是否重新提交`,
        updatedAt: now,
      }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        taskTransitioned,
      )),
      nodeUpdate,
    ]);
  } else {
    await db.batch([taskUpdate, nodeUpdate]);
  }

  const [transitioned] = await db.select({ status: agentTasks.status, updatedAt: agentTasks.updatedAt })
    .from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
  if (transitioned?.status !== normalizedOutcome || transitioned.updatedAt.getTime() !== now.getTime()) {
    if (transitioned?.status === normalizedOutcome) {
      await reconcileTerminalInstance(db, task, normalizedOutcome, errorCode, now);
      return okResponse();
    }
    return errorResponse('任务状态已经变化', 409);
  }

  const late = task.status === 'uncertain' || Boolean(task.leaseExpiresAt && task.leaseExpiresAt <= now);
  const eventKind = normalizedOutcome === 'succeeded'
    ? 'nyanpass_sync_succeeded'
    : normalizedOutcome === 'failed' ? 'nyanpass_sync_failed' : 'nyanpass_sync_uncertain';
  const eventLevel = normalizedOutcome === 'succeeded' ? 'info' : 'error';
  const resultLabel = normalizedOutcome === 'succeeded' ? '安装器执行成功' : normalizedOutcome === 'failed' ? `同步失败：${errorMessage}` : `执行结果未知：${errorMessage}`;
  const targetLabel = instanceMatches ? `实例 ${instance?.name ?? task.instanceId}` : '旧版本同步任务';
  await db.insert(events).values({
    nodeId: node.id,
    level: eventLevel,
    kind: eventKind,
    message: `${targetLabel}${late ? '的晚到回执' : ''}：${resultLabel}${instanceMatches ? '' : '；当前配置未被覆盖'}`,
    createdAt: now,
  });
  return okResponse();
  } finally {
    await releaseNodeOperationLock(db, node.id, operationId);
  }
}

async function authenticateAgent(request: Request) {
  const token = request.headers.get('x-secret-token')?.trim() || bearerToken(request.headers.get('authorization'));
  if (!token) return { response: errorResponse('无效的探针凭据', 401) };
  await ensureSchema();
  const db = await getDb();
  const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, await sha256(token))).limit(1);
  if (!node) return { response: errorResponse('未知探针', 401) };
  return { db, node };
}

async function failInvalidTask(
  db: Awaited<ReturnType<typeof getDb>>,
  nodeId: string,
  taskId: string,
  instanceId: string,
  revision: number,
  now: Date,
) {
  const taskFailed = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
    eq(agentTasks.id, taskId),
    eq(agentTasks.status, 'failed'),
    eq(agentTasks.errorCode, 'invalid_config'),
  )));
  await db.batch([
    db.update(agentTasks).set({
      status: 'failed',
      errorCode: 'invalid_config',
      errorMessage: '同步配置无法解密或已经失效',
      updatedAt: now,
      finishedAt: now,
    }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'queued'))),
    db.update(nyanpassInstances).set({
      status: 'failed',
      credentialCiphertext: null,
      activeTaskId: null,
      syncError: '同步配置已失效，请重新粘贴官方命令',
      updatedAt: now,
    }).where(and(
      eq(nyanpassInstances.id, instanceId),
      eq(nyanpassInstances.activeTaskId, taskId),
      eq(nyanpassInstances.configRevision, revision),
      taskFailed,
    )),
  ]);
  await db.insert(events).values({ nodeId, level: 'error', kind: 'nyanpass_sync_failed', message: 'Nyanpass 同步配置无法解密或已经失效', createdAt: now });
}

async function reconcileTerminalInstance(
  db: Awaited<ReturnType<typeof getDb>>,
  task: typeof agentTasks.$inferSelect,
  outcome: 'succeeded' | 'failed' | 'uncertain',
  errorCode: string,
  now: Date,
) {
  const errorMessage = outcome === 'succeeded' ? null : failureMessages[errorCode] ?? task.errorMessage ?? '同步结果未知';
  if (outcome === 'succeeded') {
    await db.update(nyanpassInstances).set({ status: 'success', credentialCiphertext: null, activeTaskId: null, syncError: null, lastReportedAt: task.finishedAt ?? now, updatedAt: now })
      .where(and(eq(nyanpassInstances.id, task.instanceId), eq(nyanpassInstances.activeTaskId, task.id), eq(nyanpassInstances.configRevision, task.revision)));
  } else if (outcome === 'failed') {
    await db.update(nyanpassInstances).set({ status: 'failed', syncError: errorMessage, updatedAt: now })
      .where(and(eq(nyanpassInstances.id, task.instanceId), eq(nyanpassInstances.activeTaskId, task.id), eq(nyanpassInstances.configRevision, task.revision)));
  } else {
    await db.update(nyanpassInstances).set({ status: 'uncertain', credentialCiphertext: null, syncError: `${errorMessage}；请检查 VPS 后再决定是否重新提交`, updatedAt: now })
      .where(and(eq(nyanpassInstances.id, task.instanceId), eq(nyanpassInstances.activeTaskId, task.id), eq(nyanpassInstances.configRevision, task.revision)));
  }
}

function idleResponse() {
  return Response.json({ status: 'idle', protocol: 1 }, { headers: noStoreHeaders });
}

function okResponse() {
  return Response.json({ status: 'ok' }, { headers: noStoreHeaders });
}

function errorResponse(error: string, status: number) {
  return Response.json({ status: 'error', error }, { status, headers: noStoreHeaders });
}
