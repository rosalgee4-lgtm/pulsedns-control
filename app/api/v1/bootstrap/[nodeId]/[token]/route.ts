import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { nodes } from '@/db/schema';
import { decryptBootstrapPayload } from '@/lib/bootstrap-payload';
import { buildNodeStartupScript, MAX_BOOTSTRAP_RESPONSE_BYTES } from '@/lib/install-command';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
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
    const script = buildNodeStartupScript({
      nodeId: node.id,
      generation: node.generation,
      origin: publicOrigin(request),
      token: payload.agentToken,
      rootPassword: payload.rootPassword,
      instances: payload.instances,
    });
    if (new TextEncoder().encode(script).byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) {
      return new Response('完整安装脚本超过 64 KiB 服务端安全上限，请联系管理员更新配置。\n', { status: 409, headers: noStoreHeaders });
    }
    return new Response(script, {
      headers: {
        ...noStoreHeaders,
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Content-Disposition': `attachment; filename="pulsedns-${node.id}.sh"`,
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
