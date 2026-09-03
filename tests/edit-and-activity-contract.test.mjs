import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { eventCategory, filterEvents } from '../lib/event-filter.ts';

const dashboard = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const nodeRoute = await readFile(new URL('../app/api/admin/nodes/route.ts', import.meta.url), 'utf8');
const nyanpassRoute = await readFile(new URL('../app/api/admin/nyanpass/route.ts', import.meta.url), 'utf8');
const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const nodeResponse = await readFile(new URL('../lib/node-response.ts', import.meta.url), 'utf8');

function handler(source, method, nextMethod) {
  const start = source.indexOf(`export async function ${method}`);
  const end = nextMethod ? source.indexOf(`export async function ${nextMethod}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${method} handler missing`);
  return source.slice(start, end);
}

function dashboardFunction(name) {
  const start = dashboard.indexOf(`  async function ${name}`);
  assert.ok(start >= 0, `${name} function missing`);
  const tail = dashboard.slice(start);
  const closing = tail.search(/^  }\r?$/m);
  assert.ok(closing > 0, `${name} function closing brace missing`);
  return tail.slice(0, closing + 3);
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
  assert.match(patch, /acquireNodeOperationLock\(db, id\)/);
  assert.match(patch, /finally \{[\s\S]*releaseNodeOperationLock\(db, id, operationId\)/);
  assert.match(nodeRoute, /operationId === undefined[\s\S]*status: 404/);
});

test('Nyanpass editing keeps the node fixed and encrypts a newly supplied official command for explicit sync', () => {
  const patch = handler(nyanpassRoute, 'PATCH', 'DELETE');
  assert.match(patch, /if \(!user\).*status: 401/);
  assert.match(patch, /if \(!id\).*status: 400/);
  assert.match(patch, /if \(!current\).*status: 404/);
  assert.match(patch, /parseOfficialNyanpassCommand\(body\?\.command\)/);
  assert.match(patch, /name !== current\.name/);
  assert.match(patch, /name: current\.name/);
  assert.match(patch, /nodeId: current\.nodeId/);
  assert.match(patch, /kind: 'nyanpass_updated'/);
  assert.match(patch, /encryptNyanpassCredential\(parsed\.clientToken/);
  assert.match(patch, /status = 'ready'/);
  assert.doesNotMatch(patch, /installCommand/);
  assert.doesNotMatch(patch, /\.set\(\{[^}]*nodeId/);
});

test('dashboard exposes persistent edit flows without asking for a new probe token', () => {
  assert.match(dashboard, /method: 'PATCH'/);
  assert.match(dashboard, /保存修改/);
  assert.match(dashboard, /onEdit\(node\)/);
  assert.match(dashboard, /onEdit\(instance\)/);
  assert.match(dashboard, /探针令牌、公网地址及安装状态不会改变/);
  assert.match(dashboard, /新的官方安装命令/);
  assert.match(dashboard, /同步到机器/);
  assert.match(dashboard, /setNyanpass\(\(current\) => current\.map/);
  assert.match(dashboard, /setEvents\(\(current\) => \[\.\.\.result\.events/);
  assert.match(dashboard, /取消尚未领取的排队|取消排队/);
  assert.match(dashboard, /setCreatedNyanpass\(\(current\)/);
  assert.match(dashboard, /finally \{/);
});

test('every successful dashboard mutation invalidates older polling responses', () => {
  assert.match(dashboard, /const sequence = \+\+refreshSequence\.current/);
  assert.match(dashboard, /sequence !== refreshSequence\.current/);

  const mutations = new Map([
    ['createNode', 'setCreated(result)'],
    ['createNyanpassInstance', 'setCreatedNyanpass(result)'],
    ['removeNyanpassInstance', 'setNyanpass((current) => current.filter'],
    ['syncNyanpassInstance', 'setNyanpass((current) => current.map'],
    ['cancelNyanpassSync', 'setNyanpass((current) => current.map'],
    ['removeNode', 'setNodes((current) => current.filter'],
    ['updateNode', 'setNodes((current) => current.map'],
    ['updateNyanpassInstance', 'setNyanpass((current) => current.map'],
  ]);
  for (const [mutation, applyResult] of mutations) {
    const body = dashboardFunction(mutation);
    const invalidate = body.indexOf('refreshSequence.current += 1');
    const apply = body.indexOf(applyResult);
    assert.ok(invalidate >= 0, `${mutation} must invalidate an older GET`);
    assert.ok(apply > invalidate, `${mutation} must invalidate the GET before applying its result`);
  }
});

test('node creation returns the optimize flag for every bootstrapped instance', () => {
  const post = handler(nodeRoute, 'POST', 'PATCH');
  const response = post.slice(post.indexOf('return Response.json'));

  assert.match(response, /instances: preparedInstances\.map\(\(instance\) => \(\{[\s\S]*optimize: instance\.optimize/);
  assert.match(post, /\[\\x00-\\x1f\\x7f\]/);
  assert.match(post, /TextEncoder\(\)\.encode\(bootstrapConfig\)\.byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES/);
  assert.match(post, /TextEncoder\(\)\.encode\(startupScript\)\.byteLength > MAX_CLOUD_LAUNCHER_BYTES/);
  assert.ok(post.indexOf('byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES') < post.indexOf('db.insert(nodes)'));
  assert.ok(post.indexOf('byteLength > MAX_CLOUD_LAUNCHER_BYTES') < post.indexOf('db.insert(nodes)'));
});

test('states without reusable credentials require a new official command before syncing', () => {
  assert.match(dashboard, /function requiresFreshNyanpassCommand\(instance: Pick<NyanpassRow, 'status' \| 'hasCredential'>\)/);
  assert.match(dashboard, /!\['ready', 'pending', 'running', 'failed'\]\.includes\(instance\.status\)/);
  assert.match(dashboard, /!instance\.hasCredential/);
  assert.match(dashboard, /editingNyanpass && requiresFreshNyanpassCommand\(editingNyanpass\)/);
  assert.match(nyanpassRoute, /!current\.credentialCiphertext && !hasCommand/);
  assert.match(nyanpassRoute, /hasCredential: instance\.hasCredential \?\? Boolean\(credentialCiphertext\)/);
  assert.match(dashboard, /<textarea name="command" required=\{editingNyanpassRequiresCommand\}/);
  assert.match(nyanpassRoute, /current\.status === 'uncertain' && !confirmUncertain/);
  assert.match(dashboard, /confirmUncertain: editingNyanpass\.status === 'uncertain' \? 'checked'/);
});

test('Nyanpass machine service names are immutable so an old VPS service is never orphaned', () => {
  assert.match(nyanpassRoute, /name !== current\.name[\s\S]*机器服务名创建后不可修改/);
  assert.match(dashboard, /<input name="name" value=\{editingNyanpass\.name\} disabled/);
  assert.match(dashboard, /确认新服务正常后再移除旧登记/);
});

test('browser node DTO excludes credential hashes and internal operation identities', () => {
  assert.match(page, /nodeRows\.map\(nodeResponse\)/);
  assert.match(nyanpassRoute, /nodes: nodeRows\.map\(nodeResponse\)/);
  assert.doesNotMatch(nodeResponse, /\.\.\.node|tokenHash|provisionAttemptId|dnsOperationId/);
  assert.doesNotMatch(dashboard, /tokenHash/);
});

test('live refresh updates full node report state and edit does not silently ignore OPTIMIZE', () => {
  assert.match(nyanpassRoute, /const nodeRows = await db\.select\(\)\.from\(nodes\)/);
  assert.match(nodeResponse, /lastSeenAt: node\.lastSeenAt\?\.toISOString\(\) \?\? null/);
  assert.match(nodeResponse, /provisionLastCompletedStep: node\.provisionLastCompletedStep/);
  assert.match(dashboard, /setNodes\(refreshedNodes\)/);
  assert.match(nyanpassRoute, /optimize !== current\.optimize && !hasCommand/);
  assert.match(dashboard, /只修改 OPTIMIZE 开关时也必须重新粘贴官方命令/);
  assert.match(dashboard, /states\[instance\.status\] \?\? \{ label: '未知状态'/);
  assert.match(dashboard, /provisioning \? \(node \? bootstrapStatusLabel\(node\.nyanpassStatus\)/);
  assert.match(dashboard, /fetchWithTimeout/);
  assert.match(dashboard, /authoritativeStateChanged/);
  assert.match(dashboard, /previous\.activeTaskId !== instance\.activeTaskId/);
  assert.doesNotMatch(styles, /\.sync-state,\.ghost-button\{display:none\}/);
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
  assert.equal(eventCategory('nyanpass_sync_succeeded'), 'nyanpass');
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
