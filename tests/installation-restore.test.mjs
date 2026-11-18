import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, setupTestApp } from './test-app.mjs';

const { database, adminCookie } = await setupTestApp('restore');
const q = (sql, params = []) => database.query(sql, params);
const { POST } = await import('../app/api/admin/nodes/route.ts');
const { GET } = await import('../app/api/v1/bootstrap/[nodeId]/[token]/route.ts');
const { decryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');

const request = (body, cookie = adminCookie) => api('https://master.example.test/api/admin/nodes', 'POST', body, cookie);
const stored = async (id) => (await q('SELECT * FROM nodes WHERE id = ?', [id]))[0];
const outCommand = 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t abcdefgh-1234 -u https://ny.example.test"';
function download(url) {
  const segments = new URL(url).pathname.split('/');
  return GET(new Request(url), { params: Promise.resolve({ nodeId: segments.at(-2), token: segments.at(-1) }) });
}

// 模拟旧版本节点：首次安装完成后面板擦除了开机凭据，实例同步成功后也不再保存凭据。
async function legacyNode() {
  const response = await POST(request({ name: 'legacy-node', rootPassword: 'test-password-123', nyanpass: [{ name: 'legacy-out', command: outCommand }] }));
  assert.equal(response.status, 201);
  const created = await response.json();
  const id = created.node.id;
  const { agentToken } = await decryptBootstrapPayload((await stored(id)).bootstrap_payload_ciphertext, { nodeId: id, generation: 1 });
  await q("UPDATE nodes SET nyanpass_status = 'ready', bootstrap_payload_ciphertext = NULL, bootstrap_download_token_hash = NULL WHERE id = ?", [id]);
  await q("UPDATE nyanpass_instances SET status = 'success', credential_ciphertext = NULL WHERE node_id = ?", [id]);
  const [instance] = await q('SELECT id FROM nyanpass_instances WHERE node_id = ?', [id]);
  return { id, agentToken, instanceId: instance.id, oldUrl: created.installUrl };
}

test('legacy nodes get a permanent install command that keeps the running probe token', async () => {
  const node = await legacyNode();
  const before = await stored(node.id);
  assert.equal((await POST(request({ action: 'installation', id: node.id }))).status, 409);

  const restored = await POST(request({ action: 'restoreInstallation', id: node.id, agentToken: node.agentToken, rootPassword: 'new-root-pass-1', bbrProfile: 'c5in', instances: [{ id: node.instanceId, command: outCommand }] }));
  assert.equal(restored.status, 200, await restored.clone().text());
  const result = await restored.json();
  assert.match(result.connectCommand, /'c5in'$/);
  assert.doesNotMatch(JSON.stringify(result), /new-root-pass-1|pd_[a-f0-9]{64}|abcdefgh-1234/);

  const after = await stored(node.id);
  assert.equal(after.token_hash, before.token_hash, 'the probe keeps its token');
  assert.equal(after.nyanpass_status, 'ready');
  assert.equal(after.dns_operation_id, null);
  const payload = await decryptBootstrapPayload(after.bootstrap_payload_ciphertext, { nodeId: node.id, generation: 1 });
  assert.equal(payload.agentToken, node.agentToken);
  assert.equal(payload.rootPassword, 'new-root-pass-1');
  assert.deepEqual(payload.instances, [{ name: 'legacy-out', optimize: false, args: '-o -t abcdefgh-1234 -u https://ny.example.test' }]);

  // 补存后与新节点一样：多次复制都是同一条，下载链接长期有效。
  for (let index = 0; index < 2; index += 1) {
    const again = await (await POST(request({ action: 'installation', id: node.id }))).json();
    assert.equal(again.connectCommand, result.connectCommand);
    assert.equal(again.startupScript, result.startupScript);
  }
  assert.equal((await download(result.installUrl)).status, 200);
  assert.equal((await download(result.installUrl)).status, 200);
  assert.equal((await download(node.oldUrl)).status, 404);
  assert.equal((await q("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND kind = 'node_installation_restored'", [node.id]))[0].n, 1);

  const twice = await POST(request({ action: 'restoreInstallation', id: node.id, agentToken: node.agentToken, rootPassword: 'new-root-pass-1', instances: [{ id: node.instanceId, command: outCommand }] }));
  assert.equal(twice.status, 409);
});

test('restoring rejects a wrong token, a mismatched command, or no instance at all without changing the node', async () => {
  const node = await legacyNode();
  const base = { action: 'restoreInstallation', id: node.id, agentToken: node.agentToken, rootPassword: 'new-root-pass-1' };
  const cases = [
    [{ ...base, agentToken: `pd_${'0'.repeat(64)}`, instances: [{ id: node.instanceId, command: outCommand }] }, 400],
    [{ ...base, agentToken: 'not-a-token', instances: [{ id: node.instanceId, command: outCommand }] }, 400],
    [{ ...base, rootPassword: 'short', instances: [{ id: node.instanceId, command: outCommand }] }, 400],
    [{ ...base, instances: [{ id: node.instanceId, command: outCommand.replace('-o ', '') }] }, 400],
    [{ ...base, instances: [{ id: node.instanceId, command: outCommand.replace('ny.example.test', 'other.example.test') }] }, 400],
    [{ ...base, instances: [] }, 409],
  ];
  for (const [body, status] of cases) assert.equal((await POST(request(body))).status, status, JSON.stringify(body));
  const after = await stored(node.id);
  assert.equal(after.bootstrap_payload_ciphertext, null);
  assert.equal(after.dns_operation_id, null);
  assert.equal((await POST(request({ ...base, instances: [{ id: node.instanceId, command: outCommand }] }, null))).status, 401);
});
