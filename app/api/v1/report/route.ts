import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes } from '@/db/schema';
import { syncAliDnsRecord } from '@/lib/alidns';
import { bearerToken, sha256 } from '@/lib/security';
import { cleanText, validIPv4, validIPv6 } from '@/lib/validation';

type AddressType = 'A' | 'AAAA';
type ReportBody = {
  ip?: unknown;
  type?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  agentVersion?: unknown;
};

type AddressReport = { type: AddressType; ip: string };

export async function POST(request: Request) {
  const token = request.headers.get('x-secret-token')?.trim() || bearerToken(request.headers.get('authorization'));
  if (!token) return Response.json({ status: 'error', error: '无效的探针凭据' }, { status: 401 });

  await ensureSchema();
  const db = await getDb();
  const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, await sha256(token))).limit(1);
  if (!node) return Response.json({ status: 'error', error: '未知探针' }, { status: 401 });

  const body = await request.json().catch(() => null) as ReportBody | null;
  if (!body) return Response.json({ status: 'error', error: 'JSON 请求无效' }, { status: 400 });

  const parsed = parseReports(body);
  if ('error' in parsed) return Response.json({ status: 'error', error: parsed.error }, { status: 400 });

  const now = new Date();
  const failures: string[] = [];
  const addressUpdates: { ipv4?: string; ipv6?: string } = {};
  for (const report of parsed.reports) {
    const previous = report.type === 'A' ? node.ipv4 : node.ipv6;
    if (previous === report.ip) continue;

    const record = report.type === 'A' ? node.recordV4 : node.recordV6;
    if (!node.syncEnabled || !node.domainName || !record) {
      await db.insert(events).values({
        nodeId: node.id,
        kind: 'ip_changed',
        message: `${report.type} 地址已变化，未绑定 DNS 记录`,
        ipType: report.type,
        ip: report.ip,
        createdAt: now,
      });
      if (report.type === 'A') addressUpdates.ipv4 = report.ip;
      else addressUpdates.ipv6 = report.ip;
      continue;
    }

    const result = await syncAliDnsRecord(node.domainName, record, report.type, report.ip);
    if (!result.ok) failures.push(`${report.type}: ${result.error}`);
    else if (report.type === 'A') addressUpdates.ipv4 = report.ip;
    else addressUpdates.ipv6 = report.ip;
    await db.insert(events).values({
      nodeId: node.id,
      level: result.ok ? 'info' : 'error',
      kind: result.ok ? 'dns_synced' : 'dns_failed',
      message: result.ok ? `${report.type} 记录 ${record} 已同步` : `${report.type} 同步失败：${result.error}`,
      ipType: report.type,
      ip: report.ip,
      createdAt: now,
    });
  }

  await db.update(nodes).set({
    ...addressUpdates,
    agentVersion: cleanText(body.agentVersion, 30) || node.agentVersion,
    lastSeenAt: now,
    updatedAt: now,
  }).where(eq(nodes.id, node.id));

  if (failures.length) {
    return Response.json({ status: 'error', error: failures.join('；') }, { status: 502 });
  }
  return Response.json({ status: 'ok' });
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
