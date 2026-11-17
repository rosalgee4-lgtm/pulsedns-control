import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { installAliyunMock } from './aliyun-mock.mjs';
import { api, setupTestApp } from './test-app.mjs';

process.env.PULSEDNS_TRUST_PROXY = '1';
const aliyunCalls = installAliyunMock({
  ADMINKEY0001: { domains: ['admin.example'] },
  TENANTKEY001: { domains: ['tenant.example'] },
  OTHERKEY0001: { domains: ['other.example'] },
});
const { database, adminCookie, createUser, sessionFor } = await setupTestApp('sharing');
const nodesRoute = await import('../app/api/admin/nodes/route.ts');
const nyanpassRoute = await import('../app/api/admin/nyanpass/route.ts');
const syncRoute = await import('../app/api/admin/nyanpass/sync/route.ts');
const sharesRoute = await import('../app/api/admin/node-shares/route.ts');
const dnsRoute = await import('../app/api/admin/node-dns/route.ts');
const settingsRoute = await import('../app/api/admin/settings/route.ts');
const accountsRoute = await import('../app/api/admin/aliyun-accounts/route.ts');
const domainsRoute = await import('../app/api/admin/domains/route.ts');
const usersRoute = await import('../app/api/admin/users/route.ts');
const reportRoute = await import('../app/api/v1/report/route.ts');

const url = 'https://panel.test/api/x';
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const json = async (response) => ({ status: response.status, body: await response.json() });
const view = async (cookie) => (await nyanpassRoute.GET(api(url, 'GET', undefined, cookie))).json();

async function addDomain(cookie, keyId, domain) {
  const account = await json(await accountsRoute.POST(api(url, 'POST', { name: `${domain}-key`, accessKeyId: keyId, accessKeySecret: `${keyId}-secret` }, cookie)));
  assert.equal(account.status, 201, JSON.stringify(account.body));
  assert.equal((await domainsRoute.POST(api(url, 'POST', { name: domain, accountId: account.body.account.id }, cookie))).status, 201);
}

async function report(token, ip) {
  return reportRoute.POST(new Request('https://panel.test/api/v1/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': token }, body: JSON.stringify({ ip, type: 'A' }) }));
}

await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie));
const tenantUser = await createUser('tenant', 'tenant-password-123');
const otherUser = await createUser('other', 'other-password-123');
const tenant = await sessionFor('tenant');
const other = await sessionFor('other');
await addDomain(adminCookie, 'ADMINKEY0001', 'admin.example');
await addDomain(tenant, 'TENANTKEY001', 'tenant.example');
await addDomain(other, 'OTHERKEY0001', 'other.example');

const created = await json(await nodesRoute.POST(api(url, 'POST', {
  name: 'aws-sg', rootPassword: 'test-password-123', domainName: 'admin.example', recordV4: 'sg',
  nyanpass: [{ name: 'awsin', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }],
}, adminCookie)));
assert.equal(created.status, 201, JSON.stringify(created.body));
const nodeId = created.body.node.id;
const nodeToken = 'pd_sharing_test_token';
await database.query("UPDATE nodes SET token_hash = ?, nyanpass_status = 'ready', ipv4 = '198.51.100.10', agent_version = '2.0.0', last_task_poll_at = ? WHERE id = ?", [createHash('sha256').update(nodeToken).digest('hex'), new Date(), nodeId]);
await database.query("UPDATE nyanpass_instances SET status = 'success' WHERE node_id = ?", [nodeId]);
const adminInstanceId = created.body.instances[0].id;

test('only the admin can share a machine, and only with normal users who do not own it', async () => {
  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId, userId: otherUser.id }, tenant))).status, 403);
  const [adminRow] = await database.query("SELECT id FROM users WHERE role = 'admin'");
  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId, userId: adminRow.id }, adminCookie))).status, 400);
  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId: 'missing', userId: tenantUser.id }, adminCookie))).status, 404);

  assert.equal((await view(tenant)).nodes.length, 0, 'not shared yet');
  const shared = await json(await sharesRoute.POST(api(url, 'POST', { nodeId, userId: tenantUser.id }, adminCookie)));
  assert.equal(shared.status, 201);
  assert.deepEqual(shared.body.share, { nodeId, userId: tenantUser.id, username: 'tenant' });
  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId, userId: tenantUser.id }, adminCookie))).status, 409);

  const adminView = await view(adminCookie);
  assert.deepEqual(adminView.nodes.find((node) => node.id === nodeId).sharedWith, [{ userId: tenantUser.id, username: 'tenant' }]);
});

test('the shared user sees the machine and everything on it read-only, but no install secrets', async () => {
  const tenantView = await view(tenant);
  assert.deepEqual(tenantView.nodes.map((node) => [node.name, node.sharedWithMe, node.sharedWith]), [['aws-sg', true, []]]);
  assert.deepEqual(tenantView.instances.map((instance) => [instance.name, instance.ownerName]), [['awsin', 'admin']]);
  assert.ok(tenantView.events.length > 0 && tenantView.events.every((event) => event.nodeId === nodeId), 'all events of the shared machine');
  assert.equal(JSON.stringify(tenantView).includes('test-password-123'), false);

  assert.equal((await nodesRoute.POST(api(url, 'POST', { action: 'installation', id: nodeId }, tenant))).status, 404, 'no install command or startup script');
  assert.equal((await nodesRoute.PATCH(api(url, 'PATCH', { id: nodeId, name: 'taken', domainName: '', recordV4: '', syncEnabled: true }, tenant))).status, 404);
  assert.equal((await nodesRoute.DELETE(api(`${url}?id=${nodeId}&confirmProvisioning=checked`, 'DELETE', undefined, tenant))).status, 404);
  assert.equal((await nyanpassRoute.PATCH(api(url, 'PATCH', { id: adminInstanceId, name: 'awsin', command: ny('-t bbbbbbbb-2222 -u https://ny.example.test') }, tenant))).status, 404, 'cannot edit the admin instance');
  assert.equal((await nyanpassRoute.DELETE(api(`${url}?id=${adminInstanceId}`, 'DELETE', undefined, tenant))).status, 404);
  assert.equal((await syncRoute.POST(api(url, 'POST', { id: adminInstanceId }, tenant))).status, 404);

  assert.equal((await view(other)).nodes.length, 0, 'users it was not shared with see nothing');
});

test('the shared user adds their own Nyanpass instance and only they (or the admin) can change it', async () => {
  const added = await json(await nyanpassRoute.POST(api(url, 'POST', { nodeId, name: 'tenant-out', command: ny('-o -t cccccccc-3333 -u https://ny.example.test') }, tenant)));
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.instance.ownerId, tenantUser.id);
  assert.equal((await nyanpassRoute.POST(api(url, 'POST', { nodeId, name: 'x', command: ny('-t dddddddd-4444 -u https://ny.example.test') }, other))).status, 404);

  const adminView = await view(adminCookie);
  assert.equal(adminView.instances.find((instance) => instance.name === 'tenant-out').ownerName, 'tenant');
  const patched = await nyanpassRoute.PATCH(api(url, 'PATCH', { id: added.body.instance.id, name: 'tenant-out', command: ny('-o -t eeeeeeee-5555 -u https://ny.example.test') }, tenant));
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).instance.ownerName, 'tenant');
  const queued = await syncRoute.POST(api(url, 'POST', { id: added.body.instance.id }, tenant));
  assert.equal(queued.status, 200, await queued.clone().text());
  assert.equal((await queued.json()).instance.ownerId, tenantUser.id, 'the sync response keeps the owner');
});

test('the shared user adds DNS records with their own domain; they sync now and on every IP change', async () => {
  assert.equal((await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'admin.example', recordV4: 'x' }, tenant))).status, 400, 'cannot use the admin domain');
  assert.equal((await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'other.example', recordV4: 'x' }, other))).status, 404, 'not shared with other');
  assert.equal((await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'tenant.example' }, tenant))).status, 400, 'needs a record');

  aliyunCalls.length = 0;
  const first = await json(await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'tenant.example', recordV4: 'hk' }, tenant)));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body.warnings, []);
  assert.ok(aliyunCalls.some((call) => call.action === 'AddDomainRecord' && call.keyId === 'TENANTKEY001' && call.domain === 'tenant.example'), 'synced right away with the tenant key');
  const second = await json(await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'tenant.example', recordV4: 'hk2', recordV6: 'hk2' }, tenant)));
  assert.equal(second.status, 201);
  assert.equal((await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'tenant.example', recordV4: 'hk' }, tenant))).status, 409, 'the same record cannot be added twice');

  const tenantRecords = (await view(tenant)).dnsRecords;
  assert.deepEqual(tenantRecords.map((record) => [record.recordV4, record.ownerName]), [['hk', 'tenant'], ['hk2', 'tenant']]);
  assert.equal((await view(adminCookie)).dnsRecords.length, 2, 'the admin sees them too');

  aliyunCalls.length = 0;
  const reported = await report(nodeToken, '198.51.100.20');
  assert.equal(reported.status, 200, await reported.clone().text());
  const synced = aliyunCalls.filter((call) => call.action === 'AddDomainRecord');
  assert.deepEqual(synced.map((call) => [call.keyId, call.domain]).sort(), [['ADMINKEY0001', 'admin.example'], ['TENANTKEY001', 'tenant.example'], ['TENANTKEY001', 'tenant.example']]);
  const messages = (await view(tenant)).events.map((event) => event.message);
  assert.ok(messages.includes('A 记录 hk.tenant.example 已同步'));
  assert.ok(messages.includes('A 记录 hk2.tenant.example 已同步'));

  assert.equal((await domainsRoute.DELETE(api(`${url}?name=tenant.example`, 'DELETE', undefined, tenant))).status, 409, 'a domain in use by a shared record cannot be deleted');
  assert.equal((await usersRoute.DELETE(api(`${url}?id=${tenantUser.id}`, 'DELETE', undefined, adminCookie))).status, 409);

  const removed = await dnsRoute.DELETE(api(`${url}?id=${second.body.record.id}`, 'DELETE', undefined, other));
  assert.equal(removed.status, 404, 'others cannot remove it');
  assert.equal((await dnsRoute.DELETE(api(`${url}?id=${second.body.record.id}`, 'DELETE', undefined, tenant))).status, 200);
  assert.equal((await view(tenant)).dnsRecords.length, 1);
});

test('unsharing waits for running syncs, then removes the user\'s instances and records from the machine', async () => {
  const blocked = await json(await sharesRoute.DELETE(api(`${url}?nodeId=${nodeId}&userId=${tenantUser.id}`, 'DELETE', undefined, adminCookie)));
  assert.equal(blocked.status, 409, 'the queued tenant sync blocks unsharing');
  assert.match(blocked.body.error, /tenant-out/);
  const [instance] = await database.query("SELECT id FROM nyanpass_instances WHERE name = 'tenant-out'");
  assert.equal((await syncRoute.DELETE(api(`${url}?id=${instance.id}`, 'DELETE', undefined, tenant))).status, 200, 'cancel the queued sync');

  assert.equal((await sharesRoute.DELETE(api(`${url}?nodeId=${nodeId}&userId=${tenantUser.id}`, 'DELETE', undefined, tenant))).status, 403);
  const done = await json(await sharesRoute.DELETE(api(`${url}?nodeId=${nodeId}&userId=${tenantUser.id}`, 'DELETE', undefined, adminCookie)));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.removedInstances, done.body.removedRecords], [1, 1]);

  const tenantView = await view(tenant);
  assert.deepEqual([tenantView.nodes.length, tenantView.instances.length, tenantView.dnsRecords.length, tenantView.events.length], [0, 0, 0, 0]);
  const adminView = await view(adminCookie);
  assert.deepEqual(adminView.instances.map((item) => item.name), ['awsin'], 'the admin instance stays');
  assert.deepEqual(adminView.nodes.find((node) => node.id === nodeId).sharedWith, []);

  aliyunCalls.length = 0;
  await report(nodeToken, '198.51.100.30');
  assert.ok(aliyunCalls.every((call) => call.keyId !== 'TENANTKEY001'), 'tenant records no longer sync');
  assert.equal((await usersRoute.DELETE(api(`${url}?id=${tenantUser.id}`, 'DELETE', undefined, adminCookie))).status, 409, 'still owns a domain');
});
