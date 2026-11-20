import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { api, setupTestApp } from './test-app.mjs';

process.env.PULSEDNS_TRUST_PROXY = '1';

// 有状态的阿里云 DNS 模拟：记录值与启用/暂停状态都会保存，便于检查暂停与恢复。
const records = new Map();
const failPause = new Set();
let nextRecordId = 1;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.host !== 'alidns.aliyuncs.com') return realFetch(input, init);
  const action = init.headers['x-acs-action'];
  const p = (name) => url.searchParams.get(name);
  const all = () => [...records.values()];
  if (action === 'DescribeDomains') return Response.json({ Domains: { Domain: [] } });
  if (action === 'DescribeDomainRecords') {
    const rows = all().filter((row) => row.domain === p('DomainName') && (!p('RRKeyWord') || row.RR === p('RRKeyWord')) && (!p('TypeKeyWord') || row.Type === p('TypeKeyWord')));
    return Response.json({ DomainRecords: { Record: rows.map(({ domain, ...row }) => row) } });
  }
  if (action === 'AddDomainRecord') {
    const RecordId = String(nextRecordId++);
    records.set(RecordId, { RecordId, domain: p('DomainName'), RR: p('RR'), Type: p('Type'), Value: p('Value'), Line: 'default', Status: 'ENABLE' });
    return Response.json({ RecordId });
  }
  if (action === 'UpdateDomainRecord') {
    records.get(p('RecordId')).Value = p('Value');
    return Response.json({ RecordId: p('RecordId') });
  }
  if (action === 'SetDomainRecordStatus') {
    const row = records.get(p('RecordId'));
    if (p('Status') === 'Disable' && failPause.has(`${row.RR}.${row.domain}`)) return Response.json({ Code: 'Throttling', Message: 'Throttling' }, { status: 400 });
    row.Status = p('Status') === 'Disable' ? 'DISABLE' : 'ENABLE';
    return Response.json({ RecordId: p('RecordId'), Status: p('Status') });
  }
  return Response.json({ Code: 'UnknownAction' }, { status: 400 });
};
const lookup = (rr, domain, type = 'A') => [...records.values()].find((row) => row.RR === rr && row.domain === domain && row.Type === type);

const { database, db, adminCookie, createUser, sessionFor } = await setupTestApp('assign');
const nodesRoute = await import('../app/api/admin/nodes/route.ts');
const sharesRoute = await import('../app/api/admin/node-shares/route.ts');
const dnsRoute = await import('../app/api/admin/node-dns/route.ts');
const settingsRoute = await import('../app/api/admin/settings/route.ts');
const accountsRoute = await import('../app/api/admin/aliyun-accounts/route.ts');
const domainsRoute = await import('../app/api/admin/domains/route.ts');
const usersRoute = await import('../app/api/admin/users/route.ts');
const reportRoute = await import('../app/api/v1/report/route.ts');
const { listDnsRecords } = await import('../lib/dashboard-data.ts');

const url = 'https://panel.test/api/x';
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const json = async (response) => ({ status: response.status, body: await response.json() });

async function addDomain(cookie, keyId, domain) {
  const account = await json(await accountsRoute.POST(api(url, 'POST', { name: `${domain}-key`, accessKeyId: keyId, accessKeySecret: `${keyId}-secret` }, cookie)));
  assert.equal(account.status, 201, JSON.stringify(account.body));
  assert.equal((await domainsRoute.POST(api(url, 'POST', { name: domain, accountId: account.body.account.id }, cookie))).status, 201);
}

await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie));
const tenantUser = await createUser('tenant', 'tenant-password-123');
const tenant = await sessionFor('tenant');
await addDomain(adminCookie, 'ADMINKEY0001', 'admin.example');
await addDomain(adminCookie, 'ADMINKEY0002', 'second.example');
await addDomain(tenant, 'TENANTKEY001', 'tenant.example');

const created = await json(await nodesRoute.POST(api(url, 'POST', {
  name: 'aws-jp', rootPassword: 'test-password-123', domainName: 'admin.example', recordV4: 'jp1',
  nyanpass: [{ name: 'awsin', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }],
}, adminCookie)));
assert.equal(created.status, 201, JSON.stringify(created.body));
const nodeId = created.body.node.id;
const nodeToken = 'pd_assignment_test_token';
await database.query("UPDATE nodes SET token_hash = ?, nyanpass_status = 'ready', ipv4 = '198.51.100.10' WHERE id = ?", [createHash('sha256').update(nodeToken).digest('hex'), nodeId]);
const report = (ip) => reportRoute.POST(new Request('https://panel.test/api/v1/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Token': nodeToken }, body: JSON.stringify({ ip, type: 'A' }) }));
const assign = (body, cookie = adminCookie) => dnsRoute.POST(api(url, 'POST', { nodeId, userId: tenantUser.id, ...body }, cookie));

test('the admin assigns a record on their own domain that follows the machine, and the user cannot remove it', async () => {
  assert.equal((await assign({ domainName: 'second.example', recordV4: 'jp2' })).status, 404, 'not shared yet');
  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId, userId: tenantUser.id }, adminCookie))).status, 201);
  assert.equal((await assign({ domainName: 'tenant.example', recordV4: 'jp2' })).status, 400, 'only the admin\'s own domains');

  const assigned = await json(await assign({ domainName: 'second.example', recordV4: 'jp2' }));
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.record.ownerId, tenantUser.id);
  assert.equal(assigned.body.record.assigned, true);
  assert.equal(lookup('jp2', 'second.example').Value, '198.51.100.10');

  // 普通用户传 userId 也只会给自己加，且不能删除管理员分配的那条。
  const own = await json(await assign({ domainName: 'tenant.example', recordV4: 'mine' }, tenant));
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.record.assigned, false);
  const visible = await listDnsRecords(db, { id: tenantUser.id, username: 'tenant', role: 'user' });
  assert.deepEqual(visible.map((record) => [record.recordV4, record.assigned]).sort(), [['jp2', true], ['mine', false]]);
  const removal = await dnsRoute.DELETE(api(`${url}?id=${assigned.body.record.id}`, 'DELETE', undefined, tenant));
  assert.equal(removal.status, 403);

  assert.equal((await report('198.51.100.20')).status, 200);
  assert.equal(lookup('jp2', 'second.example').Value, '198.51.100.20', 'DDNS keeps syncing the assigned record');
  assert.equal(lookup('jp1', 'admin.example').Value, '198.51.100.20');
});

test('unsharing stops syncing and pauses every record of that user on Aliyun; reassigning resumes it', async () => {
  const unshared = await json(await sharesRoute.DELETE(api(`${url}?nodeId=${nodeId}&userId=${tenantUser.id}`, 'DELETE', undefined, adminCookie)));
  assert.equal(unshared.status, 200, JSON.stringify(unshared.body));
  assert.deepEqual(unshared.body.warnings, []);
  assert.equal(lookup('jp2', 'second.example').Status, 'DISABLE');
  assert.equal(lookup('mine', 'tenant.example').Status, 'DISABLE');
  assert.equal(lookup('jp1', 'admin.example').Status, 'ENABLE', 'the owner\'s record is untouched');
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM node_dns_records WHERE node_id = ?', [nodeId]))[0].n, 0);
  assert.equal((await database.query("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND kind = 'dns_paused'", [nodeId]))[0].n, 2);

  assert.equal((await report('198.51.100.30')).status, 200);
  assert.equal(lookup('jp2', 'second.example').Value, '198.51.100.20', 'no longer synced');

  assert.equal((await sharesRoute.POST(api(url, 'POST', { nodeId, userId: tenantUser.id }, adminCookie))).status, 201);
  assert.equal((await assign({ domainName: 'second.example', recordV4: 'jp2' })).status, 201);
  assert.equal(lookup('jp2', 'second.example').Status, 'ENABLE');
  assert.equal(lookup('jp2', 'second.example').Value, '198.51.100.30');
});

test('a failed Aliyun pause still unshares but is reported and logged', async () => {
  failPause.add('jp2.second.example');
  const unshared = await json(await sharesRoute.DELETE(api(`${url}?nodeId=${nodeId}&userId=${tenantUser.id}`, 'DELETE', undefined, adminCookie)));
  failPause.clear();
  assert.equal(unshared.status, 200);
  assert.equal(unshared.body.warnings.length, 1);
  assert.match(unshared.body.warnings[0], /jp2\.second\.example/);
  assert.equal((await database.query("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND kind = 'dns_pause_failed' AND level = 'error'", [nodeId]))[0].n, 1);
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM node_shares WHERE node_id = ?', [nodeId]))[0].n, 0);
});

test('the admin can rename any user including themselves; others cannot', async () => {
  const [adminRow] = await database.query("SELECT id FROM users WHERE role = 'admin'");
  const rename = (id, username, cookie = adminCookie) => usersRoute.PATCH(api(url, 'PATCH', { id, username }, cookie));
  assert.equal((await rename(tenantUser.id, 'renamed', tenant)).status, 403);
  assert.equal((await rename(tenantUser.id, 'x')).status, 400);
  assert.equal((await rename(tenantUser.id, 'admin')).status, 409);
  assert.equal((await rename('missing-user', 'someone')).status, 404);
  assert.equal((await rename(tenantUser.id, 'tenant2')).status, 200);
  assert.equal((await rename(adminRow.id, 'root-admin')).status, 200);
  const names = (await database.query('SELECT username FROM users ORDER BY username')).map((row) => row.username);
  assert.deepEqual(names, ['root-admin', 'tenant2']);
  // 已登录的会话不受改名影响。
  assert.equal((await usersRoute.GET(api(url, 'GET', undefined, adminCookie))).status, 200);
  assert.equal((await dnsRoute.POST(api(url, 'POST', { nodeId, domainName: 'tenant.example', recordV4: 'x' }, tenant))).status, 404, 'tenant session still valid (not shared any more)');
});
