import { getLocalSqlite, isSelfHosted } from './index';

let initialized = false;
let initialization: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'unknown',
    token_hash TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'alidns',
    domain_name TEXT,
    record_v4 TEXT,
    record_v6 TEXT,
    sync_enabled INTEGER NOT NULL DEFAULT 1,
    ipv4 TEXT,
    ipv6 TEXT,
    agent_version TEXT,
    nyanpass_status TEXT NOT NULL DEFAULT '未安装',
    provision_generation INTEGER NOT NULL DEFAULT 0,
    provision_attempt_id TEXT,
    provision_lease_expires_at INTEGER,
    bootstrap_payload_ciphertext TEXT,
    bootstrap_download_token_hash TEXT,
    dns_operation_id TEXT,
    dns_operation_expires_at INTEGER,
    last_seen_at INTEGER,
    last_task_poll_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    node_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    ip_type TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE TABLE IF NOT EXISTS nyanpass_instances (
    id TEXT PRIMARY KEY NOT NULL,
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'outbound',
    panel_url TEXT NOT NULL,
    ws_port INTEGER,
    status TEXT NOT NULL DEFAULT 'legacy',
    optimize INTEGER NOT NULL DEFAULT 0,
    credential_ciphertext TEXT,
    config_revision INTEGER NOT NULL DEFAULT 0,
    bootstrap_generation INTEGER,
    active_task_id TEXT,
    sync_error TEXT,
    last_reported_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    node_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'nyanpass_apply_v1',
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    lease_token_hash TEXT,
    lease_expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    claimed_at INTEGER,
    finished_at INTEGER,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (instance_id) REFERENCES nyanpass_instances(id) ON UPDATE no action ON DELETE cascade
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_token_hash ON nodes(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_last_seen_at ON nodes(last_seen_at)',
  'CREATE INDEX IF NOT EXISTS idx_events_node_created ON events(node_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nyanpass_node_name ON nyanpass_instances(node_id, name)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nyanpass_node_ws_port ON nyanpass_instances(node_id, ws_port)',
  'CREATE INDEX IF NOT EXISTS idx_nyanpass_node_status ON nyanpass_instances(node_id, status)',
];

const taskIndexStatements = [
  'CREATE INDEX IF NOT EXISTS idx_nodes_provision_lease ON nodes(nyanpass_status, provision_lease_expires_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_bootstrap_download_token_hash ON nodes(bootstrap_download_token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_nyanpass_active_task ON nyanpass_instances(active_task_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_instance_revision ON agent_tasks(instance_id, revision)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_one_running_per_node ON agent_tasks(node_id) WHERE status = 'running'",
  'CREATE INDEX IF NOT EXISTS idx_agent_tasks_node_status_created ON agent_tasks(node_id, status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_tasks_instance_status ON agent_tasks(instance_id, status)',
];

export async function ensureSchema() {
  if (initialized) return;
  if (initialization) return initialization;
  initialization = initializeSchema();
  try {
    await initialization;
    initialized = true;
  } finally {
    initialization = null;
  }
}

async function initializeSchema() {

  if (isSelfHosted()) {
    const db = await getLocalSqlite();
    db.exec(`${schemaStatements.join(';\n')};`);
    const nodeColumns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (!nodeColumns.some((column) => column.name === 'domain_name')) db.exec('ALTER TABLE nodes ADD COLUMN domain_name TEXT');
    if (!nodeColumns.some((column) => column.name === 'nyanpass_status')) db.exec("ALTER TABLE nodes ADD COLUMN nyanpass_status TEXT NOT NULL DEFAULT '未安装'");
    if (!nodeColumns.some((column) => column.name === 'last_task_poll_at')) db.exec('ALTER TABLE nodes ADD COLUMN last_task_poll_at INTEGER');
    if (!nodeColumns.some((column) => column.name === 'provision_generation')) db.exec('ALTER TABLE nodes ADD COLUMN provision_generation INTEGER NOT NULL DEFAULT 0');
    if (!nodeColumns.some((column) => column.name === 'provision_attempt_id')) db.exec('ALTER TABLE nodes ADD COLUMN provision_attempt_id TEXT');
    if (!nodeColumns.some((column) => column.name === 'provision_lease_expires_at')) db.exec('ALTER TABLE nodes ADD COLUMN provision_lease_expires_at INTEGER');
    if (!nodeColumns.some((column) => column.name === 'bootstrap_payload_ciphertext')) db.exec('ALTER TABLE nodes ADD COLUMN bootstrap_payload_ciphertext TEXT');
    if (!nodeColumns.some((column) => column.name === 'bootstrap_download_token_hash')) db.exec('ALTER TABLE nodes ADD COLUMN bootstrap_download_token_hash TEXT');
    if (!nodeColumns.some((column) => column.name === 'dns_operation_id')) db.exec('ALTER TABLE nodes ADD COLUMN dns_operation_id TEXT');
    if (!nodeColumns.some((column) => column.name === 'dns_operation_expires_at')) db.exec('ALTER TABLE nodes ADD COLUMN dns_operation_expires_at INTEGER');
    const nyanpassColumns = db.prepare('PRAGMA table_info(nyanpass_instances)').all() as Array<{ name: string }>;
    if (!nyanpassColumns.some((column) => column.name === 'role')) db.exec("ALTER TABLE nyanpass_instances ADD COLUMN role TEXT NOT NULL DEFAULT 'outbound'");
    if (!nyanpassColumns.some((column) => column.name === 'optimize')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN optimize INTEGER NOT NULL DEFAULT 0');
    if (!nyanpassColumns.some((column) => column.name === 'credential_ciphertext')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN credential_ciphertext TEXT');
    if (!nyanpassColumns.some((column) => column.name === 'config_revision')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0');
    if (!nyanpassColumns.some((column) => column.name === 'active_task_id')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN active_task_id TEXT');
    if (!nyanpassColumns.some((column) => column.name === 'sync_error')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN sync_error TEXT');
    if (!nyanpassColumns.some((column) => column.name === 'bootstrap_generation')) db.exec('ALTER TABLE nyanpass_instances ADD COLUMN bootstrap_generation INTEGER');
    db.exec(`${taskIndexStatements.join(';\n')}; UPDATE nodes SET provider = 'alidns' WHERE provider = 'cloudflare'; UPDATE nodes SET nyanpass_status = 'uncertain', provision_generation = CASE WHEN provision_generation < 1 THEN 1 ELSE provision_generation END WHERE nyanpass_status = 'provisioning' AND provision_attempt_id IS NULL; UPDATE nyanpass_instances SET bootstrap_generation = 1 WHERE config_revision = 0 AND status IN ('bootstrap', 'uncertain') AND bootstrap_generation IS NULL; UPDATE nyanpass_instances SET status = 'legacy' WHERE status = '等待安装'; PRAGMA optimize;`);
    return;
  }

  const { env } = await import('cloudflare:workers');
  const db = env.DB;
  if (!db) throw new Error('D1 binding DB is unavailable');
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));

  const nodeColumns = await db.prepare('PRAGMA table_info(nodes)').all<{ name: string }>();
  if (!nodeColumns.results.some((column) => column.name === 'domain_name')) {
    await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN domain_name TEXT');
  }
  if (!nodeColumns.results.some((column) => column.name === 'nyanpass_status')) {
    await addD1Column(db, "ALTER TABLE nodes ADD COLUMN nyanpass_status TEXT NOT NULL DEFAULT '未安装'");
  }
  if (!nodeColumns.results.some((column) => column.name === 'last_task_poll_at')) {
    await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN last_task_poll_at INTEGER');
  }
  if (!nodeColumns.results.some((column) => column.name === 'provision_generation')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN provision_generation INTEGER NOT NULL DEFAULT 0');
  if (!nodeColumns.results.some((column) => column.name === 'provision_attempt_id')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN provision_attempt_id TEXT');
  if (!nodeColumns.results.some((column) => column.name === 'provision_lease_expires_at')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN provision_lease_expires_at INTEGER');
  if (!nodeColumns.results.some((column) => column.name === 'bootstrap_payload_ciphertext')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN bootstrap_payload_ciphertext TEXT');
  if (!nodeColumns.results.some((column) => column.name === 'bootstrap_download_token_hash')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN bootstrap_download_token_hash TEXT');
  if (!nodeColumns.results.some((column) => column.name === 'dns_operation_id')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN dns_operation_id TEXT');
  if (!nodeColumns.results.some((column) => column.name === 'dns_operation_expires_at')) await addD1Column(db, 'ALTER TABLE nodes ADD COLUMN dns_operation_expires_at INTEGER');
  const nyanpassColumns = await db.prepare('PRAGMA table_info(nyanpass_instances)').all<{ name: string }>();
  if (!nyanpassColumns.results.some((column) => column.name === 'role')) {
    await addD1Column(db, "ALTER TABLE nyanpass_instances ADD COLUMN role TEXT NOT NULL DEFAULT 'outbound'");
  }
  if (!nyanpassColumns.results.some((column) => column.name === 'optimize')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN optimize INTEGER NOT NULL DEFAULT 0');
  if (!nyanpassColumns.results.some((column) => column.name === 'credential_ciphertext')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN credential_ciphertext TEXT');
  if (!nyanpassColumns.results.some((column) => column.name === 'config_revision')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0');
  if (!nyanpassColumns.results.some((column) => column.name === 'active_task_id')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN active_task_id TEXT');
  if (!nyanpassColumns.results.some((column) => column.name === 'sync_error')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN sync_error TEXT');
  if (!nyanpassColumns.results.some((column) => column.name === 'bootstrap_generation')) await addD1Column(db, 'ALTER TABLE nyanpass_instances ADD COLUMN bootstrap_generation INTEGER');
  await db.batch(taskIndexStatements.map((statement) => db.prepare(statement)));
  await db.prepare("UPDATE nodes SET provider = 'alidns' WHERE provider = 'cloudflare'").run();
  await db.prepare("UPDATE nodes SET nyanpass_status = 'uncertain', provision_generation = CASE WHEN provision_generation < 1 THEN 1 ELSE provision_generation END WHERE nyanpass_status = 'provisioning' AND provision_attempt_id IS NULL").run();
  await db.prepare("UPDATE nyanpass_instances SET bootstrap_generation = 1 WHERE config_revision = 0 AND status IN ('bootstrap', 'uncertain') AND bootstrap_generation IS NULL").run();
  await db.prepare("UPDATE nyanpass_instances SET status = 'legacy' WHERE status = '等待安装'").run();
  await db.prepare('PRAGMA optimize').run();
}

async function addD1Column(db: { prepare(query: string): { run(): Promise<unknown> } }, statement: string) {
  try {
    await db.prepare(statement).run();
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
