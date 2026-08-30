import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrations = [
  '0000_unusual_jasper_sitwell.sql',
  '0001_nifty_the_anarchist.sql',
  '0002_foamy_colossus.sql',
  '0003_warm_mathemanic.sql',
  '0004_chubby_cannonball.sql',
  '0005_boring_surge.sql',
  '0006_bootstrap_attempts.sql',
  '0007_sour_quasimodo.sql',
  '0008_tidy_patriot.sql',
];

test('a pre-remote-sync database migrates through the v0.8.2 schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulsedns-migration-'));
  const databasePath = join(directory, 'pulsedns.db');
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const filename of migrations) {
      if (filename === '0008_tidy_patriot.sql') {
        const insertNode = sqlite.prepare(`INSERT INTO nodes
          (id, name, region, token_hash, provider, domain_name, record_v4, record_v6, sync_enabled, nyanpass_status, created_at, updated_at)
          VALUES (?, ?, 'test', ?, 'alidns', 'example.com', 'shared', 'shared-v6', 1, 'ready', ?, ?)`);
        insertNode.run('owner-oldest', 'oldest', 'hash-oldest', 1, 1);
        insertNode.run('owner-duplicate', 'duplicate', 'hash-duplicate', 2, 2);
      }
      const sql = await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
        sqlite.exec(statement);
      }
    }

    const nodeColumns = sqlite.prepare('PRAGMA table_info(nodes)').all().map((column) => column.name);
    const instanceColumns = sqlite.prepare('PRAGMA table_info(nyanpass_instances)').all().map((column) => column.name);
    assert.ok(nodeColumns.includes('last_task_poll_at'));
    assert.ok(nodeColumns.includes('nyanpass_status'));
    assert.ok(nodeColumns.includes('provision_generation'));
    assert.ok(nodeColumns.includes('provision_attempt_id'));
    assert.ok(nodeColumns.includes('provision_lease_expires_at'));
    assert.ok(nodeColumns.includes('dns_operation_id'));
    assert.ok(nodeColumns.includes('dns_operation_expires_at'));
    assert.ok(nodeColumns.includes('bootstrap_payload_ciphertext'));
    assert.ok(nodeColumns.includes('bootstrap_download_token_hash'));
    assert.ok(instanceColumns.includes('credential_ciphertext'));
    assert.ok(instanceColumns.includes('config_revision'));
    assert.ok(instanceColumns.includes('active_task_id'));
    assert.ok(instanceColumns.includes('bootstrap_generation'));

    const taskIndexes = sqlite.prepare('PRAGMA index_list(agent_tasks)').all();
    assert.ok(taskIndexes.some((index) => index.name === 'idx_agent_tasks_one_running_per_node' && index.partial === 1));
    const nodeIndexes = sqlite.prepare('PRAGMA index_list(nodes)').all();
    assert.ok(nodeIndexes.some((index) => index.name === 'idx_nodes_bootstrap_download_token_hash' && index.unique === 1));
    assert.ok(nodeIndexes.some((index) => index.name === 'idx_nodes_dns_v4_owner' && index.unique === 1 && index.partial === 1));
    assert.ok(nodeIndexes.some((index) => index.name === 'idx_nodes_dns_v6_owner' && index.unique === 1 && index.partial === 1));

    const owners = sqlite.prepare("SELECT id, sync_enabled FROM nodes WHERE id LIKE 'owner-%' ORDER BY created_at").all().map((row) => ({ ...row }));
    assert.deepEqual(owners, [
      { id: 'owner-oldest', sync_enabled: 1 },
      { id: 'owner-duplicate', sync_enabled: 0 },
    ]);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM events WHERE node_id = 'owner-duplicate' AND kind = 'dns_ownership_conflict'").get().count, 1);
    assert.throws(() => sqlite.prepare(`INSERT INTO nodes
      (id, name, region, token_hash, provider, domain_name, record_v4, sync_enabled, nyanpass_status, created_at, updated_at)
      VALUES ('owner-racer', 'racer', 'test', 'hash-racer', 'alidns', 'example.com', 'shared', 1, 'ready', 3, 3)`).run(), /UNIQUE constraint failed/);
  } finally {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});
