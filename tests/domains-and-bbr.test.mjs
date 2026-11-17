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

const root = await mkdtemp(join(tmpdir(), 'pulsedns-domains-'));
process.env.PULSEDNS_SELF_HOSTED = '1';
process.env.PULSEDNS_DB_PATH = join(root, 'test.db');
process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PULSEDNS_TEST_ADMIN = '1';
process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'DEFAULTKEY01';
process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'default-secret-01';
// 保存主域名时会向阿里云校验；这里模拟阿里云接受所有请求。
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => new URL(String(input)).host === 'alidns.aliyuncs.com'
  ? Response.json({ RequestId: 'test', DomainRecords: { Record: [] }, Domains: { Domain: [] } })
  : realFetch(input, init);
const { GET: listDomains, POST: addDomain, DELETE: deleteDomain } = await import('../app/api/admin/domains/route.ts');
const { POST: nodesPost, PATCH: nodesPatch } = await import('../app/api/admin/nodes/route.ts');
const { getLocalSqlite } = await import('../db/index.ts');
const { decryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');
after(async () => { (await getLocalSqlite()).close(); await rm(root, { recursive: true, force: true }); });

const json = (url, method, body) => new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const createNode = (overrides = {}) => nodesPost(json('https://master.example.test/api/admin/nodes', 'POST', {
  name: 'aws-jp', rootPassword: 'test-password-123', recordV4: 'jp',
  nyanpass: [
    { name: 'awsin', optimize: true, command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') },
    { name: 'awsout', optimize: true, command: ny('-o -t bbbbbbbb-2222 -u https://ny.example.test') },
  ],
  ...overrides,
}));

test('domains are managed on their own page and nodes may only use listed domains', async () => {
  process.env.PULSEDNS_TEST_ADMIN = '0';
  assert.equal((await listDomains()).status, 401);
  assert.equal((await addDomain(json('https://m/api/admin/domains', 'POST', { name: 'example.com' }))).status, 401);
  process.env.PULSEDNS_TEST_ADMIN = '1';

  assert.equal((await addDomain(json('https://m/api/admin/domains', 'POST', { name: 'not a domain' }))).status, 400);
  assert.equal((await createNode({ domainName: 'example.com' })).status, 400, 'unlisted domain must be rejected');

  assert.equal((await addDomain(json('https://m/api/admin/domains', 'POST', { name: 'Example.COM.' }))).status, 201);
  assert.equal((await addDomain(json('https://m/api/admin/domains', 'POST', { name: 'example.com' }))).status, 409);
  assert.deepEqual((await (await listDomains()).json()).domains.map((domain) => domain.name), ['example.com']);

  const created = await createNode({ domainName: 'example.com' });
  assert.equal(created.status, 201, await created.clone().text());
  const node = await created.json();

  const blocked = await deleteDomain(new Request('https://m/api/admin/domains?name=example.com', { method: 'DELETE' }));
  assert.equal(blocked.status, 409, 'a domain in use cannot be deleted');

  assert.equal((await nodesPatch(json('https://m/api/admin/nodes', 'PATCH', { id: node.node.id, name: 'aws-jp', domainName: 'other.com', recordV4: 'jp', syncEnabled: true }))).status, 400);
  assert.equal((await nodesPatch(json('https://m/api/admin/nodes', 'PATCH', { id: node.node.id, name: 'aws-jp', domainName: '', recordV4: '', syncEnabled: true }))).status, 200);
  assert.equal((await deleteDomain(new Request('https://m/api/admin/domains?name=example.com', { method: 'DELETE' }))).status, 200);
  assert.deepEqual((await (await listDomains()).json()).domains, []);
});

test('BBR profile is chosen per node, defaults to c6in, and OPTIMIZE is always off', async () => {
  assert.equal((await createNode({ name: 'bad-bbr', recordV4: '', bbrProfile: 'c7' })).status, 400);

  const defaulted = await (await createNode({ name: 'default-bbr', recordV4: '' })).json();
  assert.match(defaulted.connectCommand, /probe '[^']+' 'c6in' \)$/);
  assert.match(defaulted.startupScript, /^bbr_profile='c6in'$/m);

  const response = await createNode({ name: 'c5in-node', recordV4: '', bbrProfile: 'c5in' });
  assert.equal(response.status, 201);
  const c5in = await response.json();
  assert.match(c5in.connectCommand, /probe '[^']+' 'c5in' \)$/);
  assert.match(c5in.startupScript, /^bbr_profile='c5in'$/m);
  assert.ok(c5in.instances.every((instance) => instance.optimize === false));

  const sqlite = await getLocalSqlite();
  const row = sqlite.prepare('SELECT bootstrap_payload_ciphertext AS ciphertext, region FROM nodes WHERE id = ?').get(c5in.node.id);
  assert.equal(row.region, 'unknown');
  const payload = await decryptBootstrapPayload(row.ciphertext, { nodeId: c5in.node.id, generation: 1 });
  assert.equal(payload.bbrProfile, 'c5in');
  assert.ok(payload.instances.every((instance) => instance.optimize === false));

  const again = await (await nodesPost(json('https://master.example.test/api/admin/nodes', 'POST', { action: 'installation', id: c5in.node.id }))).json();
  assert.equal(again.startupScript, c5in.startupScript);
  assert.equal(again.connectCommand, c5in.connectCommand);
});
