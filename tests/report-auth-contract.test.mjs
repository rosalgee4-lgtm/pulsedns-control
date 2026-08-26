import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const route = await readFile(new URL('../app/api/v1/report/route.ts', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../public/monitor.sh', import.meta.url), 'utf8');
const installer = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');

test('report endpoint supports a read-only token preflight', () => {
  const getStart = route.indexOf('export async function GET');
  const postStart = route.indexOf('export async function POST');
  assert.ok(getStart >= 0 && postStart > getStart);
  const getHandler = route.slice(getStart, postStart);
  assert.match(getHandler, /x-secret-token/);
  assert.match(getHandler, /eq\(nodes\.tokenHash, await sha256\(token\)\)/);
  assert.match(getHandler, /status: 'ok'/);
  assert.match(getHandler, /status: 401/);
  assert.doesNotMatch(getHandler, /syncAliDnsRecord|db\.update|db\.insert/);
});

test('monitor writes first-report evidence only after the master accepts it', () => {
  assert.match(monitor, /notify_server "\$cur_v4" "A" && echo "\$cur_v4" > "\$CACHE_V4"/);
  assert.match(monitor, /notify_server "\$cur_v6" "AAAA" && echo "\$cur_v6" > "\$CACHE_V6"/);
  assert.match(monitor, /\.reportAccepted == true[\s\S]*REPORT_ACCEPTED_MARK[\s\S]*return 1/);
  assert.match(installer, /rm -f "\$CACHE_V4" "\$CACHE_V6" "\$REPORT_ACCEPTED_MARK"/);
  assert.match(installer, /-f "\$REPORT_ACCEPTED_MARK"/);
  assert.match(installer, /for attempt in \{1\.\.90\}/);
});

test('only an authenticated and valid report can return accepted-with-DNS-error evidence', () => {
  assert.equal(route.match(/reportAccepted: true/g)?.length, 1);
  const failureBranch = route.slice(route.indexOf('if (failures.length)'));
  assert.match(failureBranch, /reportAccepted: true/);
  const beforeFailure = route.slice(0, route.indexOf('if (failures.length)'));
  assert.doesNotMatch(beforeFailure, /reportAccepted/);
});
