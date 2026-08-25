import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { eventCategory, filterEvents } from '../lib/event-filter.ts';

const dashboard = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');
const nodeRoute = await readFile(new URL('../app/api/admin/nodes/route.ts', import.meta.url), 'utf8');
const nyanpassRoute = await readFile(new URL('../app/api/admin/nyanpass/route.ts', import.meta.url), 'utf8');

function handler(source, method, nextMethod) {
  const start = source.indexOf(`export async function ${method}`);
  const end = nextMethod ? source.indexOf(`export async function ${nextMethod}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${method} handler missing`);
  return source.slice(start, end);
}

test('node editing is authenticated, constrained, audited, and refreshes current DNS', () => {
  const patch = handler(nodeRoute, 'PATCH', 'DELETE');
  assert.match(patch, /if \(!user\).*status: 401/);
  assert.match(patch, /if \(!id\).*status: 400/);
  assert.match(patch, /if \(!current\).*status: 404/);
  assert.match(patch, /db\.update\(nodes\)\.set\(\{ name, region, domainName, recordV4, recordV6, syncEnabled, updatedAt: now \}\)/);
  assert.doesNotMatch(patch, /\.set\(\{[^}]*tokenHash/);
  assert.doesNotMatch(patch, /\.set\(\{[^}]*(?:ipv4|ipv6|lastSeenAt|createdAt)/);
  assert.match(patch, /syncAliDnsRecord\(domainName, target\.record, target\.type, target\.ip\)/);
  assert.match(patch, /kind: 'node_updated'/);
});

test('Nyanpass editing keeps the node fixed and derives role from a newly supplied official command', () => {
  const patch = handler(nyanpassRoute, 'PATCH', 'DELETE');
  assert.match(patch, /if \(!user\).*status: 401/);
  assert.match(patch, /if \(!id\).*status: 400/);
  assert.match(patch, /if \(!current\).*status: 404/);
  assert.match(patch, /parseOfficialNyanpassCommand\(body\?\.command\)/);
  assert.match(patch, /ne\(nyanpassInstances\.id, id\)/);
  assert.match(patch, /nodeId: current\.nodeId/);
  assert.match(patch, /kind: 'nyanpass_updated'/);
  assert.match(patch, /installCommand = hasCommand/);
  assert.doesNotMatch(patch, /\.set\(\{[^}]*nodeId/);
});

test('dashboard exposes persistent edit flows without asking for a new probe token', () => {
  assert.match(dashboard, /method: 'PATCH'/);
  assert.match(dashboard, /保存修改/);
  assert.match(dashboard, /onEdit\(node\)/);
  assert.match(dashboard, /onEdit\(instance\)/);
  assert.match(dashboard, /探针令牌、公网地址及安装状态不会改变/);
  assert.match(dashboard, /新的官方安装命令（可选）/);
  assert.match(dashboard, /setNyanpass\(\(current\) => current\.map/);
  assert.match(dashboard, /setEvents\(\(current\) => \[\.\.\.result\.events/);
});

const baseEvents = [
  { id: 1, nodeId: 'a', nodeName: '东京', level: 'info', kind: 'node_created', message: '创建节点' },
  { id: 2, nodeId: 'a', nodeName: '东京', level: 'error', kind: 'dns_failed', message: 'AAAA 同步失败' },
  { id: 3, nodeId: 'b', nodeName: '东京', level: 'info', kind: 'dns_synced', message: 'A 已同步' },
  { id: 4, nodeId: 'b', nodeName: '东京', level: 'info', kind: 'future_event', message: '未来事件' },
];

test('event filters combine node, category, level, and search without merging same-name nodes', () => {
  const result = filterEvents(baseEvents, { nodeId: 'a', category: 'dns', level: 'error', query: 'aaaa' });
  assert.deepEqual(result.map((event) => event.id), [2]);
  assert.deepEqual(filterEvents(baseEvents, { nodeId: 'b', category: 'all', level: 'all', query: '' }).map((event) => event.id), [3, 4]);
  assert.equal(eventCategory('future_event'), 'other');
  assert.deepEqual(filterEvents(baseEvents, { nodeId: 'all', category: 'other', level: 'all', query: '' }).map((event) => event.id), [4]);
});

test('recent changes filters before applying the display limit', () => {
  const events = [1, 2, 3, 4, 5].map((id) => ({ id, nodeId: 'a', nodeName: 'A', level: 'info', kind: 'ip_changed', message: `A ${id}` }));
  events.push({ id: 6, nodeId: 'b', nodeName: 'B', level: 'info', kind: 'ip_changed', message: 'B 6' });
  const result = filterEvents(events, { nodeId: 'b', category: 'all', level: 'all', query: '' }, 5);
  assert.deepEqual(result.map((event) => event.id), [6]);
});

test('activity UI exposes filters, distinct empty states, and an accessible fold control', () => {
  assert.match(dashboard, /全部节点/);
  assert.match(dashboard, /全部类型/);
  assert.match(dashboard, /全部级别/);
  assert.match(dashboard, /没有符合当前筛选条件的事件/);
  assert.match(dashboard, /aria-expanded=\{!collapsed\}/);
  assert.match(dashboard, /aria-controls=\{contentId\}/);
  assert.match(dashboard, /filterEvents\(events, filter, limit\)/);
});
