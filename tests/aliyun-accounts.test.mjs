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

const root = await mkdtemp(join(tmpdir(), 'pulsedns-aliyun-'));
process.env.PULSEDNS_SELF_HOSTED = '1';
process.env.PULSEDNS_DB_PATH = join(root, 'test.db');
process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.PULSEDNS_TEST_ADMIN = '1';
process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'DEFAULTKEY01';
process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'default-secret-01';

// 模拟阿里云：每个 AccessKey 只能管理自己账号下的域名。
const owned = {
  DEFAULTKEY01: ['default.com'],
  ACCOUNTA0001: ['a-one.com', 'a-two.com'],
  ACCOUNTB0001: ['b-one.com'],
  ROTATEDA0001: ['a-one.com', 'a-two.com'],
  SCOPEDKEY001: ['scoped.com'],
};
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.host !== 'alidns.aliyuncs.com') return realFetch(input, init);
  const keyId = /Credential=([^,]+),/.exec(init.headers.Authorization)[1];
  const action = init.headers['x-acs-action'];
  const domain = url.searchParams.get('DomainName');
  calls.push({ keyId, action, domain });
  const fail = (Code, status = 400) => Response.json({ Code, Message: Code }, { status });
  if (!owned[keyId]) return fail('InvalidAccessKeyId.NotFound', 404);
  if (action === 'DescribeDomains') return keyId === 'SCOPEDKEY001' ? fail('Forbidden.RAM', 403) : Response.json({ Domains: { Domain: [] } });
  if (!owned[keyId].includes(domain)) return fail('InvalidDomainName.NoExist');
  if (action === 'DescribeDomainRecords') return Response.json({ DomainRecords: { Record: [] } });
  return Response.json({ RecordId: '1' });
};

const accountsRoute = await import('../app/api/admin/aliyun-accounts/route.ts');
const domainsRoute = await import('../app/api/admin/domains/route.ts');
const { syncAliDnsRecord } = await import('../lib/alidns.ts');
const { getLocalSqlite } = await import('../db/index.ts');
after(async () => { (await getLocalSqlite()).close(); await rm(root, { recursive: true, force: true }); });

const json = (method, body) => new Request('https://m/api/admin/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const addAccount = (body) => accountsRoute.POST(json('POST', body));
const addDomain = (body) => domainsRoute.POST(json('POST', body));

test('aliyun accounts require admin, are verified, and never expose the secret', async () => {
  process.env.PULSEDNS_TEST_ADMIN = '0';
  assert.equal((await accountsRoute.GET()).status, 401);
  assert.equal((await addAccount({ name: 'x', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' })).status, 401);
  process.env.PULSEDNS_TEST_ADMIN = '1';

  assert.equal((await addAccount({ name: '', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' })).status, 400);
  assert.equal((await addAccount({ name: 'bad', accessKeyId: 'short', accessKeySecret: 'secret-a-0001' })).status, 400);
  const invalid = await addAccount({ name: 'bad', accessKeyId: 'UNKNOWNKEY01', accessKeySecret: 'secret-x-0001' });
  assert.equal(invalid.status, 400, 'a key Aliyun rejects is not saved');
  assert.match((await invalid.json()).error, /InvalidAccessKeyId/);

  const created = await addAccount({ name: '主账号', accessKeyId: 'ACCOUNTA0001', accessKeySecret: 'secret-a-0001' });
  assert.equal(created.status, 201);
  assert.equal((await addAccount({ name: '主账号', accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' })).status, 409);
  assert.equal((await addAccount({ name: '合租', accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' })).status, 201);
  // RAM 子账号只授权了部分域名时，列出域名会被拒，但 Key 本身有效。
  assert.equal((await addAccount({ name: '子账号', accessKeyId: 'SCOPEDKEY001', accessKeySecret: 'secret-s-0001' })).status, 201);

  const listed = await (await accountsRoute.GET()).json();
  const text = JSON.stringify(listed);
  assert.ok(!text.includes('secret-'), 'secrets are never returned');
  assert.ok(!text.includes('ACCOUNTA0001') && !text.includes('DEFAULTKEY01'), 'key IDs are masked');
  assert.deepEqual(listed.defaultAccount, { configured: true, accessKeyId: 'DEFA****EY01' });
  assert.deepEqual(listed.accounts.map((account) => account.name).sort(), ['主账号', '合租', '子账号'].sort());

  const stored = (await getLocalSqlite()).prepare('SELECT secret_ciphertext AS c FROM aliyun_accounts').all();
  assert.ok(stored.every((row) => row.c.startsWith('v1.') && !row.c.includes('secret')), 'secrets are stored encrypted');
});

test('each main domain uses its own account key, checked on save and used for DNS sync', async () => {
  const { accounts } = await (await accountsRoute.GET()).json();
  const id = (name) => accounts.find((account) => account.name === name).id;

  const wrong = await addDomain({ name: 'b-one.com', accountId: id('主账号') });
  assert.equal(wrong.status, 400, 'a domain the selected key cannot manage is rejected');
  assert.match((await wrong.json()).error, /无法管理 b-one\.com/);
  assert.equal((await addDomain({ name: 'a-one.com', accountId: 'missing' })).status, 400);

  assert.equal((await addDomain({ name: 'a-one.com', accountId: id('主账号') })).status, 201);
  assert.equal((await addDomain({ name: 'a-two.com', accountId: id('主账号') })).status, 201);
  assert.equal((await addDomain({ name: 'b-one.com', accountId: id('合租') })).status, 201);
  assert.equal((await addDomain({ name: 'scoped.com', accountId: id('子账号') })).status, 201);
  assert.equal((await addDomain({ name: 'default.com', accountId: '' })).status, 201, 'empty account means the install-time default key');

  calls.length = 0;
  for (const domain of ['a-one.com', 'b-one.com', 'default.com']) assert.equal((await syncAliDnsRecord(domain, 'jp', 'A', '203.0.113.9')).ok, true);
  assert.deepEqual([...new Set(calls.map((call) => `${call.domain}:${call.keyId}`))], ['a-one.com:ACCOUNTA0001', 'b-one.com:ACCOUNTB0001', 'default.com:DEFAULTKEY01']);

  const moveWrong = await domainsRoute.PATCH(json('PATCH', { name: 'a-two.com', accountId: id('合租') }));
  assert.equal(moveWrong.status, 400, 'moving a domain to an account that cannot manage it is rejected');
  const domains = await (await domainsRoute.GET()).json();
  assert.equal(domains.domains.find((domain) => domain.name === 'a-two.com').accountId, id('主账号'));

  const blocked = await accountsRoute.DELETE(new Request(`https://m/api/admin/aliyun-accounts?id=${id('合租')}`, { method: 'DELETE' }));
  assert.equal(blocked.status, 409, 'an account in use cannot be deleted');
});

test('rotating an account key is checked against every domain bound to it', async () => {
  const { accounts } = await (await accountsRoute.GET()).json();
  const main = accounts.find((account) => account.name === '主账号');

  const mismatch = await accountsRoute.PATCH(json('PATCH', { id: main.id, accessKeyId: 'ACCOUNTB0001', accessKeySecret: 'secret-b-0001' }));
  assert.equal(mismatch.status, 400, 'a key that cannot manage the bound domains is not saved');
  calls.length = 0;
  await syncAliDnsRecord('a-one.com', 'jp', 'A', '203.0.113.10');
  assert.equal(calls[0].keyId, 'ACCOUNTA0001', 'old key is kept after a rejected rotation');

  const rotated = await accountsRoute.PATCH(json('PATCH', { id: main.id, accessKeyId: 'ROTATEDA0001', accessKeySecret: 'secret-r-0001' }));
  assert.equal(rotated.status, 200);
  calls.length = 0;
  await syncAliDnsRecord('a-two.com', 'jp', 'A', '203.0.113.11');
  assert.equal(calls[0].keyId, 'ROTATEDA0001');
});

test('a domain cannot use the default account when no key was set at install', async () => {
  delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  try {
    const listed = await (await accountsRoute.GET()).json();
    assert.deepEqual(listed.defaultAccount, { configured: false, accessKeyId: null });
    const response = await addDomain({ name: 'default-two.com', accountId: '' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /没有配置默认 AccessKey/);
  } finally {
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'DEFAULTKEY01';
  }
});
