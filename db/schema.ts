import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  region: text('region').notNull().default('unknown'),
  tokenHash: text('token_hash').notNull(),
  provider: text('provider').notNull().default('alidns'),
  domainName: text('domain_name'),
  recordV4: text('record_v4'),
  recordV6: text('record_v6'),
  syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
  ipv4: text('ipv4'),
  ipv6: text('ipv6'),
  agentVersion: text('agent_version'),
  nyanpassStatus: text('nyanpass_status').notNull().default('未安装'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_nodes_token_hash').on(table.tokenHash),
  index('idx_nodes_last_seen_at').on(table.lastSeenAt),
]);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  level: text('level').notNull().default('info'),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  ipType: text('ip_type'),
  ip: text('ip'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_events_node_created').on(table.nodeId, table.createdAt),
  index('idx_events_created_at').on(table.createdAt),
]);

export const nyanpassInstances = sqliteTable('nyanpass_instances', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role', { enum: ['inbound', 'outbound'] }).notNull().default('outbound'),
  panelUrl: text('panel_url').notNull(),
  wsPort: integer('ws_port'),
  status: text('status').notNull().default('等待安装'),
  lastReportedAt: integer('last_reported_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_nyanpass_node_name').on(table.nodeId, table.name),
  uniqueIndex('idx_nyanpass_node_ws_port').on(table.nodeId, table.wsPort),
  index('idx_nyanpass_node_status').on(table.nodeId, table.status),
]);
