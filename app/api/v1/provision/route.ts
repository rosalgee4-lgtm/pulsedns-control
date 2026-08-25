import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes, nyanpassInstances } from '@/db/schema';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { expireProvisionAttempts } from '@/lib/provision-lifecycle';
import { bearerToken, sha256 } from '@/lib/security';
import { cleanText } from '@/lib/validation';

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };
const provisionLeaseMs = 2 * 60 * 1000;
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ProvisionPhase = 'start' | 'heartbeat' | 'finish';
type ProvisionOutcome = 'succeeded' | 'failed';

export async function POST(request: Request) {
  const token = request.headers.get('x-secret-token')?.trim() || bearerToken(request.headers.get('authorization'));
  if (!token) return errorResponse('无效的探针凭据', 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return errorResponse('回执格式无效', 400);
  const phase = body.phase as ProvisionPhase;
  const allowedKeys = phase === 'finish'
    ? new Set(['protocol', 'phase', 'generation', 'attemptId', 'outcome'])
    : new Set(['protocol', 'phase', 'generation', 'attemptId']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return errorResponse('回执格式无效', 400);
  const generation = body.generation;
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
  const outcome = body.outcome as ProvisionOutcome | undefined;
  if (body.protocol !== 1 || !['start', 'heartbeat', 'finish'].includes(phase)
    || !Number.isSafeInteger(generation) || Number(generation) < 1 || !attemptPattern.test(attemptId)) {
    return errorResponse('回执参数无效', 400);
  }
  if ((phase === 'finish' && outcome !== 'succeeded' && outcome !== 'failed') || (phase !== 'finish' && body.outcome !== undefined)) {
    return errorResponse('回执结果无效', 400);
  }

  await ensureSchema();
  const db = await getDb();
  const tokenHash = await sha256(token);
  const [authenticated] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.tokenHash, tokenHash)).limit(1);
  if (!authenticated) return errorResponse('未知探针', 401);
  const operationId = await acquireNodeOperationLock(db, authenticated.id);
  if (operationId === undefined) return errorResponse('未知探针', 401);
  if (operationId === null) return errorResponse('节点正在处理其他操作，请稍后重试', 409);
  try {
  const now = new Date();
  await expireProvisionAttempts(db, now, authenticated.id);
  const [node] = await db.select().from(nodes).where(eq(nodes.id, authenticated.id)).limit(1);
  if (!node) return errorResponse('未知探针', 401);
  const numericGeneration = Number(generation);
  if (node.provisionGeneration !== numericGeneration) return okResponse('stale');
  const agentVersion = cleanText(request.headers.get('x-agent-version'), 30) || node.agentVersion;

  if (phase === 'start') {
    if (node.nyanpassStatus === 'ready') return okResponse('stale');
    const leaseExpiresAt = new Date(now.getTime() + provisionLeaseMs);
    if (node.nyanpassStatus === 'awaiting' || node.nyanpassStatus === 'failed') {
      const [transitioned] = await db.batch([
        db.update(nodes).set({
          nyanpassStatus: 'provisioning',
          provisionAttemptId: attemptId,
          provisionLeaseExpiresAt: leaseExpiresAt,
          agentVersion,
          updatedAt: now,
        }).where(and(
          eq(nodes.id, node.id),
          eq(nodes.provisionGeneration, numericGeneration),
          eq(nodes.nyanpassStatus, node.nyanpassStatus),
        )).returning({ id: nodes.id }),
        db.insert(events).values({ nodeId: node.id, kind: 'nyanpass_bootstrap_started', message: `节点 ${node.name} 开始执行开机安装`, createdAt: now }),
      ]);
      if (transitioned.length) {
        return okResponse('accepted');
      }
    }
    const [current] = await db.select({ status: nodes.nyanpassStatus, attemptId: nodes.provisionAttemptId }).from(nodes).where(eq(nodes.id, node.id)).limit(1);
    if (current?.status === 'provisioning' && current.attemptId === attemptId) {
      await db.update(nodes).set({ provisionLeaseExpiresAt: leaseExpiresAt, agentVersion, updatedAt: now }).where(and(eq(nodes.id, node.id), eq(nodes.provisionAttemptId, attemptId), eq(nodes.nyanpassStatus, 'provisioning')));
      return okResponse('duplicate');
    }
    if (current?.status === 'uncertain' && current.attemptId === attemptId) {
      await db.update(nodes).set({ nyanpassStatus: 'provisioning', provisionLeaseExpiresAt: leaseExpiresAt, agentVersion, updatedAt: now }).where(and(eq(nodes.id, node.id), eq(nodes.provisionAttemptId, attemptId), eq(nodes.nyanpassStatus, 'uncertain')));
      return okResponse('duplicate');
    }
    return okResponse(current?.status === 'uncertain' ? 'busy' : 'conflict');
  }

  if (node.provisionAttemptId !== attemptId) return okResponse('stale');
  if (phase === 'heartbeat') {
    if (node.nyanpassStatus === 'ready' || node.nyanpassStatus === 'failed') return okResponse('duplicate');
    if (node.nyanpassStatus !== 'provisioning' && node.nyanpassStatus !== 'uncertain') return okResponse('conflict');
    const leaseExpiresAt = new Date(now.getTime() + provisionLeaseMs);
    await db.update(nodes).set({ nyanpassStatus: 'provisioning', provisionLeaseExpiresAt: leaseExpiresAt, agentVersion, updatedAt: now }).where(and(
      eq(nodes.id, node.id),
      eq(nodes.provisionGeneration, numericGeneration),
      eq(nodes.provisionAttemptId, attemptId),
      inArray(nodes.nyanpassStatus, ['provisioning', 'uncertain']),
    ));
    return okResponse('accepted');
  }

  return finishProvision(db, node, numericGeneration, attemptId, outcome!, agentVersion, now);
  } finally {
    await releaseNodeOperationLock(db, authenticated.id, operationId);
  }
}

async function finishProvision(
  db: Awaited<ReturnType<typeof getDb>>,
  node: typeof nodes.$inferSelect,
  generation: number,
  attemptId: string,
  outcome: ProvisionOutcome,
  agentVersion: string | null,
  now: Date,
) {
  const targetStatus = outcome === 'succeeded' ? 'ready' : 'failed';
  if ((node.nyanpassStatus === 'ready' || node.nyanpassStatus === 'failed') && node.nyanpassStatus !== targetStatus) {
    return okResponse('conflict');
  }
  const instanceUpdate = outcome === 'succeeded'
    ? db.update(nyanpassInstances).set({ status: 'success', syncError: null, lastReportedAt: now, updatedAt: now }).where(and(
      eq(nyanpassInstances.nodeId, node.id),
      eq(nyanpassInstances.bootstrapGeneration, generation),
      eq(nyanpassInstances.configRevision, 0),
      isNull(nyanpassInstances.activeTaskId),
      inArray(nyanpassInstances.status, ['bootstrap', 'uncertain']),
    ))
    : db.update(nyanpassInstances).set({
      status: 'uncertain',
      syncError: '开机安装未完整成功；请先检查 VPS 和 /var/log/pulsedns-bootstrap.log，再按日志提示重试',
      updatedAt: now,
    }).where(and(
      eq(nyanpassInstances.nodeId, node.id),
      eq(nyanpassInstances.bootstrapGeneration, generation),
      eq(nyanpassInstances.configRevision, 0),
      isNull(nyanpassInstances.activeTaskId),
      inArray(nyanpassInstances.status, ['bootstrap', 'uncertain']),
    ));

  if (node.nyanpassStatus === targetStatus) {
    if (outcome === 'succeeded') {
      await db.batch([
        db.update(nodes).set({
          bootstrapPayloadCiphertext: null,
          bootstrapDownloadTokenHash: null,
          updatedAt: now,
        }).where(and(
          eq(nodes.id, node.id),
          eq(nodes.provisionGeneration, generation),
          eq(nodes.provisionAttemptId, attemptId),
          eq(nodes.nyanpassStatus, 'ready'),
        )),
        instanceUpdate,
      ]);
    } else {
      await instanceUpdate;
    }
    return okResponse('duplicate');
  }
  const [transitioned] = await db.batch([
    db.update(nodes).set({
      nyanpassStatus: targetStatus,
      provisionLeaseExpiresAt: null,
      ...(outcome === 'succeeded' ? {
        bootstrapPayloadCiphertext: null,
        bootstrapDownloadTokenHash: null,
      } : {}),
      agentVersion,
      updatedAt: now,
    }).where(and(
      eq(nodes.id, node.id),
      eq(nodes.provisionGeneration, generation),
      eq(nodes.provisionAttemptId, attemptId),
      inArray(nodes.nyanpassStatus, ['provisioning', 'uncertain']),
    )).returning({ id: nodes.id }),
    instanceUpdate,
    db.insert(events).values({
      nodeId: node.id,
      level: outcome === 'succeeded' ? 'info' : 'error',
      kind: outcome === 'succeeded' ? 'nyanpass_bootstrap_succeeded' : 'nyanpass_bootstrap_failed',
      message: outcome === 'succeeded'
        ? `节点 ${node.name} 的开机安装与全部预配 Nyanpass 实例已完成`
        : `节点 ${node.name} 的开机安装未完整成功，预配实例结果需要在 VPS 核查`,
      createdAt: now,
    }),
  ]);
  if (!transitioned.length) return okResponse('conflict');
  return okResponse('accepted');
}

function okResponse(disposition: 'accepted' | 'duplicate' | 'stale' | 'busy' | 'conflict') {
  return Response.json({ status: 'ok', disposition }, { headers: noStoreHeaders });
}

function errorResponse(error: string, status: number) {
  return Response.json({ status: 'error', error }, { status, headers: noStoreHeaders });
}
