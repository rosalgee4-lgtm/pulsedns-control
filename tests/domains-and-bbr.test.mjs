import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installAliyunMock } from './aliyun-mock.mjs';
import { api, setupTestApp } from './test-app.mjs';

installAliyunMock({ ACCOUNTA0001: { domains: ['example.com'] } });
const { database, adminCookie } = await setupTestApp('domains');
const { GET: listDomains, POST: addDomain, DELETE: deleteDomain } = await import('../app/api/admin/domains/route.ts');
const { POST: addAccount } = await import('../app/api/admin/aliyun-accounts/route.ts');
const { POST: nodesPost, PATCH: nodesPatch } = await import('../app/api/admin/nodes/route.ts');
const { decryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');

const url = 'https://panel.test/api/admin/x';
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const createNode = (overrides = {}) => nodesPost(api(url, 'POST', {
  name: 'aws-jp', rootPassword: 'test-password-123', recordV4: 'jp',
  nyanpass: [
    { name: 'awsin', optimize: true, command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') },
    { name: 'awsout', optimize: true, command: ny('-o -t bbbbbbbb-2222 -u https://ny.example.test') },
  ],
  ...overrides,
}, adminCookie));

test('domains are managed on their own page and nodes may only use listed domains', async () => {
  assert.equal((await listDomains(api(url))).status, 401);
  assert.equal((await addDomain(api(url, 'POST', { name: 'example.com' }))).status, 401);

  const account = await (await addAccount(api(url, 'POST', { name: '主账号', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' }, adminCookie))).json();
  assert.equal((await addDomain(api(url, 'POST', { name: 'not a domain', accountId: account.account.id }, adminCookie))).status, 400);
  assert.equal((await createNode({ domainName: 'example.com' })).status, 400, 'unlisted domain must be rejected');

  assert.equal((await addDomain(api(url, 'POST', { name: 'Example.COM.', accountId: account.account.id }, adminCookie))).status, 201);
  assert.equal((await addDomain(api(url, 'POST', { name: 'example.com', accountId: account.account.id }, adminCookie))).status, 409);
  assert.deepEqual((await (await listDomains(api(url, 'GET', undefined, adminCookie))).json()).domains.map((domain) => domain.name), ['example.com']);

  const created = await createNode({ domainName: 'example.com' });
  assert.equal(created.status, 201, await created.clone().text());
  const node = await created.json();

  const blocked = await deleteDomain(api('https://panel.test/api/admin/domains?name=example.com', 'DELETE', undefined, adminCookie));
  assert.equal(blocked.status, 409, 'a domain in use cannot be deleted');

  assert.equal((await nodesPatch(api(url, 'PATCH', { id: node.node.id, name: 'aws-jp', domainName: 'other.com', recordV4: 'jp', syncEnabled: true }, adminCookie))).status, 400);
  assert.equal((await nodesPatch(api(url, 'PATCH', { id: node.node.id, name: 'aws-jp', domainName: '', recordV4: '', syncEnabled: true }, adminCookie))).status, 200);
  assert.equal((await deleteDomain(api('https://panel.test/api/admin/domains?name=example.com', 'DELETE', undefined, adminCookie))).status, 200);
  assert.deepEqual((await (await listDomains(api(url, 'GET', undefined, adminCookie))).json()).domains, []);
});

test('BBR profile is chosen per node, defaults to c6in, and OPTIMIZE is always off', async () => {
  assert.equal((await createNode({ name: 'bad-bbr', recordV4: '', bbrProfile: 'c7' })).status, 400);

  const defaulted = await (await createNode({ name: 'default-bbr', recordV4: '' })).json();
  assert.match(defaulted.connectCommand, /^wget -O '\/root\/default-bbr_c6in_install\.sh' .* probe '[^']+' 'c6in'$/);
  assert.match(defaulted.startupScript, /^bbr_profile='c6in'$/m);

  const response = await createNode({ name: 'c5in-node', recordV4: '', bbrProfile: 'c5in' });
  assert.equal(response.status, 201);
  const c5in = await response.json();
  assert.match(c5in.connectCommand, /^wget -O '\/root\/c5in-node_c5in_install\.sh' .* probe '[^']+' 'c5in'$/);
  assert.match(c5in.startupScript, /^bbr_profile='c5in'$/m);
  assert.ok(c5in.instances.every((instance) => instance.optimize === false));

  const [row] = await database.query('SELECT bootstrap_payload_ciphertext AS ciphertext, region FROM nodes WHERE id = ?', [c5in.node.id]);
  assert.equal(row.region, 'unknown');
  const payload = await decryptBootstrapPayload(row.ciphertext, { nodeId: c5in.node.id, generation: 1 });
  assert.equal(payload.bbrProfile, 'c5in');
  assert.ok(payload.instances.every((instance) => instance.optimize === false));

  const again = await (await nodesPost(api(url, 'POST', { action: 'installation', id: c5in.node.id }, adminCookie))).json();
  assert.equal(again.startupScript, c5in.startupScript);
  assert.equal(again.connectCommand, c5in.connectCommand);
});
