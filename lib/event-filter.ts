export type EventFilter = {
  nodeId: string;
  category: string;
  level: string;
  query: string;
};

export type FilterableEvent = {
  nodeId: string;
  nodeName: string;
  level: string;
  kind: string;
  message: string;
};

export function eventCategory(kind: string) {
  if (kind === 'node_created' || kind === 'node_updated') return 'node';
  if (kind === 'ip_changed') return 'ip';
  if (kind === 'dns_synced' || kind === 'dns_failed') return 'dns';
  if (kind.startsWith('nyanpass_')) return 'nyanpass';
  return 'other';
}

export function filterEvents<T extends FilterableEvent>(events: T[], filter: EventFilter, limit?: number) {
  const query = filter.query.trim().toLocaleLowerCase();
  const filtered = events.filter((event) => {
    if (filter.nodeId !== 'all' && event.nodeId !== filter.nodeId) return false;
    if (filter.category !== 'all' && eventCategory(event.kind) !== filter.category) return false;
    if (filter.level !== 'all' && event.level !== filter.level) return false;
    if (query && !`${event.message} ${event.nodeName} ${event.kind}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
}
