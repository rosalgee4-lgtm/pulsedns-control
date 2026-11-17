import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, setupTestApp } from './test-app.mjs';

const { database, adminCookie } = await setupTestApp('recopy');
const q = (sql, params = []) => database.query(sql, params);
const { POST } = await import('../app/api/admin/nodes/route.ts');
const { GET } = await import('../app/api/v1/bootstrap/[nodeId]/[token]/route.ts');
const { POST: provision } = await import('../app/api/v1/provision/route.ts');
const { POST: addInstance, DELETE: removeInstance } = await import('../app/api/admin/nyanpass/route.ts');
const { POST: queue, DELETE: cancel } = await import('../app/api/admin/nyanpass/sync/route.ts');
const { GET: poll, POST: acknowledge } = await import('../app/api/v1/tasks/route.ts');
const { decryptBootstrapPayload, encryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');

const request = (body, cookie = adminCookie) => api('https://master.example.test/api/admin/nodes', 'POST', body, cookie);
const commands = (id) => POST(request({ action: 'installation', id }));
const stored = async (id) => (await q('SELECT * FROM nodes WHERE id = ?', [id]))[0];
async function createNode() {
  const response = await POST(request({
    name: 'recopy-test', rootPassword: 'test-password-123',
    nyanpass: [{ name: 'test-out', optimize: false, command: 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t abcdefgh-1234 -u https://ny.example.test"' }],
  }));
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
function download(url) {
  const segments = new URL(url).pathname.split('/');
  return GET(new Request(url), { params: Promise.resolve({ nodeId: segments.at(-2), token: segments.at(-1) }) });
}

test('recopy requires admin auth and unknown nodes are not created', async () => {
  assert.equal((await POST(request({ action: 'installation', id: '11111111-2222-4333-8444-555555555555' }, null))).status, 401);
  assert.equal((await commands('bad-id')).status, 400);
  assert.equal((await commands('11111111-2222-4333-8444-555555555555')).status, 404);
});

test('refresh and concurrent recopy preserve the unexpired command and node identity', async () => {
  const created = await createNode();
  const before = await stored(created.node.id);
  const results = await Promise.all([commands(created.node.id), commands(created.node.id)]);
  for (const response of results) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = await response.json();
    assert.equal(result.connectCommand, created.connectCommand);
    assert.equal(result.startupScript, created.startupScript);
    assert.equal(result.expiresAt, created.expiresAt);
  }
  const after = await stored(created.node.id);
  assert.equal(after.bootstrap_download_token_hash, before.bootstrap_download_token_hash);
  assert.equal(after.provision_generation, before.provision_generation);
  assert.equal(after.token_hash, before.token_hash);
  assert.equal(after.dns_operation_id, null);
  const downloaded = await download(created.installUrl);
  assert.equal(downloaded.status, 200);
  assert.match(await downloaded.text(), /^PULSEDNS_BOOTSTRAP_V1\0/);
  assert.equal((await commands(created.node.id)).status, 200);
});

test('permanent links are reused for failed nodes without resetting the attempt or leaking credentials', async () => {
  const created = await createNode();
  const id = created.node.id;
  assert.equal(created.expiresAt, null);
  await q("UPDATE nodes SET nyanpass_status = 'failed', provision_attempt_id = 'old-attempt', provision_last_completed_step = 'ddns' WHERE id = ?", [id]);
  const before = await stored(id);
  const response = await commands(id);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.installUrl, created.installUrl);
  assert.equal(result.startupScript, created.startupScript);
  assert.equal(result.expiresAt, null);
  assert.equal(result.node.id, id);
  assert.doesNotMatch(JSON.stringify(result), /test-password-123|pd_[a-f0-9]{64}|abcdefg/);
  const after = await stored(id);
  for (const column of ['token_hash', 'bootstrap_download_token_hash', 'provision_generation', 'provision_attempt_id', 'provision_last_completed_step', 'nyanpass_status']) {
    assert.equal(after[column], before[column], column);
  }
  for (let index = 0; index < 3; index += 1) assert.equal((await download(created.installUrl)).status, 200);
});

test('legacy encrypted payloads can issue new commands without deleting the node', async () => {
  const created = await createNode();
  const id = created.node.id;
  const context = { nodeId: id, generation: 1 };
  const before = await stored(id);
  const payload = await decryptBootstrapPayload(before.bootstrap_payload_ciphertext, context);
  delete payload.downloadToken;
  const legacy = await encryptBootstrapPayload(payload, context);
  await q('UPDATE nodes SET bootstrap_payload_ciphertext = ? WHERE id = ?', [legacy, id]);
  const response = await commands(id);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.installUrl, created.installUrl);
  assert.equal((await download(result.installUrl)).status, 200);
});

test('install commands stay identical while provisioning and after completion; erased legacy nodes stay revoked', async () => {
  const created = await createNode();
  const id = created.node.id;
  await q("UPDATE nodes SET nyanpass_status = 'provisioning', provision_lease_expires_at = ? WHERE id = ?", [new Date(Date.now() + 60000), id]);
  const before = await stored(id);
  const during = await commands(id);
  assert.equal(during.status, 200);
  assert.equal((await during.json()).installUrl, created.installUrl);
  await q("UPDATE nodes SET nyanpass_status = 'ready', provision_lease_expires_at = NULL WHERE id = ?", [id]);
  const ready = await commands(id);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).startupScript, created.startupScript);
  assert.equal((await download(created.installUrl)).status, 200);
  assert.equal((await stored(id)).bootstrap_download_token_hash, before.bootstrap_download_token_hash);
  await q("UPDATE nodes SET bootstrap_payload_ciphertext = NULL, bootstrap_download_token_hash = NULL WHERE id = ?", [id]);
  assert.equal((await commands(id)).status, 409);
  assert.equal((await download(created.installUrl)).status, 404);
});

test('unreadable credentials do not silently overwrite state and always release the lock', async () => {
  const created = await createNode();
  const id = created.node.id;
  const before = await stored(id);
  process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'b'.repeat(64);
  try { assert.equal((await commands(id)).status, 503); }
  finally { process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'a'.repeat(64); }
  const after = await stored(id);
  assert.equal(after.bootstrap_payload_ciphertext, before.bootstrap_payload_ciphertext);
  assert.equal(after.bootstrap_download_token_hash, before.bootstrap_download_token_hash);
  assert.equal(after.dns_operation_id, null);
});

test('unattended recovery accepts a new attempt after failure and ignores late old receipts', async () => {
  const { node, installUrl } = await createNode();
  const before = await stored(node.id);
  const payload = await decryptBootstrapPayload(before.bootstrap_payload_ciphertext, { nodeId: node.id, generation: 1 });
  const oldAttempt = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const newAttempt = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  async function send(phase, attemptId, outcome) {
    const response = await provision(new Request('https://master.example.test/api/v1/provision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': payload.agentToken, 'X-Agent-Version': '0.8.3' },
      body: JSON.stringify({ protocol: 1, phase, generation: 1, attemptId, ...(outcome ? { outcome } : {}) }),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).disposition;
  }
  assert.equal(await send('start', oldAttempt), 'accepted');
  assert.equal(await send('finish', oldAttempt, 'failed'), 'accepted');
  assert.equal(await send('finish', oldAttempt, 'failed'), 'duplicate');
  assert.equal(await send('start', newAttempt), 'accepted');
  assert.equal(await send('finish', oldAttempt, 'failed'), 'stale');
  assert.equal((await stored(node.id)).provision_attempt_id, newAttempt);
  assert.equal((await stored(node.id)).nyanpass_status, 'provisioning');
  assert.equal(await send('finish', newAttempt, 'succeeded'), 'accepted');
  const after = await stored(node.id);
  assert.equal(after.nyanpass_status, 'ready');
  assert.equal(after.token_hash, before.token_hash);
  assert.equal(after.bootstrap_payload_ciphertext, before.bootstrap_payload_ciphertext);
  assert.equal((await download(installUrl)).status, 200);
});

test('spot replacement: a new machine reinstalls a ready node with the same user data', async () => {
  const { node, installUrl } = await createNode();
  const before = await stored(node.id);
  const payload = await decryptBootstrapPayload(before.bootstrap_payload_ciphertext, { nodeId: node.id, generation: 1 });
  const machineA = 'aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee';
  const machineB = 'bbbbbbbb-2222-4ddd-8eee-ffffffffffff';
  const machineC = 'cccccccc-3333-4eee-8fff-000000000000';
  async function send(phase, attemptId, outcome) {
    const response = await provision(new Request('https://master.example.test/api/v1/provision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': payload.agentToken, 'X-Agent-Version': '0.8.3' },
      body: JSON.stringify({ protocol: 1, phase, generation: 1, attemptId, ...(outcome ? { outcome } : {}) }),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).disposition;
  }
  const instanceStatus = async () => (await q('SELECT status FROM nyanpass_instances WHERE node_id = ?', [node.id]))[0].status;

  assert.equal(await send('start', machineA), 'accepted');
  assert.equal(await send('finish', machineA, 'succeeded'), 'accepted');
  assert.equal((await stored(node.id)).nyanpass_status, 'ready');
  assert.equal(await instanceStatus(), 'success');

  // 实例 A 被回收，新实例 B 用同一份 User data 下载配置并重新安装。
  assert.equal((await download(installUrl)).status, 200);
  assert.equal(await send('start', machineB), 'accepted');
  assert.equal((await stored(node.id)).nyanpass_status, 'provisioning');
  assert.equal(await instanceStatus(), 'bootstrap');
  // B 安装期间，另一台机器 C 不能并发接管。
  assert.equal(await send('start', machineC), 'conflict');
  assert.equal(await send('finish', machineA, 'succeeded'), 'stale');
  assert.equal(await send('finish', machineB, 'succeeded'), 'accepted');
  assert.equal((await stored(node.id)).nyanpass_status, 'ready');
  assert.equal((await stored(node.id)).provision_attempt_id, machineB);
  assert.equal(await instanceStatus(), 'success');

  // B 在安装中途被回收：租约超时后，新实例 C 可以接管。
  assert.equal(await send('start', machineC), 'accepted');
  assert.equal(await send('start', machineA), 'conflict');
  await q('UPDATE nodes SET provision_lease_expires_at = ? WHERE id = ?', [new Date(1000), node.id]);
  assert.equal(await send('start', machineA), 'accepted');
  assert.equal(await send('heartbeat', machineC), 'stale');
  assert.equal(await send('finish', machineA, 'succeeded'), 'accepted');
  const after = await stored(node.id);
  assert.equal(after.nyanpass_status, 'ready');
  assert.equal(after.token_hash, before.token_hash);
  assert.equal(after.bootstrap_download_token_hash, before.bootstrap_download_token_hash);
});

test('instances added later are reinstalled after a spot replacement, and removed ones are not', async () => {
  const { node, installUrl } = await createNode();
  const payloadOf = async () => decryptBootstrapPayload((await stored(node.id)).bootstrap_payload_ciphertext, { nodeId: node.id, generation: 1 });
  const agentToken = (await payloadOf()).agentToken;
  const agentRequest = (url, body) => new Request(url, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': agentToken, 'X-Agent-Version': '0.8.3' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function send(phase, attemptId, outcome) {
    const response = await provision(agentRequest('https://master.example.test/api/v1/provision', { protocol: 1, phase, generation: 1, attemptId, ...(outcome ? { outcome } : {}) }));
    return (await response.json()).disposition;
  }
  const machineA = 'aaaaaaaa-5555-4ccc-8ddd-eeeeeeeeeeee';
  const machineB = 'bbbbbbbb-6666-4ddd-8eee-ffffffffffff';
  assert.equal(await send('start', machineA), 'accepted');
  assert.equal(await send('finish', machineA, 'succeeded'), 'accepted');
  await q('UPDATE nodes SET agent_version = ?, last_task_poll_at = ? WHERE id = ?', ['0.8.3', new Date(), node.id]);

  // 节点运行中追加一个入口实例并同步成功。
  const saved = await addInstance(request({ nodeId: node.id, name: 'awsin2',
    command: 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-t 2f3b9c5c-271d-455e-b0a3-bb01e60c2163 -u https://ny.example.test"' }));
  assert.equal(saved.status, 201, await saved.clone().text());
  const { instance } = await saved.json();
  assert.equal((await queue(request({ id: instance.id }))).status, 200);
  const job = (await (await poll(agentRequest('https://master.example.test/api/v1/tasks'))).json()).job;
  assert.equal((await acknowledge(agentRequest('https://master.example.test/api/v1/tasks', { jobId: job.id, leaseToken: job.leaseToken, outcome: 'succeeded' }))).status, 200);

  const planned = await payloadOf();
  assert.deepEqual(planned.instances.map((item) => [item.name, item.args]), [
    ['test-out', '-o -t abcdefgh-1234 -u https://ny.example.test'],
    ['awsin2', '-t 2f3b9c5c-271d-455e-b0a3-bb01e60c2163 -u https://ny.example.test'],
  ]);
  const row = (await q('SELECT status, bootstrap_generation AS generation, credential_ciphertext AS credential FROM nyanpass_instances WHERE id = ?', [instance.id]))[0];
  assert.deepEqual([row.status, row.generation, row.credential], ['success', 1, null]);
  const config = await (await download(installUrl)).text();
  assert.ok(config.includes('\0awsin2\0'), 'new machines download the added instance');
  assert.ok(config.includes('\0-t 2f3b9c5c-271d-455e-b0a3-bb01e60c2163 -u https://ny.example.test\0'));

  // Spot 替换：新机器重新安装时，后加的实例也进入安装中并随最终回执完成。
  assert.equal(await send('start', machineB), 'accepted');
  const statuses = async () => Object.fromEntries((await q('SELECT name, status FROM nyanpass_instances WHERE node_id = ?', [node.id])).map((item) => [item.name, item.status]));
  assert.deepEqual(await statuses(), { 'test-out': 'bootstrap', awsin2: 'bootstrap' });
  assert.equal(await send('finish', machineB, 'succeeded'), 'accepted');
  assert.deepEqual(await statuses(), { 'test-out': 'success', awsin2: 'success' });

  // 移除登记后，后续换机不再安装它。
  assert.equal((await removeInstance(api(`https://master.example.test/api/admin/nyanpass?id=${instance.id}`, 'DELETE', undefined, adminCookie))).status, 200);
  assert.deepEqual((await payloadOf()).instances.map((item) => item.name), ['test-out']);
});

test('node and instance creation reject service names that could replace managed or system units', async () => {
  for (const name of ['ddns-monitor', 'ssh', 'sshd', 'pulsedns-control', 'systemd-resolved', 'tenant.service', 'tenant.target']) {
    const response = await POST(request({name: 'reserved-test', rootPassword: 'test-password-123',
      nyanpass: [{name, command: 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-t abcdefgh -u https://ny.example.test"'}],
    }));
    assert.equal(response.status, 400, name);
    const instance = await addInstance(request({nodeId: crypto.randomUUID(), name,
      command: 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-t abcdefgh -u https://ny.example.test"',
    }));
    assert.equal(instance.status, 400, name);
  }
});

test('failed and canceled tasks get fresh execution IDs, and old receipts cannot poison a retry', async () => {
  const created = await createNode();
  const node = await stored(created.node.id);
  const payload = await decryptBootstrapPayload(node.bootstrap_payload_ciphertext, {nodeId: node.id, generation: 1});
  await q("UPDATE nodes SET nyanpass_status = 'ready', agent_version = '0.8.3', last_task_poll_at = ? WHERE id = ?", [new Date(), node.id]);
  const clientToken = 'abcdefgh~+123/456=';
  const savedResponse = await addInstance(request({nodeId: node.id, name: 'retry-test',
    command: `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-t ${clientToken} -u https://ny.example.test"`,
  }));
  assert.equal(savedResponse.status, 201);
  const {instance} = await savedResponse.json();
  const agentRequest = (body) => new Request('https://master.example.test/api/v1/tasks', {
    method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json', 'X-Secret-Token': payload.agentToken, 'X-Agent-Version': '0.8.3'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  assert.equal((await queue(request({id: instance.id}))).status, 200);
  const firstResponse = await poll(agentRequest());
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.status, 'job', JSON.stringify({body: firstBody,
    task: (await q('SELECT id, status, error_code FROM agent_tasks WHERE instance_id = ?', [instance.id]))[0],
    instance: (await q('SELECT status, active_task_id, config_revision FROM nyanpass_instances WHERE id = ?', [instance.id]))[0],
    node: (await q('SELECT nyanpass_status, dns_operation_id FROM nodes WHERE id = ?', [node.id]))[0],
  }));
  const first = firstBody.job;
  assert.equal(first.payload.clientToken, clientToken);
  const oldAck = {jobId: first.id, leaseToken: first.leaseToken, outcome: 'failed', errorCode: 'installer_download'};
  assert.equal((await acknowledge(agentRequest(oldAck))).status, 200);
  const requeued = await (await queue(request({id: instance.id}))).json();
  assert.notEqual(requeued.instance.activeTaskId, first.id);
  assert.equal((await acknowledge(agentRequest(oldAck))).status, 404);
  const second = (await (await poll(agentRequest())).json()).job;
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.payload.clientToken, clientToken);
  assert.equal((await acknowledge(agentRequest({...oldAck, jobId: second.id, leaseToken: second.leaseToken}))).status, 200);
  const third = await (await queue(request({id: instance.id}))).json();
  assert.equal((await cancel(api(`https://master.example.test/api/admin/nyanpass/sync?id=${instance.id}`, 'DELETE', undefined, adminCookie))).status, 200);
  const fourth = await (await queue(request({id: instance.id}))).json();
  assert.notEqual(fourth.instance.activeTaskId, third.instance.activeTaskId);
  const finalJob = (await (await poll(agentRequest())).json()).job;
  assert.equal((await acknowledge(agentRequest({jobId: finalJob.id, leaseToken: finalJob.leaseToken, outcome: 'succeeded'}))).status, 200);
  assert.equal((await q('SELECT status FROM nyanpass_instances WHERE id = ?', [instance.id]))[0].status, 'success');
});
