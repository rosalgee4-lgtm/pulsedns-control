import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, api, setupTestApp } from './test-app.mjs';

process.env.PULSEDNS_TRUST_PROXY = '1';
const { database, adminCookie, createUser, sessionFor } = await setupTestApp('auth');
const { POST: login } = await import('../app/api/auth/login/route.ts');
const { POST: logout } = await import('../app/api/auth/logout/route.ts');
const { POST: changePassword } = await import('../app/api/account/password/route.ts');
const settingsRoute = await import('../app/api/admin/settings/route.ts');
const usersRoute = await import('../app/api/admin/users/route.ts');
const nodesRoute = await import('../app/api/admin/nodes/route.ts');
const nyanpassRoute = await import('../app/api/admin/nyanpass/route.ts');

const url = 'https://panel.test/api/x';
const attempt = (username, password, ip = '198.51.100.1', extra = {}) => login(api(url, 'POST', { username, password }, null, { 'X-Real-IP': ip, 'X-Forwarded-Proto': 'https', ...extra }));
const setMultiUser = (enabled) => settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: enabled }, adminCookie));
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const createNode = (cookie, name) => nodesRoute.POST(api(url, 'POST', { name, rootPassword: 'test-password-123', nyanpass: [{ name: 'awsin', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }] }, cookie));

test('the initial admin is created from the environment with only a password hash stored', async () => {
  const rows = await database.query('SELECT username, role, password_hash AS hash FROM users');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, ADMIN.username);
  assert.equal(rows[0].role, 'admin');
  assert.match(rows[0].hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!rows[0].hash.includes(ADMIN.password));
});

test('login sets a strict HttpOnly session cookie and requires HTTPS', async () => {
  const response = await attempt(ADMIN.username, ADMIN.password);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^pulsedns_session=ps_[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const [session] = await database.query('SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1');
  assert.ok(!cookie.includes(session.token_hash), 'only a hash of the session token is stored');

  delete process.env.PULSEDNS_ALLOW_HTTP;
  try {
    const plain = await login(api('http://panel.test/api/auth/login', 'POST', { username: ADMIN.username, password: ADMIN.password }, null, { 'X-Real-IP': '198.51.100.9' }));
    assert.equal(plain.status, 400, 'plain HTTP login is refused');
    assert.match((await plain.json()).error, /HTTPS/);
  } finally {
    process.env.PULSEDNS_ALLOW_HTTP = '1';
  }

  const loggedIn = cookie.split(';')[0];
  assert.equal((await logout(api(url, 'POST', undefined, loggedIn))).status, 200);
  assert.equal((await settingsRoute.GET(api(url, 'GET', undefined, loggedIn))).status, 401, 'logout revokes the session');
});

test('brute force: 5 failures for the same IP and user lock it for 15 minutes, other IPs are unaffected', async () => {
  for (let index = 0; index < 5; index += 1) assert.equal((await attempt(ADMIN.username, 'wrong-password-1', '203.0.113.5')).status, 401);
  const locked = await attempt(ADMIN.username, ADMIN.password, '203.0.113.5');
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.match((await locked.json()).error, /15 分钟后再试/);
  assert.equal(locked.headers.get('retry-after'), '900');
  assert.equal((await attempt(ADMIN.username, ADMIN.password, '203.0.113.6')).status, 200, 'another IP can still log in');

  await database.query("UPDATE login_attempts SET locked_until = ? WHERE scope LIKE 'pair:203.0.113.5|%'", [new Date(Date.now() - 1000)]);
  assert.equal((await attempt(ADMIN.username, ADMIN.password, '203.0.113.5')).status, 200, 'the lock expires');
});

test('brute force: 20 failures from one IP lock that IP for every username', async () => {
  for (let index = 0; index < 20; index += 1) assert.equal((await attempt(`nobody${index}`, 'wrong-password-1', '203.0.113.7')).status, 401);
  assert.equal((await attempt(ADMIN.username, ADMIN.password, '203.0.113.7')).status, 429);
  assert.equal((await attempt(ADMIN.username, ADMIN.password, '203.0.113.8')).status, 200);
});

test('cross-site requests are rejected for every state-changing API, including login', async () => {
  const crossSite = { 'Sec-Fetch-Site': 'cross-site' };
  assert.equal((await attempt(ADMIN.username, ADMIN.password, '198.51.100.2', crossSite)).status, 403);
  assert.equal((await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie, crossSite))).status, 403);
  assert.equal((await nodesRoute.DELETE(api(`${url}?id=x`, 'DELETE', undefined, adminCookie, crossSite))).status, 403);
  // 没有 Sec-Fetch-Site 的旧浏览器：Origin 必须与 Host 一致。
  const legacy = (origin) => new Request(url, { method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json', Host: 'panel.test', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ multiUserEnabled: false }) });
  assert.equal((await settingsRoute.PATCH(legacy('https://evil.example'))).status, 403);
  assert.equal((await settingsRoute.PATCH(legacy(null))).status, 403);
  assert.equal((await settingsRoute.PATCH(legacy('https://panel.test'))).status, 200);
});

test('multi-user switch: off allows only the admin; turning it off logs normal users out', async () => {
  await createUser('member', 'member-password-123');
  assert.equal((await setMultiUser(false)).status, 200);
  const refused = await attempt('member', 'member-password-123', '198.51.100.3');
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /只允许管理员登录/);

  assert.equal((await setMultiUser(true)).status, 200);
  const allowed = await attempt('member', 'member-password-123', '198.51.100.3');
  assert.equal(allowed.status, 200);
  const memberCookie = allowed.headers.get('set-cookie').split(';')[0];
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, memberCookie))).status, 200);

  assert.equal((await setMultiUser(false)).status, 200);
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, memberCookie))).status, 401, 'existing member sessions stop working');
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, adminCookie))).status, 200, 'the admin keeps working');
});

test('only the admin can change settings and manage users', async () => {
  await setMultiUser(true);
  const member = await sessionFor('member');
  assert.equal((await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: false }, member))).status, 403);
  assert.equal((await usersRoute.GET(api(url, 'GET', undefined, member))).status, 403);
  assert.equal((await usersRoute.POST(api(url, 'POST', { username: 'sneaky', password: 'sneaky-password-1' }, member))).status, 403);

  assert.equal((await usersRoute.POST(api(url, 'POST', { username: 'member', password: 'member-password-123' }, adminCookie))).status, 409);
  assert.equal((await usersRoute.POST(api(url, 'POST', { username: 'shortpw', password: 'short' }, adminCookie))).status, 400);
  const admins = (await (await usersRoute.GET(api(url, 'GET', undefined, adminCookie))).json()).users.filter((user) => user.role === 'admin');
  assert.equal((await usersRoute.DELETE(api(`${url}?id=${admins[0].id}`, 'DELETE', undefined, adminCookie))).status, 404, 'the admin account cannot be deleted');
});

test('normal users only see and change their own nodes', async () => {
  const member = await sessionFor('member');
  const adminNode = await (await createNode(adminCookie, 'admin-node')).json();
  const memberNode = await (await createNode(member, 'member-node')).json();

  const memberView = await (await nyanpassRoute.GET(api(url, 'GET', undefined, member))).json();
  assert.deepEqual(memberView.nodes.map((node) => node.name), ['member-node']);
  assert.ok(memberView.instances.every((instance) => instance.nodeId === memberNode.node.id));
  assert.ok(memberView.events.every((event) => event.nodeId === memberNode.node.id));

  const adminView = await (await nyanpassRoute.GET(api(url, 'GET', undefined, adminCookie))).json();
  assert.ok(['admin-node', 'member-node'].every((name) => adminView.nodes.some((node) => node.name === name)), 'the admin sees all nodes');

  const patch = { id: adminNode.node.id, name: 'taken-over', domainName: '', recordV4: '', syncEnabled: true };
  assert.equal((await nodesRoute.PATCH(api(url, 'PATCH', patch, member))).status, 404);
  assert.equal((await nodesRoute.DELETE(api(`${url}?id=${adminNode.node.id}&confirmProvisioning=checked`, 'DELETE', undefined, member))).status, 404);
  assert.equal((await nodesRoute.POST(api(url, 'POST', { action: 'installation', id: adminNode.node.id }, member))).status, 404, 'cannot read another user\'s install commands');
  assert.equal((await nyanpassRoute.POST(api(url, 'POST', { nodeId: adminNode.node.id, name: 'x', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }, member))).status, 404);

  const users = (await (await usersRoute.GET(api(url, 'GET', undefined, adminCookie))).json()).users;
  const memberRow = users.find((user) => user.username === 'member');
  assert.equal(memberRow.nodeCount, 1);
  assert.equal((await usersRoute.DELETE(api(`${url}?id=${memberRow.id}`, 'DELETE', undefined, adminCookie))).status, 409, 'a user who still owns nodes cannot be deleted');
});

test('changing a password needs the current one and signs out other sessions; admin resets revoke sessions', async () => {
  const first = await sessionFor('member');
  const second = await sessionFor('member');
  assert.equal((await changePassword(api(url, 'POST', { currentPassword: 'wrong', newPassword: 'member-password-456' }, first))).status, 400);
  assert.equal((await changePassword(api(url, 'POST', { currentPassword: 'member-password-123', newPassword: 'member-password-456' }, first))).status, 200);
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, first))).status, 200, 'the current session stays');
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, second))).status, 401, 'other sessions are revoked');
  assert.equal((await attempt('member', 'member-password-456', '198.51.100.4')).status, 200);

  const users = (await (await usersRoute.GET(api(url, 'GET', undefined, adminCookie))).json()).users;
  const memberId = users.find((user) => user.username === 'member').id;
  assert.equal((await usersRoute.PATCH(api(url, 'PATCH', { id: memberId, password: 'reset-password-789' }, adminCookie))).status, 200);
  assert.equal((await nyanpassRoute.GET(api(url, 'GET', undefined, first))).status, 401, 'an admin reset signs the user out');
  assert.equal((await attempt('member', 'reset-password-789', '198.51.100.4')).status, 200);
});
