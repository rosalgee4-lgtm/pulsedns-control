import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { api, setupTestApp } from './test-app.mjs';

const { database, adminCookie, createUser, sessionFor } = await setupTestApp('upgrade');
const nodesRoute = await import('../app/api/admin/nodes/route.ts');
const nyanpassRoute = await import('../app/api/admin/nyanpass/route.ts');
const syncRoute = await import('../app/api/admin/nyanpass/sync/route.ts');
const settingsRoute = await import('../app/api/admin/settings/route.ts');
const sharesRoute = await import('../app/api/admin/node-shares/route.ts');
const tasksRoute = await import('../app/api/v1/tasks/route.ts');
const { PROBE_AGENT_VERSION, PROBE_INSTALLER_SHA256, PROBE_INSTALLER_URL } = await import('../lib/install-command.ts');

const url = 'https://panel.test/api/x';
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const token = 'pd_agent_upgrade_test_token';
const created = await (await nodesRoute.POST(api(url, 'POST', { name: 'aws-sg', rootPassword: 'test-password-123', nyanpass: [{ name: 'awsin', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }] }, adminCookie))).json();
const nodeId = created.node.id;
await database.query("UPDATE nodes SET token_hash = ?, nyanpass_status = 'ready' WHERE id = ?", [createHash('sha256').update(token).digest('hex'), nodeId]);
await database.query("UPDATE nyanpass_instances SET status = 'success' WHERE node_id = ?", [nodeId]);

const request = (cookie = adminCookie) => nodesRoute.POST(api(url, 'POST', { action: 'agentUpgrade', id: nodeId }, cookie));
const poll = async (version) => (await tasksRoute.GET(new Request('https://panel.test/api/v1/tasks', { headers: { 'X-Secret-Token': token, 'X-Agent-Version': version } }))).json();
const ack = (body, version = '0.9.0') => tasksRoute.POST(new Request('https://panel.test/api/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': token, 'X-Agent-Version': version }, body: JSON.stringify(body) }));
const state = async () => (await database.query('SELECT agent_upgrade_id AS id, agent_upgrade_status AS status, agent_upgrade_target_version AS target FROM nodes WHERE id = ?', [nodeId]))[0];
const latestEvent = async () => (await database.query('SELECT kind, level, message FROM events WHERE node_id = ? ORDER BY id DESC LIMIT 1', [nodeId]))[0];
// 当前发布版本就是最新探针；用数据库把目标设成更高的版本来模拟「下一个发布」。
const queue = async (target = '9.9.9', requestedAt = new Date()) => {
  const id = crypto.randomUUID();
  await database.query("UPDATE nodes SET agent_upgrade_id = ?, agent_upgrade_status = 'queued', agent_upgrade_target_version = ?, agent_upgrade_requested_at = ?, agent_upgrade_started_at = NULL WHERE id = ?", [id, target, requestedAt, nodeId]);
  return id;
};

test('the panel only offers remote upgrade to online probes that support it and are not up to date', async () => {
  await database.query("UPDATE nodes SET agent_version = '0.8.3', last_task_poll_at = ? WHERE id = ?", [new Date(), nodeId]);
  const old = await request();
  assert.equal(old.status, 409);
  assert.match((await old.json()).error, /还不支持远程升级/);

  await database.query("UPDATE nodes SET agent_version = ? WHERE id = ?", [PROBE_AGENT_VERSION, nodeId]);
  const latest = await request();
  assert.equal(latest.status, 409);
  assert.match((await latest.json()).error, /已经是最新版本/);

  await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie));
  const tenant = await createUser('tenant', 'tenant-password-123');
  await sharesRoute.POST(api(url, 'POST', { nodeId, userId: tenant.id }, adminCookie));
  assert.equal((await request(await sessionFor('tenant'))).status, 404, 'a shared user cannot upgrade the machine');
  assert.equal((await state()).id, null);
});

test('a queued upgrade is handed to the probe as a fixed job, and nothing else runs until it finishes', async () => {
  const id = await queue();
  const job = await poll('0.9.0');
  assert.deepEqual(job, {
    status: 'job',
    protocol: 1,
    job: { id, action: 'agent_upgrade_v1', payload: { installerUrl: PROBE_INSTALLER_URL, installerSha256: PROBE_INSTALLER_SHA256, version: '9.9.9' } },
  });
  assert.equal((await state()).status, 'running');
  assert.match((await latestEvent()).message, /开始从 v0\.9\.0 升级到 v9\.9\.9/);

  // 升级进行中不下发 Nyanpass 任务。
  const instanceId = created.instances[0].id;
  await nyanpassRoute.PATCH(api(url, 'PATCH', { id: instanceId, name: 'awsin', command: ny('-t bbbbbbbb-2222 -u https://ny.example.test') }, adminCookie));
  assert.equal((await syncRoute.POST(api(url, 'POST', { id: instanceId }, adminCookie))).status, 200);
  assert.deepEqual(await poll('0.9.0'), { status: 'idle', protocol: 1 });

  // 探针以新版本重新轮询即视为完成，随后正常领取排队的 Nyanpass 任务。
  const next = await poll('9.9.9');
  assert.equal((await state()).id, null);
  const events = await database.query("SELECT message FROM events WHERE node_id = ? AND kind = 'agent_upgrade_succeeded'", [nodeId]);
  assert.deepEqual(events.map((event) => event.message), ['探针已升级到 v9.9.9']);
  assert.equal(next.job?.action, 'nyanpass_apply_v1');
  await database.query("UPDATE agent_tasks SET status = 'succeeded' WHERE node_id = ?", [nodeId]);
  await database.query("UPDATE nyanpass_instances SET status = 'success', active_task_id = NULL WHERE node_id = ?", [nodeId]);
});

test('a probe-side failure is reported back and ends the upgrade', async () => {
  await database.query("UPDATE nodes SET agent_version = '0.9.0' WHERE id = ?", [nodeId]);
  const id = await queue();
  await poll('0.9.0');
  assert.equal((await ack({ upgradeId: id, outcome: 'failed', errorCode: 'nope' })).status, 400);
  assert.equal((await ack({ upgradeId: id, outcome: 'failed', errorCode: 'installer_invalid', extra: 1 })).status, 400);
  assert.equal((await ack({ upgradeId: id, outcome: 'failed', errorCode: 'installer_invalid' })).status, 200);
  assert.equal((await state()).id, null);
  assert.deepEqual(await latestEvent(), { kind: 'agent_upgrade_failed', level: 'error', message: '探针升级失败：下载的公共安装器未通过校验' });
  assert.equal((await ack({ upgradeId: id, outcome: 'failed', errorCode: 'installer_invalid' })).status, 200, 'a repeated receipt is harmless');
});

test('upgrades that are never claimed or never finish time out with an error event', async () => {
  await queue('9.9.9', new Date(Date.now() - 6 * 60 * 1000));
  await nyanpassRoute.GET(api(url, 'GET', undefined, adminCookie));
  assert.equal((await state()).id, null);
  assert.match((await latestEvent()).message, /5 分钟内没有领取升级任务/);

  await queue();
  await poll('0.9.0');
  await database.query('UPDATE nodes SET agent_upgrade_started_at = ? WHERE id = ?', [new Date(Date.now() - 21 * 60 * 1000), nodeId]);
  await poll('0.9.0');
  assert.equal((await state()).id, null);
  assert.match((await latestEvent()).message, /20 分钟内没有以 v9\.9\.9 重新上线/);
});
