import { and, eq, exists, gt, isNull, lt, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '@/db';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';

const queuedLifetimeMs = 5 * 60 * 1000;

export async function expireAgentTasks(
  db: Awaited<ReturnType<typeof getDb>>,
  now: Date,
  nodeId?: string,
) {
  const queuedCutoff = new Date(now.getTime() - queuedLifetimeMs);
  const runningTask = alias(agentTasks, 'running_task');
  const queuedConditions = [
    eq(agentTasks.status, 'queued'),
    // updatedAt is the current enqueue time; a canceled/failed task may be
    // deliberately queued again without losing its stable task id.
    lt(agentTasks.updatedAt, queuedCutoff),
    // A healthy probe may legitimately be busy installing another instance
    // for up to ten minutes. Only classify the queue as offline once its task
    // heartbeat is stale and there is no currently running job on that node.
    or(isNull(nodes.lastTaskPollAt), lt(nodes.lastTaskPollAt, queuedCutoff))!,
    notExists(db.select({ id: runningTask.id }).from(runningTask).where(and(
      eq(runningTask.nodeId, agentTasks.nodeId),
      eq(runningTask.status, 'running'),
      gt(runningTask.leaseExpiresAt, now),
    ))),
  ];
  const runningConditions = [eq(agentTasks.status, 'running'), lt(agentTasks.leaseExpiresAt, now)];
  if (nodeId) {
    queuedConditions.push(eq(agentTasks.nodeId, nodeId));
    runningConditions.push(eq(agentTasks.nodeId, nodeId));
  }

  const staleQueued = await db.select({
    id: agentTasks.id,
    nodeId: agentTasks.nodeId,
    instanceId: agentTasks.instanceId,
    revision: agentTasks.revision,
    queuedAt: agentTasks.updatedAt,
  }).from(agentTasks).innerJoin(nodes, eq(agentTasks.nodeId, nodes.id)).where(and(...queuedConditions));
  for (const task of staleQueued) {
    const nodeStillOffline = exists(db.select({ id: nodes.id }).from(nodes).where(and(
      eq(nodes.id, task.nodeId),
      or(isNull(nodes.lastTaskPollAt), lt(nodes.lastTaskPollAt, queuedCutoff)),
    )));
    const nodeStillIdle = notExists(db.select({ id: runningTask.id }).from(runningTask).where(and(
      eq(runningTask.nodeId, task.nodeId),
      eq(runningTask.status, 'running'),
      gt(runningTask.leaseExpiresAt, now),
    )));
    const queueTimedOut = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
      eq(agentTasks.id, task.id),
      eq(agentTasks.status, 'failed'),
      eq(agentTasks.errorCode, 'queue_timeout'),
    )));
    await db.batch([
      db.update(agentTasks).set({
        status: 'failed',
        errorCode: 'queue_timeout',
        errorMessage: '探针 5 分钟内未领取任务',
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(agentTasks.id, task.id),
        eq(agentTasks.status, 'queued'),
        eq(agentTasks.updatedAt, task.queuedAt),
        lt(agentTasks.updatedAt, queuedCutoff),
        nodeStillOffline,
        nodeStillIdle,
      )),
      db.update(nyanpassInstances).set({
        status: 'failed',
        syncError: '探针 5 分钟内未领取，排队已自动结束；确认探针在线后可重试',
        updatedAt: now,
      }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.status, 'pending'),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        queueTimedOut,
      )),
    ]);
    const [changed] = await db.select({ status: agentTasks.status, errorCode: agentTasks.errorCode, updatedAt: agentTasks.updatedAt })
      .from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
    if (changed?.status === 'failed' && changed.errorCode === 'queue_timeout' && changed.updatedAt.getTime() === now.getTime()) {
      await db.insert(events).values({
        nodeId: task.nodeId,
        level: 'error',
        kind: 'nyanpass_sync_failed',
        message: 'Nyanpass 同步任务 5 分钟内未被探针领取，排队已自动结束',
        createdAt: now,
      });
    }
  }

  const expiredRunning = await db.select({
    id: agentTasks.id,
    nodeId: agentTasks.nodeId,
    instanceId: agentTasks.instanceId,
    revision: agentTasks.revision,
  }).from(agentTasks).where(and(...runningConditions));
  for (const task of expiredRunning) {
    const leaseExpired = exists(db.select({ id: agentTasks.id }).from(agentTasks).where(and(
      eq(agentTasks.id, task.id),
      eq(agentTasks.status, 'uncertain'),
      eq(agentTasks.errorCode, 'lease_expired'),
    )));
    await db.batch([
      db.update(agentTasks).set({
        status: 'uncertain',
        errorCode: 'lease_expired',
        errorMessage: '探针未在租约内回传结果；仍接受原租约的晚到回执',
        updatedAt: now,
        finishedAt: now,
      }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'running'), lt(agentTasks.leaseExpiresAt, now))),
      db.update(nyanpassInstances).set({
        status: 'uncertain',
        credentialCiphertext: null,
        syncError: '执行结果未知；主控仍会接受该任务的晚到回执，请勿直接重复安装',
        updatedAt: now,
      }).where(and(
        eq(nyanpassInstances.id, task.instanceId),
        eq(nyanpassInstances.status, 'running'),
        eq(nyanpassInstances.activeTaskId, task.id),
        eq(nyanpassInstances.configRevision, task.revision),
        leaseExpired,
      )),
    ]);
    const [changed] = await db.select({ status: agentTasks.status, errorCode: agentTasks.errorCode, updatedAt: agentTasks.updatedAt })
      .from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
    if (changed?.status === 'uncertain' && changed.errorCode === 'lease_expired' && changed.updatedAt.getTime() === now.getTime()) {
      await db.insert(events).values({
        nodeId: task.nodeId,
        level: 'error',
        kind: 'nyanpass_sync_uncertain',
        message: 'Nyanpass 同步租约超时，结果暂时未知；等待探针晚到回执',
        createdAt: now,
      });
    }
  }
}
