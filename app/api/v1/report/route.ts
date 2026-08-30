import { and, eq, gte, like } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes } from '@/db/schema';
import { syncAliDnsRecord } from '@/lib/alidns';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { bearerToken, sha256 } from '@/lib/security';
import { cleanText, validIPv4, validIPv6 } from '@/lib/validation';
import { pruneEventsAfterInsert } from '@/lib/event-retention';

type AddressType = 'A' | 'AAAA';
type ReportBody = {
  ip?: unknown;
  type?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  agentVersion?: unknown;
};

type AddressReport = { type: AddressType; ip: string };
type AppDb = Awaited<ReturnType<typeof getDb>>;

const dnsFailureDedupeMs = 60 * 60 * 1000;

export async function GET(request: Request) {
  const token = request.headers.get('x-secret-token')?.trim() || bearerToken(request.headers.get('authorization'));
  if (!token) return Response.json({ status: 'error', error: '无效的探针凭据' }, { status: 401 });

  await ensureSchema();
  const db = await getDb();
  const [node] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.tokenHash, await sha256(token))).limit(1);
  if (!node) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });
  return Response.json({ status: 'ok' });
}

export async function POST(request: Request) {
  const token = request.headers.get('x-secret-token')?.trim() || bearerToken(request.headers.get('authorization'));
  if (!token) return Response.json({ status: 'error', error: '无效的探针凭据' }, { status: 401 });

  await ensureSchema();
  const db = await getDb();
  const [authenticatedNode] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.tokenHash, await sha256(token))).limit(1);
  if (!authenticatedNode) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });

  const body = await request.json().catch(() => null) as ReportBody | null;
  if (!body) return Response.json({ status: 'error', error: 'JSON 请求无效' }, { status: 400 });

  const parsed = parseReports(body);
  if ('error' in parsed) return Response.json({ status: 'error', error: parsed.error }, { status: 400 });

  const operationId = await acquireNodeOperationLock(db, authenticatedNode.id);
  if (operationId === undefined) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });
  if (operationId === null) return Response.json({ status: 'error', error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, authenticatedNode.id)).limit(1);
    if (!node) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });
    const now = new Date();
    const failures: string[] = [];
    for (const report of parsed.reports) {
      const [snapshot] = await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1);
      if (!snapshot) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });
      const previous = report.type === 'A' ? snapshot.ipv4 : snapshot.ipv6;
      const record = report.type === 'A' ? snapshot.recordV4 : snapshot.recordV6;
      const hasDnsMapping = Boolean(snapshot.syncEnabled && snapshot.domainName && record);

      if (previous === report.ip && !hasDnsMapping) continue;

      if (hasDnsMapping && snapshot.domainName && record) {
        const result = await syncAliDnsRecord(snapshot.domainName, record, report.type, report.ip);
        if (!result.ok) {
          if (previous !== report.ip) await updateReportedIp(db, node.id, report, now);
          failures.push(`${report.type}: ${result.error}`);
          await logDnsFailure(db, {
            nodeId: node.id,
            type: report.type,
            ip: report.ip,
            recordLabel: record === '@' ? snapshot.domainName : `${record}.${snapshot.domainName}`,
            error: result.error,
            now,
          });
          continue;
        }

        const repairedExistingAddress = previous === report.ip && !('unchanged' in result);
        if (previous !== report.ip) await updateReportedIp(db, node.id, report, now);
        if (previous !== report.ip || repairedExistingAddress) {
          await insertReportEvent(db, {
            nodeId: node.id,
            kind: 'dns_synced',
            message: previous === report.ip
              ? `${report.type} 记录 ${record} 已重新校准`
              : `${report.type} 记录 ${record} 已同步`,
            ipType: report.type,
            ip: report.ip,
            createdAt: now,
          });
        }
        continue;
      }

      await updateReportedIp(db, node.id, report, now);
      await insertReportEvent(db, {
        nodeId: node.id,
        kind: 'ip_changed',
        message: `${report.type} 地址已变化，未绑定 DNS 记录`,
        ipType: report.type,
        ip: report.ip,
        createdAt: now,
      });
    }

    await db.update(nodes).set({
      agentVersion: cleanText(body.agentVersion, 30) || node.agentVersion,
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(nodes.id, node.id));

    if (failures.length) {
      return Response.json({ status: 'error', reportAccepted: true, error: failures.join('；') }, { status: 502 });
    }
    return Response.json({ status: 'ok' });
  } finally {
    await releaseNodeOperationLock(db, authenticatedNode.id, operationId);
  }
}

async function updateReportedIp(db: AppDb, nodeId: string, report: AddressReport, now: Date) {
  await db.update(nodes).set({
    ...(report.type === 'A' ? { ipv4: report.ip } : { ipv6: report.ip }),
    updatedAt: now,
  }).where(eq(nodes.id, nodeId));
}

async function logDnsFailure(db: AppDb, input: {
  nodeId: string;
  type: AddressType;
  ip: string;
  recordLabel: string;
  error: string;
  now: Date;
}) {
  const messagePrefix = `${input.type} 记录 ${input.recordLabel} 同步失败：`;
  const [recent] = await db.select({ id: events.id }).from(events).where(and(
    eq(events.nodeId, input.nodeId),
    eq(events.kind, 'dns_failed'),
    eq(events.ipType, input.type),
    eq(events.ip, input.ip),
    like(events.message, `${messagePrefix}%`),
    gte(events.createdAt, new Date(input.now.getTime() - dnsFailureDedupeMs)),
  )).limit(1);
  if (recent) return;
  await insertReportEvent(db, {
    nodeId: input.nodeId,
    level: 'error',
    kind: 'dns_failed',
    message: `${messagePrefix}${input.error}`,
    ipType: input.type,
    ip: input.ip,
    createdAt: input.now,
  });
}

async function insertReportEvent(db: AppDb, values: typeof events.$inferInsert) {
  const [inserted] = await db.insert(events).values(values).returning({ id: events.id });
  if (inserted) await pruneEventsAfterInsert(db, inserted.id).catch(() => undefined);
}

function parseReports(body: ReportBody): { reports: AddressReport[] } | { error: string } {
  if (body.ip !== undefined || body.type !== undefined) {
    const type = typeof body.type === 'string' ? body.type.toUpperCase() : '';
    if (type !== 'A' && type !== 'AAAA') return { error: 'type 必须为 A 或 AAAA' };
    const ip = body.ip;
    if (type === 'A') {
      if (!validIPv4(ip)) return { error: 'IPv4 格式无效' };
      return { reports: [{ type: 'A', ip }] };
    }
    if (!validIPv6(ip)) return { error: 'IPv6 格式无效' };
    return { reports: [{ type: 'AAAA', ip }] };
  }

  // 兼容已部署的早期探针；新安装器使用原脚本的 {ip,type} 协议。
  const reports: AddressReport[] = [];
  if (body.ipv4 !== undefined && body.ipv4 !== null && body.ipv4 !== '') {
    if (!validIPv4(body.ipv4)) return { error: 'IPv4 格式无效' };
    reports.push({ type: 'A', ip: body.ipv4 });
  }
  if (body.ipv6 !== undefined && body.ipv6 !== null && body.ipv6 !== '') {
    if (!validIPv6(body.ipv6)) return { error: 'IPv6 格式无效' };
    reports.push({ type: 'AAAA', ip: body.ipv6 });
  }
  if (!reports.length) return { error: '至少需要一个公网地址' };
  return { reports };
}
