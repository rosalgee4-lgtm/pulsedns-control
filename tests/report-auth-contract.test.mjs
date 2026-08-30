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
  assert.match(monitor, /if notify_server "\$cur_v4" "A"; then[\s\S]*echo "\$cur_v4" > "\$CACHE_V4"/);
  assert.match(monitor, /if notify_server "\$cur_v6" "AAAA"; then[\s\S]*echo "\$cur_v6" > "\$CACHE_V6"/);
  assert.match(monitor, /\.reportAccepted == true[\s\S]*REPORT_ACCEPTED_MARK[\s\S]*return 0/);
  assert.match(installer, /rm -f "\$CACHE_V4" "\$CACHE_V6" "\$REPORT_ACCEPTED_MARK"/);
  assert.match(installer, /-f "\$REPORT_ACCEPTED_MARK"/);
  assert.match(installer, /for attempt in \{1\.\.90\}/);
});

test('unchanged addresses are periodically reconciled with bounded report retries', () => {
  assert.match(monitor, /DNS_RECONCILE_INTERVAL=600/);
  assert.match(monitor, /REPORT_RETRY_MAX=300/);
  assert.match(monitor, /last_reconcile_v4 == 0 \|\| now_epoch - last_reconcile_v4 >= DNS_RECONCILE_INTERVAL/);
  assert.match(monitor, /last_reconcile_v6 == 0 \|\| now_epoch - last_reconcile_v6 >= DNS_RECONCILE_INTERVAL/);
  assert.match(monitor, /retry_v4_delay=\$\(\(retry_v4_delay \* 2\)\)/);
  assert.match(monitor, /retry_v6_delay=\$\(\(retry_v6_delay \* 2\)\)/);
});

test('the master stores accepted IPs, silently verifies unchanged DNS, and coalesces failures', () => {
  assert.match(route, /if \(previous === report\.ip && !hasDnsMapping\) continue/);
  assert.match(route, /syncAliDnsRecord\(snapshot\.domainName, record, report\.type, report\.ip\)/);
  assert.match(route, /if \(previous !== report\.ip\) await updateReportedIp[\s\S]*failures\.push/);
  assert.match(route, /repairedExistingAddress = previous === report\.ip && !\('unchanged' in result\)/);
  assert.match(route, /dnsFailureDedupeMs = 60 \* 60 \* 1000/);
  assert.match(route, /pruneEventsAfterInsert/);
});

test('only an authenticated and valid report can return accepted-with-DNS-error evidence', () => {
  assert.equal(route.match(/reportAccepted: true/g)?.length, 1);
  const failureBranch = route.slice(route.indexOf('if (failures.length)'));
  assert.match(failureBranch, /reportAccepted: true/);
  const beforeFailure = route.slice(0, route.indexOf('if (failures.length)'));
  assert.doesNotMatch(beforeFailure, /reportAccepted/);
});
