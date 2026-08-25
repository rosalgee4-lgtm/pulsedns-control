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
];

test('a pre-remote-sync database migrates through the v0.8 task schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulsedns-migration-'));
  const databasePath = join(directory, 'pulsedns.db');
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const filename of migrations) {
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
  } finally {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});
