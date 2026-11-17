import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installAliyunMock } from './aliyun-mock.mjs';
import { api, setupTestApp } from './test-app.mjs';

const calls = installAliyunMock({
  ACCOUNTA0001: { domains: ['a-one.com', 'a-two.com'] },
  ACCOUNTB0001: { domains: ['b-one.com'] },
  ROTATEDA0001: { domains: ['a-one.com', 'a-two.com'] },
  SCOPEDKEY001: { domains: ['scoped.com'], scoped: true },
  MEMBERKEY001: { domains: ['member.com'] },
});
const { database, adminCookie, createUser, sessionFor } = await setupTestApp('aliyun');
const accountsRoute = await import('../app/api/admin/aliyun-accounts/route.ts');
const domainsRoute = await import('../app/api/admin/domains/route.ts');
const { POST: setMultiUser } = { POST: (await import('../app/api/admin/settings/route.ts')).PATCH };
const { syncAliDnsRecord } = await import('../lib/alidns.ts');

const url = 'https://panel.test/api/admin/x';
const addAccount = (body, cookie = adminCookie) => accountsRoute.POST(api(url, 'POST', body, cookie));
const addDomain = (body, cookie = adminCookie) => domainsRoute.POST(api(url, 'POST', body, cookie));
const listAccounts = async (cookie = adminCookie) => (await (await accountsRoute.GET(api(url, 'GET', undefined, cookie))).json()).accounts;

test('aliyun accounts require login, are verified, encrypted, and only shown as head/tail', async () => {
  assert.equal((await accountsRoute.GET(api(url))).status, 401);
  assert.equal((await addAccount({ name: 'x', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' }, null)).status, 401);

  assert.equal((await addAccount({ name: '', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' })).status, 400);
  assert.equal((await addAccount({ name: 'bad', accessKeyId: 'short', accessKeySecret: 'secret-a-0001' })).status, 400);
  const invalid = await addAccount({ name: 'bad', accessKeyId: 'UNKNOWNKEY01', accessKeySecret: 'secret-x-0001' });
  assert.equal(invalid.status, 400, 'a key Aliyun rejects is not saved');
  assert.match((await invalid.json()).error, /InvalidAccessKeyId/);

  const created = await addAccount({ name: '主账号', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secretvalue-a-0001' });
  assert.equal(created.status, 201);
  assert.deepEqual(
    (({ accessKeyId, accessKeySecret }) => ({ accessKeyId, accessKeySecret }))((await created.json()).account),
    { accessKeyId: 'ACCO****0001', accessKeySecret: 'secr****0001' },
  );
  assert.equal((await addAccount({ name: '主账号', accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' })).status, 409);
  assert.equal((await addAccount({ name: '合租', accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' })).status, 201);
  // RAM 子账号只授权了部分域名时，列出域名会被拒，但 Key 本身有效。
  assert.equal((await addAccount({ name: '子账号', accessKeyId: 'SCOPEDKEY001', accessKeySecret: 'secret-s-0001' })).status, 201);

  const text = JSON.stringify(await listAccounts());
  for (const leaked of ['secretvalue-a-0001', 'ACCOUNTA0001', 'secret-b-0001', 'ACCOUNTB0001']) assert.ok(!text.includes(leaked), `${leaked} must never be returned`);

  const stored = await database.query('SELECT key_ciphertext AS c, access_key_id_hint AS idHint, access_key_secret_hint AS secretHint FROM aliyun_accounts');
  for (const row of stored) {
    assert.ok(row.c.startsWith('v1.'));
    for (const plain of ['ACCOUNTA0001', 'ACCOUNTB0001', 'SCOPEDKEY001', 'secret']) assert.ok(!row.c.includes(plain), 'AccessKey ID and Secret are stored encrypted');
    assert.match(row.idHint, /^.{4}\*{4}.{4}$/);
    assert.match(row.secretHint, /^.{4}\*{4}.{4}$/);
  }
});

test('each main domain uses its own account key, checked on save and used for DNS sync', async () => {
  const accounts = await listAccounts();
  const id = (name) => accounts.find((account) => account.name === name).id;

  assert.equal((await addDomain({ name: 'a-one.com', accountId: '' })).status, 400, 'an account must be chosen');
  const wrong = await addDomain({ name: 'b-one.com', accountId: id('主账号') });
  assert.equal(wrong.status, 400, 'a domain the selected key cannot manage is rejected');
  assert.match((await wrong.json()).error, /无法管理 b-one\.com/);
  assert.equal((await addDomain({ name: 'a-one.com', accountId: 'missing' })).status, 400);

  assert.equal((await addDomain({ name: 'a-one.com', accountId: id('主账号') })).status, 201);
  assert.equal((await addDomain({ name: 'a-two.com', accountId: id('主账号') })).status, 201);
  assert.equal((await addDomain({ name: 'b-one.com', accountId: id('合租') })).status, 201);
  assert.equal((await addDomain({ name: 'scoped.com', accountId: id('子账号') })).status, 201);

  calls.length = 0;
  for (const domain of ['a-one.com', 'b-one.com']) assert.equal((await syncAliDnsRecord(domain, 'jp', 'A', '203.0.113.9')).ok, true);
  assert.deepEqual([...new Set(calls.map((call) => `${call.domain}:${call.keyId}`))], ['a-one.com:ACCOUNTA0001', 'b-one.com:ACCOUNTB0001']);
  assert.equal((await syncAliDnsRecord('unlisted.com', 'jp', 'A', '203.0.113.9')).ok, false, 'a domain without an account is never synced');

  const moveWrong = await domainsRoute.PATCH(api(url, 'PATCH', { name: 'a-two.com', accountId: id('合租') }, adminCookie));
  assert.equal(moveWrong.status, 400, 'moving a domain to an account that cannot manage it is rejected');

  const blocked = await accountsRoute.DELETE(api(`https://panel.test/api/admin/aliyun-accounts?id=${id('合租')}`, 'DELETE', undefined, adminCookie));
  assert.equal(blocked.status, 409, 'an account in use cannot be deleted');
});

test('rotating an account key is checked against every domain bound to it', async () => {
  const main = (await listAccounts()).find((account) => account.name === '主账号');
  const mismatch = await accountsRoute.PATCH(api(url, 'PATCH', { id: main.id, accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' }, adminCookie));
  assert.equal(mismatch.status, 400, 'a key that cannot manage the bound domains is not saved');
  calls.length = 0;
  await syncAliDnsRecord('a-one.com', 'jp', 'A', '203.0.113.10');
  assert.equal(calls[0].keyId, 'ACCOUNTA0001', 'old key is kept after a rejected rotation');

  const rotated = await accountsRoute.PATCH(api(url, 'PATCH', { id: main.id, accessKeyId: 'ROTATEDA0001', accessKeySecret: 'rotated-secret-0001' }, adminCookie));
  assert.equal(rotated.status, 200);
  assert.deepEqual(await rotated.json(), { status: 'ok', accessKeyId: 'ROTA****0001', accessKeySecret: 'rota****0001' });
  calls.length = 0;
  await syncAliDnsRecord('a-two.com', 'jp', 'A', '203.0.113.11');
  assert.equal(calls[0].keyId, 'ROTATEDA0001');
});

test('normal users only see and use their own accounts and domains; the admin sees all', async () => {
  await setMultiUser(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie));
  await createUser('tenant');
  const tenant = await sessionFor('tenant');

  assert.deepEqual(await listAccounts(tenant), [], 'a new user sees no accounts of others');
  const adminAccount = (await listAccounts()).find((account) => account.name === '主账号');
  assert.equal((await addDomain({ name: 'a-three.com', accountId: adminAccount.id }, tenant)).status, 400, 'cannot bind a domain to another user\'s account');
  assert.equal((await accountsRoute.DELETE(api(`https://panel.test/api/admin/aliyun-accounts?id=${adminAccount.id}`, 'DELETE', undefined, tenant))).status, 404);
  assert.equal((await domainsRoute.DELETE(api('https://panel.test/api/admin/domains?name=a-two.com', 'DELETE', undefined, tenant))).status, 404);

  const own = await (await addAccount({ name: '主账号', accessKeyId: 'MEMBERKEY001', accessKeySecret: 'member-secret-001' }, tenant)).json();
  assert.ok(own.account, 'account names only need to be unique per user');
  assert.equal((await addDomain({ name: 'member.com', accountId: own.account.id }, tenant)).status, 201);
  assert.deepEqual((await (await domainsRoute.GET(api(url, 'GET', undefined, tenant))).json()).domains.map((domain) => domain.name), ['member.com']);
  assert.ok((await (await domainsRoute.GET(api(url, 'GET', undefined, adminCookie))).json()).domains.some((domain) => domain.name === 'member.com' && domain.ownerName === 'tenant'));
});
