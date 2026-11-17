import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTestApp } from './test-app.mjs';

// MySQL 没有带条件的唯一索引：用生成列 + 唯一索引保证与原先相同的约束。
const { database } = await setupTestApp('schema');
const q = (sql, params = []) => database.query(sql, params);
const [{ id: adminId }] = await q('SELECT id FROM users LIMIT 1');
const now = new Date();
const insertNode = (id, values = {}) => q(
  'INSERT INTO nodes (id, owner_id, name, token_hash, domain_name, record_v4, record_v6, sync_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [id, adminId, id, `hash-${id}`, values.domain ?? null, values.v4 ?? null, values.v6 ?? null, values.sync ?? 1, now, now],
);

test('each enabled DNS record has at most one owning node', async () => {
  await insertNode('owner-a', { domain: 'example.com', v4: 'jp', v6: 'jp' });
  await assert.rejects(insertNode('owner-b', { domain: 'example.com', v4: 'jp' }), /idx_nodes_dns_v4_owner/);
  await assert.rejects(insertNode('owner-c', { domain: 'example.com', v6: 'jp' }), /idx_nodes_dns_v6_owner/);
  await insertNode('owner-d', { domain: 'example.com', v4: 'jp', sync: 0 });
  await insertNode('owner-e', { domain: 'other.com', v4: 'jp' });
  await insertNode('owner-f');
  await insertNode('owner-g');
  await assert.rejects(q('UPDATE nodes SET sync_enabled = 1 WHERE id = ?', ['owner-d']), /idx_nodes_dns_v4_owner/);
});

test('a node runs at most one agent task at a time, and tasks follow node deletion', async () => {
  await q("INSERT INTO nyanpass_instances (id, node_id, owner_id, name, panel_url, created_at, updated_at) VALUES ('inst-1', 'owner-f', ?, 'awsin', 'https://ny', ?, ?), ('inst-2', 'owner-f', ?, 'awsout', 'https://ny', ?, ?)", [adminId, now, now, adminId, now, now]);
  const task = (id, instance, status) => q('INSERT INTO agent_tasks (id, node_id, instance_id, revision, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [id, 'owner-f', instance, status, now, now]);
  await task('task-1', 'inst-1', 'running');
  await assert.rejects(task('task-2', 'inst-2', 'running'), /idx_agent_tasks_one_running_per_node/);
  await task('task-3', 'inst-2', 'queued');
  await assert.rejects(q("UPDATE agent_tasks SET status = 'running' WHERE id = 'task-3'"), /idx_agent_tasks_one_running_per_node/);
  await q("UPDATE agent_tasks SET status = 'succeeded' WHERE id = 'task-1'");
  await q("UPDATE agent_tasks SET status = 'running' WHERE id = 'task-3'");

  await q("INSERT INTO events (node_id, kind, message, created_at) VALUES ('owner-f', 'node_created', 'x', ?)", [now]);
  await q("DELETE FROM nodes WHERE id = 'owner-f'");
  for (const table of ['nyanpass_instances', 'agent_tasks', 'events']) {
    assert.equal((await q(`SELECT COUNT(*) AS total FROM ${table} WHERE node_id = 'owner-f'`))[0].total, 0, `${table} rows are removed with the node`);
  }
});

test('timestamps round-trip in UTC with millisecond precision', async () => {
  const { getDb } = await import('../db/index.ts');
  const { nodes } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const db = await getDb();
  const moment = new Date('2026-11-17T23:59:58.123Z');
  await db.update(nodes).set({ lastSeenAt: moment }).where(eq(nodes.id, 'owner-g'));
  const [row] = await db.select({ lastSeenAt: nodes.lastSeenAt }).from(nodes).where(eq(nodes.id, 'owner-g'));
  assert.equal(row.lastSeenAt.toISOString(), moment.toISOString());
});
