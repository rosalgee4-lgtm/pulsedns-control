import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { nodeDnsRecords, nodes } from '@/db/schema';

type AppDb = Awaited<ReturnType<typeof getDb>>;

export type DnsOwnershipConflict = {
  type: 'A' | 'AAAA';
  nodeId: string;
  nodeName: string;
};

export async function findDnsOwnershipConflict(
  db: AppDb,
  input: { domainName: string | null; recordV4: string | null; recordV6: string | null; excludeNodeId?: string },
): Promise<DnsOwnershipConflict | null> {
  if (!input.domainName) return null;

  for (const candidate of [
    { type: 'A' as const, record: input.recordV4, column: nodes.recordV4 },
    { type: 'AAAA' as const, record: input.recordV6, column: nodes.recordV6 },
  ]) {
    if (!candidate.record) continue;
    const conditions = [
      eq(nodes.syncEnabled, true),
      eq(nodes.domainName, input.domainName),
      eq(candidate.column, candidate.record),
    ];
    if (input.excludeNodeId) conditions.push(ne(nodes.id, input.excludeNodeId));
    const [owner] = await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(and(...conditions)).limit(1);
    if (owner) return { type: candidate.type, nodeId: owner.id, nodeName: owner.name };
  }
  return findSharedRecordConflict(db, input);
}

// 共享机器上被分享用户添加的解析也占用对应的主机记录。
export async function findSharedRecordConflict(
  db: AppDb,
  input: { domainName: string | null; recordV4: string | null; recordV6: string | null; excludeRecordId?: string },
): Promise<DnsOwnershipConflict | null> {
  if (!input.domainName) return null;
  for (const candidate of [
    { type: 'A' as const, record: input.recordV4, column: nodeDnsRecords.recordV4 },
    { type: 'AAAA' as const, record: input.recordV6, column: nodeDnsRecords.recordV6 },
  ]) {
    if (!candidate.record) continue;
    const conditions = [eq(nodeDnsRecords.domainName, input.domainName), eq(candidate.column, candidate.record)];
    if (input.excludeRecordId) conditions.push(ne(nodeDnsRecords.id, input.excludeRecordId));
    const [owner] = await db.select({ id: nodes.id, name: nodes.name }).from(nodeDnsRecords)
      .innerJoin(nodes, eq(nodeDnsRecords.nodeId, nodes.id)).where(and(...conditions)).limit(1);
    if (owner) return { type: candidate.type, nodeId: owner.id, nodeName: owner.name };
  }
  return null;
}

export function isDnsOwnershipConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = cause instanceof Error ? `${message} ${cause.message}` : message;
  return /idx_nodes_dns_v[46]_owner|idx_node_dns_records_v[46]/i.test(detail);
}

export function dnsOwnershipConflictMessage(conflict: Pick<DnsOwnershipConflict, 'type' | 'nodeName'>) {
  return `${conflict.type} DNS 记录已由节点 ${conflict.nodeName} 管理；请先停用或修改原节点的记录`;
}
