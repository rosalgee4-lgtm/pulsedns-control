import { sql } from 'drizzle-orm';
import { bigint, boolean, datetime, index, int, mediumtext, mysqlTable, primaryKey, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

// 时间统一按 UTC 毫秒精度保存。
const timestamp = (name: string) => datetime(name, { mode: 'date', fsp: 3 });

// 面板账号：管理员（role=admin，仅一个）与普通用户。密码只保存 scrypt 哈希。
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  username: varchar('username', { length: 32 }).notNull(),
  role: varchar('role', { length: 10, enum: ['admin', 'user'] }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_users_username').on(table.username),
]);

// 登录会话：Cookie 中只有随机令牌，数据库只保存它的 SHA-256。
export const sessions = mysqlTable('sessions', {
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (table) => [
  index('idx_sessions_user').on(table.userId),
  index('idx_sessions_expires').on(table.expiresAt),
]);

// 面板设置（键值）。multi_user_enabled：是否允许普通用户登录。
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: varchar('value', { length: 255 }).notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

// 防爆破：按「来源 IP」和「来源 IP + 用户名」统计失败次数。
export const loginAttempts = mysqlTable('login_attempts', {
  scope: varchar('scope', { length: 200 }).primaryKey(),
  failures: int('failures').notNull(),
  windowStartedAt: timestamp('window_started_at').notNull(),
  lockedUntil: timestamp('locked_until'),
});

export const nodes = mysqlTable('nodes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  name: varchar('name', { length: 64 }).notNull(),
  region: varchar('region', { length: 32 }).notNull().default('unknown'),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  provider: varchar('provider', { length: 16 }).notNull().default('alidns'),
  domainName: varchar('domain_name', { length: 253 }),
  recordV4: varchar('record_v4', { length: 253 }),
  recordV6: varchar('record_v6', { length: 253 }),
  syncEnabled: boolean('sync_enabled').notNull().default(true),
  ipv4: varchar('ipv4', { length: 15 }),
  ipv6: varchar('ipv6', { length: 45 }),
  agentVersion: varchar('agent_version', { length: 30 }),
  nyanpassStatus: varchar('nyanpass_status', { length: 20 }).notNull().default('awaiting'),
  provisionGeneration: int('provision_generation').notNull().default(0),
  provisionAttemptId: varchar('provision_attempt_id', { length: 36 }),
  provisionLeaseExpiresAt: timestamp('provision_lease_expires_at'),
  provisionLastCompletedStep: varchar('provision_last_completed_step', { length: 16 }),
  bootstrapPayloadCiphertext: mediumtext('bootstrap_payload_ciphertext'),
  bootstrapDownloadTokenHash: varchar('bootstrap_download_token_hash', { length: 64 }),
  dnsOperationId: varchar('dns_operation_id', { length: 36 }),
  dnsOperationExpiresAt: timestamp('dns_operation_expires_at'),
  lastSeenAt: timestamp('last_seen_at'),
  lastTaskPollAt: timestamp('last_task_poll_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  // MySQL 没有带条件的唯一索引：用生成列表达「启用同步时，同一主域名 + 主机记录只归一个节点」。
  dnsV4Owner: varchar('dns_v4_owner', { length: 510 }).generatedAlwaysAs(sql`(case when \`sync_enabled\` = 1 and \`domain_name\` is not null and \`record_v4\` is not null then concat(\`domain_name\`, '|', \`record_v4\`) end)`, { mode: 'stored' }),
  dnsV6Owner: varchar('dns_v6_owner', { length: 510 }).generatedAlwaysAs(sql`(case when \`sync_enabled\` = 1 and \`domain_name\` is not null and \`record_v6\` is not null then concat(\`domain_name\`, '|', \`record_v6\`) end)`, { mode: 'stored' }),
}, (table) => [
  uniqueIndex('idx_nodes_token_hash').on(table.tokenHash),
  uniqueIndex('idx_nodes_dns_v4_owner').on(table.dnsV4Owner),
  uniqueIndex('idx_nodes_dns_v6_owner').on(table.dnsV6Owner),
  uniqueIndex('idx_nodes_bootstrap_download_token_hash').on(table.bootstrapDownloadTokenHash),
  index('idx_nodes_owner').on(table.ownerId),
  index('idx_nodes_last_seen_at').on(table.lastSeenAt),
  index('idx_nodes_provision_lease').on(table.nyanpassStatus, table.provisionLeaseExpiresAt),
]);

// 阿里云账号：AccessKey ID 与 Secret 都加密保存；页面只显示打码后的头尾几位。
export const aliyunAccounts = mysqlTable('aliyun_accounts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  name: varchar('name', { length: 40 }).notNull(),
  keyCiphertext: text('key_ciphertext').notNull(),
  accessKeyIdHint: varchar('access_key_id_hint', { length: 32 }).notNull(),
  accessKeySecretHint: varchar('access_key_secret_hint', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_aliyun_accounts_owner_name').on(table.ownerId, table.name),
]);

// 阿里云主域名：每个主域名属于一个用户，并绑定该用户的一个阿里云账号。
export const domains = mysqlTable('domains', {
  name: varchar('name', { length: 253 }).primaryKey(),
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  accountId: varchar('account_id', { length: 36 }).notNull().references(() => aliyunAccounts.id),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  index('idx_domains_owner').on(table.ownerId),
  index('idx_domains_account').on(table.accountId),
]);

export const events = mysqlTable('events', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  nodeId: varchar('node_id', { length: 36 }).notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  level: varchar('level', { length: 10 }).notNull().default('info'),
  kind: varchar('kind', { length: 40 }).notNull(),
  message: text('message').notNull(),
  ipType: varchar('ip_type', { length: 4 }),
  ip: varchar('ip', { length: 45 }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  index('idx_events_node_created').on(table.nodeId, table.createdAt),
  index('idx_events_created_at').on(table.createdAt),
]);

export const nyanpassInstances = mysqlTable('nyanpass_instances', {
  id: varchar('id', { length: 36 }).primaryKey(),
  nodeId: varchar('node_id', { length: 36 }).notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  // 添加这个实例的用户：共享机器上每个人只能修改自己添加的实例（管理员可以修改全部）。
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  name: varchar('name', { length: 64 }).notNull(),
  role: varchar('role', { length: 10, enum: ['inbound', 'outbound'] }).notNull().default('outbound'),
  panelUrl: varchar('panel_url', { length: 255 }).notNull(),
  wsPort: int('ws_port'),
  status: varchar('status', { length: 12, enum: ['ready', 'pending', 'running', 'success', 'failed', 'uncertain', 'bootstrap', 'legacy'] }).notNull().default('legacy'),
  optimize: boolean('optimize').notNull().default(false),
  credentialCiphertext: text('credential_ciphertext'),
  configRevision: int('config_revision').notNull().default(0),
  bootstrapGeneration: int('bootstrap_generation'),
  activeTaskId: varchar('active_task_id', { length: 36 }),
  syncError: text('sync_error'),
  lastReportedAt: timestamp('last_reported_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_nyanpass_node_name').on(table.nodeId, table.name),
  uniqueIndex('idx_nyanpass_node_ws_port').on(table.nodeId, table.wsPort),
  index('idx_nyanpass_node_status').on(table.nodeId, table.status),
  index('idx_nyanpass_active_task').on(table.activeTaskId),
  index('idx_nyanpass_owner').on(table.ownerId),
]);

// 机器分享：管理员把一台机器分享给普通用户，对方可以在上面添加自己的解析和 Nyanpass 实例。
export const nodeShares = mysqlTable('node_shares', {
  nodeId: varchar('node_id', { length: 36 }).notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.nodeId, table.userId] }),
  index('idx_node_shares_user').on(table.userId),
]);

// 被分享的用户在共享机器上添加的解析：用他自己的主域名与阿里云账号，机器换 IP 时一起自动同步。
// 同一主域名 + 主机记录的 A / AAAA 在本表内唯一（生成列 + 唯一索引）；与节点自身记录的冲突在接口中检查。
export const nodeDnsRecords = mysqlTable('node_dns_records', {
  id: varchar('id', { length: 36 }).primaryKey(),
  nodeId: varchar('node_id', { length: 36 }).notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  domainName: varchar('domain_name', { length: 253 }).notNull(),
  recordV4: varchar('record_v4', { length: 253 }),
  recordV6: varchar('record_v6', { length: 253 }),
  createdAt: timestamp('created_at').notNull(),
  dnsV4Key: varchar('dns_v4_key', { length: 510 }).generatedAlwaysAs(sql`(case when \`record_v4\` is not null then concat(\`domain_name\`, '|', \`record_v4\`) end)`, { mode: 'stored' }),
  dnsV6Key: varchar('dns_v6_key', { length: 510 }).generatedAlwaysAs(sql`(case when \`record_v6\` is not null then concat(\`domain_name\`, '|', \`record_v6\`) end)`, { mode: 'stored' }),
}, (table) => [
  uniqueIndex('idx_node_dns_records_v4').on(table.dnsV4Key),
  uniqueIndex('idx_node_dns_records_v6').on(table.dnsV6Key),
  index('idx_node_dns_records_node').on(table.nodeId),
  index('idx_node_dns_records_owner').on(table.ownerId),
  index('idx_node_dns_records_domain').on(table.domainName),
]);

export const agentTasks = mysqlTable('agent_tasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // 不在 node_id 上建级联外键：MySQL 不允许生成列的基础列使用级联动作。
  // 删除节点时经由 实例 → 任务 的级联一并删除。
  nodeId: varchar('node_id', { length: 36 }).notNull(),
  instanceId: varchar('instance_id', { length: 36 }).notNull().references(() => nyanpassInstances.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 32 }).notNull().default('nyanpass_apply_v1'),
  revision: int('revision').notNull(),
  status: varchar('status', { length: 12 }).notNull().default('queued'),
  leaseTokenHash: varchar('lease_token_hash', { length: 64 }),
  leaseExpiresAt: timestamp('lease_expires_at'),
  attempts: int('attempts').notNull().default(0),
  errorCode: varchar('error_code', { length: 40 }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  claimedAt: timestamp('claimed_at'),
  finishedAt: timestamp('finished_at'),
  // 每个节点同一时间最多一个 running 任务（生成列 + 唯一索引）。
  runningNodeId: varchar('running_node_id', { length: 36 }).generatedAlwaysAs(sql`(case when \`status\` = 'running' then \`node_id\` end)`, { mode: 'stored' }),
}, (table) => [
  uniqueIndex('idx_agent_tasks_instance_revision').on(table.instanceId, table.revision),
  uniqueIndex('idx_agent_tasks_one_running_per_node').on(table.runningNodeId),
  index('idx_agent_tasks_node_status_created').on(table.nodeId, table.status, table.createdAt),
  index('idx_agent_tasks_instance_status').on(table.instanceId, table.status),
]);
