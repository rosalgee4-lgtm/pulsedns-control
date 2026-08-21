import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboard = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../app/api/admin/nodes/route.ts', import.meta.url), 'utf8');

test('node table exposes a confirmed DELETE action', () => {
  assert.match(dashboard, /window\.confirm\(`/);
  assert.match(dashboard, /api\/admin\/nodes\?id=/);
  assert.match(dashboard, /method: 'DELETE'/);
  assert.match(dashboard, /删除节点/);
  assert.match(dashboard, /不会卸载 VPS 上的 DDNS 或 Nyanpass 服务/);
});

test('successful deletion removes related client state', () => {
  assert.match(dashboard, /setNodes\(\(current\) => current\.filter\(\(item\) => item\.id !== node\.id\)\)/);
  assert.match(dashboard, /setNyanpass\(\(current\) => current\.filter\(\(instance\) => instance\.nodeId !== node\.id\)\)/);
  assert.match(dashboard, /setEvents\(\(current\) => current\.filter\(\(event\) => event\.nodeId !== node\.id\)\)/);
});

test('server deletion remains authenticated and keyed by node id', () => {
  assert.match(route, /export async function DELETE/);
  assert.match(route, /if \(!user\).*status: 401/);
  assert.match(route, /searchParams\.get\('id'\)/);
  assert.match(route, /db\.delete\(nodes\)\.where\(eq\(nodes\.id, id\)\)/);
});
