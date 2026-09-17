import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

register('./path-alias-loader.mjs', import.meta.url);
const authSource = `export async function getChatGPTUser() {
  return process.env.PULSEDNS_TEST_ADMIN === '1' ? { email: 'admin@example.test' } : null;
}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/app/chatgpt-auth') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(authSource)}`)}, shortCircuit: true };
  return nextResolve(specifier, context);
}`)}`, import.meta.url);

const root = await mkdtemp(join(tmpdir(), 'pulsedns-recopy-'));
process.env.PULSEDNS_SELF_HOSTED = '1';
process.env.PULSEDNS_DB_PATH = join(root, 'test.db');
process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PULSEDNS_TEST_ADMIN = '1';
const { POST } = await import('../app/api/admin/nodes/route.ts');
const { GET } = await import('../app/api/v1/bootstrap/[nodeId]/[token]/route.ts');
const { POST: provision } = await import('../app/api/v1/provision/route.ts');
const { getLocalSqlite } = await import('../db/index.ts');
const { decryptBootstrapPayload, encryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');
after(async () => { (await getLocalSqlite()).close(); await rm(root, { recursive: true, force: true }); });

const request = (body) => new Request('https://master.example.test/api/admin/nodes', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const commands = (id) => POST(request({ action: 'installation', id }));
const stored = async (id) => (await getLocalSqlite()).prepare('SELECT * FROM nodes WHERE id = ?').get(id);
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
  process.env.PULSEDNS_TEST_ADMIN = '0';
  assert.equal((await commands('11111111-2222-4333-8444-555555555555')).status, 401);
  process.env.PULSEDNS_TEST_ADMIN = '1';
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

test('expired links are renewed without resetting a failed attempt or leaking credentials', async () => {
  const created = await createNode();
  const id = created.node.id;
  const sqlite = await getLocalSqlite();
  sqlite.prepare("UPDATE nodes SET bootstrap_download_expires_at = 1, nyanpass_status = 'failed', provision_attempt_id = 'old-attempt', provision_last_completed_step = 'ddns' WHERE id = ?").run(id);
  const before = await stored(id);
  const response = await commands(id);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.installUrl, created.installUrl);
  assert.equal(result.node.id, id);
  assert.doesNotMatch(JSON.stringify(result), /test-password-123|pd_[a-f0-9]{64}|abcdefg/);
  const after = await stored(id);
  for (const column of ['token_hash', 'provision_generation', 'provision_attempt_id', 'provision_last_completed_step', 'nyanpass_status']) {
    assert.equal(after[column], before[column], column);
  }
  assert.equal((await download(created.installUrl)).status, 404);
  assert.equal((await download(result.installUrl)).status, 200);
});

test('legacy encrypted payloads can issue new commands without deleting the node', async () => {
  const created = await createNode();
  const id = created.node.id;
  const context = { nodeId: id, generation: 1 };
  const before = await stored(id);
  const payload = await decryptBootstrapPayload(before.bootstrap_payload_ciphertext, context);
  delete payload.downloadToken;
  const legacy = await encryptBootstrapPayload(payload, context);
  (await getLocalSqlite()).prepare('UPDATE nodes SET bootstrap_payload_ciphertext = ? WHERE id = ?').run(legacy, id);
  const response = await commands(id);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.installUrl, created.installUrl);
  assert.equal((await download(result.installUrl)).status, 200);
});

test('active installs cannot have expired credentials rotated, completed secrets stay revoked', async () => {
  const created = await createNode();
  const id = created.node.id;
  const sqlite = await getLocalSqlite();
  sqlite.prepare("UPDATE nodes SET bootstrap_download_expires_at = 1, nyanpass_status = 'provisioning', provision_lease_expires_at = ? WHERE id = ?").run(Date.now() + 60000, id);
  const before = await stored(id);
  assert.equal((await commands(id)).status, 409);
  assert.equal((await stored(id)).bootstrap_download_token_hash, before.bootstrap_download_token_hash);
  sqlite.prepare("UPDATE nodes SET nyanpass_status = 'ready', bootstrap_payload_ciphertext = NULL, bootstrap_download_token_hash = NULL WHERE id = ?").run(id);
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
  assert.equal(after.bootstrap_payload_ciphertext, null);
  assert.equal((await download(installUrl)).status, 404);
});
