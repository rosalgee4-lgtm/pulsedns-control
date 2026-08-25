import { nodes } from '@/db/schema';

export function nodeResponse(node: typeof nodes.$inferSelect) {
  return {
    id: node.id,
    name: node.name,
    region: node.region,
    provider: node.provider,
    domainName: node.domainName,
    recordV4: node.recordV4,
    recordV6: node.recordV6,
    syncEnabled: node.syncEnabled,
    ipv4: node.ipv4,
    ipv6: node.ipv6,
    agentVersion: node.agentVersion,
    nyanpassStatus: node.nyanpassStatus,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    lastTaskPollAt: node.lastTaskPollAt?.toISOString() ?? null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}
