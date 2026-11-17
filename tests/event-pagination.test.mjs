import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, setupTestApp } from './test-app.mjs';

const { database, adminCookie, createUser, sessionFor } = await setupTestApp('events');
const nodesRoute = await import('../app/api/admin/nodes/route.ts');
const nyanpassRoute = await import('../app/api/admin/nyanpass/route.ts');
const settingsRoute = await import('../app/api/admin/settings/route.ts');
const eventsRoute = await import('../app/api/admin/events/route.ts');

const url = 'https://panel.test/api/x';
const older = (cookie, before) => eventsRoute.GET(api(`https://panel.test/api/admin/events?before=${before}`, 'GET', undefined, cookie));
const ny = (flags) => `bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "${flags}"`;
const createNode = async (cookie, name) => (await (await nodesRoute.POST(api(url, 'POST', { name, rootPassword: 'test-password-123', nyanpass: [{ name: 'awsin', command: ny('-t aaaaaaaa-1111 -u https://ny.example.test') }] }, cookie))).json()).node.id;

async function addEvents(nodeId, count, label) {
  const start = Date.now() - count * 1000;
  for (let index = 0; index < count; index += 1) {
    await database.query('INSERT INTO events (node_id, level, kind, message, created_at) VALUES (?, ?, ?, ?, ?)', [nodeId, 'info', 'test', `${label} ${index}`, new Date(start + index * 1000)]);
  }
}

await settingsRoute.PATCH(api(url, 'PATCH', { multiUserEnabled: true }, adminCookie));
await createUser('member', 'member-password-123');
const member = await sessionFor('member');
const adminNode = await createNode(adminCookie, 'admin-node');
const memberNode = await createNode(member, 'member-node');
await database.query('DELETE FROM events');
await addEvents(adminNode, 230, 'admin');
await addEvents(memberNode, 30, 'member');

test('the dashboard loads the newest 100 events and older pages load until every retained event is shown', async () => {
  const first = (await (await nyanpassRoute.GET(api(url, 'GET', undefined, adminCookie))).json()).events;
  assert.equal(first.length, 100);
  assert.equal(first[0].message, 'member 29', 'newest first');

  const seen = [...first];
  let pages = 0;
  for (;;) {
    const response = await older(adminCookie, Math.min(...seen.map((event) => event.id)));
    assert.equal(response.status, 200);
    const page = await response.json();
    seen.push(...page.events);
    pages += 1;
    if (!page.hasMore) break;
    assert.equal(page.events.length, 100);
  }
  assert.equal(pages, 2);
  assert.equal(seen.length, 260, 'every event is reachable');
  assert.equal(new Set(seen.map((event) => event.id)).size, 260, 'no duplicates between pages');
  assert.deepEqual(seen.map((event) => event.id), [...seen.map((event) => event.id)].sort((a, b) => b - a), 'pages continue in order');
  assert.equal(seen.at(-1).message, 'admin 0');
});

test('normal users only page through events of their own nodes', async () => {
  const first = (await (await nyanpassRoute.GET(api(url, 'GET', undefined, member))).json()).events;
  assert.equal(first.length, 30);
  const page = await (await older(member, Math.min(...first.map((event) => event.id)))).json();
  assert.deepEqual(page, { events: [], hasMore: false });
  const [newest] = await database.query('SELECT MAX(id) AS id FROM events');
  const all = await (await older(member, Number(newest.id) + 1)).json();
  assert.ok(all.events.every((event) => event.nodeId === memberNode));
});

test('the older-events endpoint requires a session and a valid cursor', async () => {
  assert.equal((await older(null, 10)).status, 401);
  for (const before of ['', '0', '-1', 'abc', '1.5']) assert.equal((await older(adminCookie, before)).status, 400);
});
