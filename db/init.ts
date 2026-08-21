import { env } from 'cloudflare:workers';

let initialized = false;

export async function ensureSchema() {
  if (initialized) return;
  const db = env.DB;
  if (!db) throw new Error('D1 binding DB is unavailable');

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS nodes (
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
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      node_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      ip_type TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON UPDATE no action ON DELETE cascade
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS nyanpass_instances (
      id TEXT PRIMARY KEY NOT NULL,
      node_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'outbound',
      panel_url TEXT NOT NULL,
      ws_port INTEGER,
      status TEXT NOT NULL DEFAULT '等待安装',
      last_reported_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON UPDATE no action ON DELETE cascade
    )`),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_token_hash ON nodes(token_hash)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_nodes_last_seen_at ON nodes(last_seen_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_events_node_created ON events(node_id, created_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_nyanpass_node_name ON nyanpass_instances(node_id, name)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_nyanpass_node_ws_port ON nyanpass_instances(node_id, ws_port)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_nyanpass_node_status ON nyanpass_instances(node_id, status)'),
  ]);

  const nodeColumns = await db.prepare('PRAGMA table_info(nodes)').all<{ name: string }>();
  if (!nodeColumns.results.some((column) => column.name === 'domain_name')) {
    await db.prepare('ALTER TABLE nodes ADD COLUMN domain_name TEXT').run();
  }

  const nyanpassColumns = await db.prepare('PRAGMA table_info(nyanpass_instances)').all<{ name: string }>();
  if (!nyanpassColumns.results.some((column) => column.name === 'role')) {
    await db.prepare("ALTER TABLE nyanpass_instances ADD COLUMN role TEXT NOT NULL DEFAULT 'outbound'").run();
  }

  await db.prepare("UPDATE nodes SET provider = 'alidns' WHERE provider = 'cloudflare'").run();
  await db.prepare('PRAGMA optimize').run();
  initialized = true;
}
