import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { nodes } from '@/db/schema';
import { decryptBootstrapPayload } from '@/lib/bootstrap-payload';
import { buildNodeBootstrapConfig, MAX_BOOTSTRAP_RESPONSE_BYTES } from '@/lib/install-command';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { trustedNyanpassRelease } from '@/lib/nyanpass-release';
import { publicOrigin } from '@/lib/public-origin';
import { sha256 } from '@/lib/security';

// 'ready' 也可下载：Spot 实例被替换后，新机器用同一份 User data 重新安装。
const downloadableStatuses = new Set(['awaiting', 'provisioning', 'failed', 'uncertain', 'ready']);
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
    }).from(nodes).where(and(
      eq(nodes.id, nodeId),
      eq(nodes.bootstrapDownloadTokenHash, tokenHash),
    )).limit(1);
    if (!node?.payloadCiphertext || !downloadableStatuses.has(node.status)) return notFound();

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
