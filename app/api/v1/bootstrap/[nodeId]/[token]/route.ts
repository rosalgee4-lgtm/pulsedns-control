import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { nodes } from '@/db/schema';
import { decryptBootstrapPayload } from '@/lib/bootstrap-payload';
import { bootstrapDownloadWindow } from '@/lib/bootstrap-download';
import { buildNodeBootstrapConfig, MAX_BOOTSTRAP_RESPONSE_BYTES } from '@/lib/install-command';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { trustedNyanpassRelease } from '@/lib/nyanpass-release';
import { publicOrigin } from '@/lib/public-origin';
import { sha256 } from '@/lib/security';

const downloadableStatuses = new Set(['awaiting', 'provisioning', 'failed', 'uncertain']);
const noStoreHeaders = {
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function GET(
  request: Request,
  context: { params: Promise<{ nodeId: string; token: string }> },
) {
  const { nodeId, token } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nodeId)
    || !/^pbs_[a-f0-9]{64}$/.test(token)) return notFound();

  await ensureSchema();
  const db = await getDb();
  const tokenHash = await sha256(token);
  const [located] = await db.select({ id: nodes.id }).from(nodes).where(and(
    eq(nodes.id, nodeId),
    eq(nodes.bootstrapDownloadTokenHash, tokenHash),
  )).limit(1);
  if (!located) return notFound();

  const operationId = await acquireNodeOperationLock(db, nodeId);
  if (!operationId) return temporarilyUnavailable();
  try {
    const [node] = await db.select({
      id: nodes.id,
      status: nodes.nyanpassStatus,
      generation: nodes.provisionGeneration,
      payloadCiphertext: nodes.bootstrapPayloadCiphertext,
      downloadExpiresAt: nodes.bootstrapDownloadExpiresAt,
      downloadConsumedAt: nodes.bootstrapDownloadConsumedAt,
    }).from(nodes).where(and(
      eq(nodes.id, nodeId),
      eq(nodes.bootstrapDownloadTokenHash, tokenHash),
    )).limit(1);
    if (!node?.payloadCiphertext || !downloadableStatuses.has(node.status)) return notFound();

    const now = new Date();
    const downloadWindow = bootstrapDownloadWindow(node.downloadExpiresAt, node.downloadConsumedAt, now);
    if (!downloadWindow.allowed) {
      await db.update(nodes).set({ bootstrapDownloadTokenHash: null }).where(and(
        eq(nodes.id, node.id),
        eq(nodes.bootstrapDownloadTokenHash, tokenHash),
      ));
      return notFound();
    }
    let payload;
    try {
      payload = await decryptBootstrapPayload(node.payloadCiphertext, { nodeId: node.id, generation: node.generation });
    } catch {
      return notFound();
    }
    let nyanpassRelease;
    try {
      nyanpassRelease = await trustedNyanpassRelease();
    } catch {
      return new Response('Nyanpass trusted release manifest is unavailable.\n', { status: 503, headers: noStoreHeaders });
    }
    const config = buildNodeBootstrapConfig({
      nodeId: node.id,
      generation: node.generation,
      origin: publicOrigin(request),
      token: payload.agentToken,
      rootPassword: payload.rootPassword,
      instances: payload.instances,
      nyanpassRelease,
    });
    if (new TextEncoder().encode(config).byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) {
      return new Response('节点配置数据超过 64 KiB 服务端安全上限，请联系管理员更新配置。\n', { status: 409, headers: noStoreHeaders });
    }
    if (downloadWindow.shouldConsume) {
      const [consumed] = await db.update(nodes).set({ bootstrapDownloadConsumedAt: now }).where(and(
        eq(nodes.id, node.id),
        eq(nodes.bootstrapDownloadTokenHash, tokenHash),
        isNull(nodes.bootstrapDownloadConsumedAt),
      )).returning({ id: nodes.id });
      if (!consumed) return notFound();
    }
    return new Response(config, {
      headers: {
        ...noStoreHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="pulsedns-${node.id}.config"`,
      },
    });
  } finally {
    await releaseNodeOperationLock(db, nodeId, operationId);
  }
}

function notFound() {
  return new Response('Not Found\n', { status: 404, headers: noStoreHeaders });
}

function temporarilyUnavailable() {
  return new Response('Temporarily unavailable\n', { status: 503, headers: { ...noStoreHeaders, 'Retry-After': '2' } });
}
