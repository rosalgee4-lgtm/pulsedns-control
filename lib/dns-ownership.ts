import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { nodes } from '@/db/schema';

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
  return null;
}

export function isDnsOwnershipConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /idx_nodes_dns_v[46]_owner|UNIQUE constraint failed:\s*nodes\.domain_name,\s*nodes\.record_v[46]/i.test(message);
}

export function dnsOwnershipConflictMessage(conflict: Pick<DnsOwnershipConflict, 'type' | 'nodeName'>) {
  return `${conflict.type} DNS 记录已由节点 ${conflict.nodeName} 管理；请先停用或修改原节点的记录`;
}
