import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { nodeDnsRecords } from '@/db/schema';

export type SharedDnsTarget = { id: string; domainName: string; record: string; label: string };

// 共享机器上被分享用户添加的某一类型（A / AAAA）解析。
export async function sharedDnsTargets(db: AppDb, nodeId: string, type: 'A' | 'AAAA'): Promise<SharedDnsTarget[]> {
  const rows = await db.select().from(nodeDnsRecords).where(eq(nodeDnsRecords.nodeId, nodeId));
  return rows.flatMap((row) => {
    const record = type === 'A' ? row.recordV4 : row.recordV6;
    return record ? [{ id: row.id, domainName: row.domainName, record, label: dnsLabel(row.domainName, record) }] : [];
  });
}

export function dnsLabel(domainName: string, record: string) {
  return record === '@' ? domainName : `${record}.${domainName}`;
}
