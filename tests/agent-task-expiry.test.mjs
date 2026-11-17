import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTestApp } from './test-app.mjs';

// 任务过期逻辑在 MySQL 上改成了「事务内锁行再确认」，这里用真实数据库验证两条路径。
const { database, db } = await setupTestApp('expiry');
const q = (sql, params = []) => database.query(sql, params);
const { expireAgentTasks } = await import('../lib/agent-task-lifecycle.ts');
const [{ id: adminId }] = await q('SELECT id FROM users LIMIT 1');
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);

async function nodeWithTask(id, taskStatus, { pollMinutesAgo = 30, taskMinutesAgo = 10, leaseMinutesAgo = null } = {}) {
  await q('INSERT INTO nodes (id, owner_id, name, token_hash, nyanpass_status, last_task_poll_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, adminId, id, `hash-${id}`, 'ready', minutesAgo(pollMinutesAgo), new Date(), new Date()]);
  await q("INSERT INTO nyanpass_instances (id, node_id, name, panel_url, status, config_revision, active_task_id, created_at, updated_at) VALUES (?, ?, 'awsin', 'https://ny', ?, 1, ?, ?, ?)", [`${id}-inst`, id, taskStatus === 'queued' ? 'pending' : 'running', `${id}-task`, new Date(), new Date()]);
  await q('INSERT INTO agent_tasks (id, node_id, instance_id, revision, status, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)', [`${id}-task`, id, `${id}-inst`, taskStatus, leaseMinutesAgo === null ? null : minutesAgo(leaseMinutesAgo), minutesAgo(taskMinutesAgo), minutesAgo(taskMinutesAgo)]);
}
const state = async (id) => ({
  task: (await q('SELECT status, error_code AS code FROM agent_tasks WHERE id = ?', [`${id}-task`]))[0],
  instance: (await q('SELECT status FROM nyanpass_instances WHERE id = ?', [`${id}-inst`]))[0].status,
  events: (await q('SELECT kind FROM events WHERE node_id = ?', [id])).map((row) => row.kind),
});

test('a queue nobody claims for 5 minutes on an offline probe ends as failed', async () => {
  await nodeWithTask('offline', 'queued');
  await expireAgentTasks(db, new Date());
  assert.deepEqual(await state('offline'), { task: { status: 'failed', code: 'queue_timeout' }, instance: 'failed', events: ['nyanpass_sync_failed'] });
});

test('the queue is kept while the probe is online or still busy with another task', async () => {
  await nodeWithTask('online', 'queued', { pollMinutesAgo: 1 });
  await nodeWithTask('busy', 'queued');
  await q("INSERT INTO nyanpass_instances (id, node_id, name, panel_url, status, created_at, updated_at) VALUES ('busy-inst2', 'busy', 'awsout', 'https://ny', 'running', ?, ?)", [new Date(), new Date()]);
  await q("INSERT INTO agent_tasks (id, node_id, instance_id, revision, status, lease_expires_at, created_at, updated_at) VALUES ('busy-running', 'busy', 'busy-inst2', 1, 'running', ?, ?, ?)", [new Date(Date.now() + 600_000), new Date(), new Date()]);
  await expireAgentTasks(db, new Date());
  assert.equal((await state('online')).task.status, 'queued');
  assert.equal((await state('busy')).task.status, 'queued');
});

test('a running task whose lease expired becomes uncertain and is reported once', async () => {
  await nodeWithTask('lease', 'running', { leaseMinutesAgo: 1 });
  await expireAgentTasks(db, new Date());
  await expireAgentTasks(db, new Date());
  assert.deepEqual(await state('lease'), { task: { status: 'uncertain', code: 'lease_expired' }, instance: 'uncertain', events: ['nyanpass_sync_uncertain'] });
});
