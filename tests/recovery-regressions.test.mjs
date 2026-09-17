import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseNyanpassArgs, validNyanpassServiceName, validNyanpassToken } from '../lib/nyanpass-command.ts';

const installer = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../public/monitor.sh', import.meta.url), 'utf8');
const updater = await readFile(new URL('../public/update.sh', import.meta.url), 'utf8');
const definitions = installer.slice(0, installer.indexOf('\nACTION='));
const nodeId = '11111111-2222-4333-8444-555555555555';
const attemptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const bootstrapUrl = `https://master.example.test/api/v1/bootstrap/${nodeId}/pbs_${'a'.repeat(64)}`;
const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
function fn(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(match, name);
  return match[0];
}
function bash(source, env = {}) {
  return spawnSync('bash', ['-c', source], {encoding: 'utf8', timeout: 10000,
    env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
}
function succeeded(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pulsedns-recovery-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
function isolatedInstaller(root) {
  return definitions.replaceAll('/root/', `${root}/`).replaceAll('/var/lib/pulsedns-bootstrap-', `${root}/state-`) + `
trap - EXIT
BOOTSTRAP_LOCK_FILE=${shell(join(root, 'bootstrap.lock'))}
PROVISION_OUTCOME_DIR=${shell(join(root, 'outcomes'))}
CONFIG_FILE=${shell(join(root, 'ddns.conf'))}
INSTALL_PATH=${shell(join(root, 'monitor.sh'))}
SERVICE_FILE=${shell(join(root, 'ddns.service'))}
need_root() { :; }
ensure_probe_bootstrap_environment() { :; }
flock() { :; }
stat() {
  case "$2" in
    '%a:%u:%h') printf '600:0:1\\n' ;;
    *) case "$3" in *installer*) printf '700:0\\n' ;; *) printf '600:0\\n' ;; esac ;;
  esac
}
sha256sum() {
  if [[ -x /usr/bin/sha256sum ]]; then /usr/bin/sha256sum "$@";
  else shasum -a 256 "$@"; fi
}
`;
}

test('service name validation agrees between API, installer, and monitor', () => {
  for (const name of ['tenant-in', 'tenant.out_2', 'n', 'n'.repeat(48), 'ddns-monitor', 'ssh', 'sshd',
    'pulsedns-control', 'systemd-networkd', 'tenant.service', 'tenant.target', '../tenant', '-tenant', 'n'.repeat(49)]) {
    const expected = validNyanpassServiceName(name) ? 0 : 1;
    for (const source of [installer, monitor]) {
      assert.equal(bash(`${fn(source, 'valid_nyanpass_service_name')}\nvalid_nyanpass_service_name "$NAME"`, {NAME: name}).status, expected, name);
    }
  }
});

test('probe token grammar matches command parsing, including punctuation and length limits', () => {
  const code = fn(monitor, 'valid_nyanpass_service_name') + fn(monitor, 'validate_nyanpass_payload');
  for (const token of ['abcdefgh', 'abc.~:+/=-XYZ', 't'.repeat(512), 'short', 't'.repeat(513), 'abc$(id)xyz', 'abc;defgh', 'abc\ndefgh']) {
    const expected = validNyanpassToken(token);
    assert.equal(parseNyanpassArgs(`-t ${token} -u https://ny.example.test`).ok, expected, token);
    assert.equal(bash(`${code}\nvalidate_nyanpass_payload tenant inbound https://ny.example.test "$TOKEN" 0`, {TOKEN: token}).status, expected ? 0 : 1, token);
  }
});

test('Nyanpass target guard permits repair but rejects foreign units, directories, and links before writing', async () => {
  assert.ok(fn(monitor, 'poll_nyanpass_job').indexOf('! validate_nyanpass_target') < fn(monitor, 'poll_nyanpass_job').indexOf('installer=$(mktemp'));
  assert.ok(fn(installer, 'provision_node').indexOf('validate_nyanpass_target') < fn(installer, 'provision_node').indexOf('install_ddns_service'));
  for (const source of [installer, monitor]) await fixture(async (root) => {
    const target = join(root, 'opt', 'tenant');
    const code = ['valid_nyanpass_service_name', 'validate_nyanpass_target', 'stage_nyanpass_binary']
      .map((name) => fn(source, name)).join('\n').replaceAll('/opt/', `${root}/opt/`);
    const run = (state, unit = '') => bash(`set -eu\n${code}\nsystemctl() {
      if [[ "$1" == show ]]; then printf '%s\\n' "$STATE"; else printf '%s\\n' "$UNIT"; fi
    }\nstage_nyanpass_binary tenant ${shell(join(root, 'binary'))}`, {STATE: state, UNIT: unit});
    await writeFile(join(root, 'binary'), 'new binary');
    assert.notEqual(run('loaded', 'Description=some other service').status, 0);
    await assert.rejects(readFile(join(target, 'rel_nodeclient')), {code: 'ENOENT'});
    succeeded(run('not-found'));
    assert.equal(await readFile(join(target, 'rel_nodeclient'), 'utf8'), 'new binary');
    succeeded(run('loaded', `Description=nyanpass\nWorkingDirectory=${target}\nExecStart=/bin/bash ${target}/start.sh`));
    assert.notEqual(run('masked').status, 0);
    await rm(target, {recursive: true});
    await mkdir(target);
    await writeFile(join(target, 'foreign'), 'leave unchanged');
    assert.notEqual(run('not-found').status, 0);
    assert.equal(await readFile(join(target, 'foreign'), 'utf8'), 'leave unchanged');
    await rm(target, {recursive: true});
    await symlink(root, target);
    assert.notEqual(run('not-found').status, 0);
  });
});

function config(script, revision = 'a') {
  return ['PULSEDNS_BOOTSTRAP_V1', nodeId, '1', 'https://master.example.test', `pd_${'b'.repeat(64)}`,
    'fixture-password', `https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/${revision.repeat(40)}/public/install.sh`, digest(script),
    'https://dl.nyafw.com/download/nyanpass-install.sh', revision.repeat(64), 'https://dl.nyafw.com/download/fixture', attemptId,
    revision.repeat(64), revision.repeat(64), revision.repeat(64), '1', 'tenant', '0', '-t abcdefgh -u https://ny.example.test'];
}
for (const scenario of ['refresh', 'expired', 'invalid', 'wrong-generation', 'wrong-server', 'wrong-token']) {
  test(`cached bootstrap refresh: ${scenario}`, () => fixture(async (root) => {
    const oldScript = '#!/bin/bash\n# PulseDNS / 原 DDNS 脚本兼容安装器\n# old\n';
    const newScript = oldScript.replace('# old', '# new');
    const oldConfig = config(oldScript);
    const fresh = config(newScript, 'c');
    if (scenario === 'wrong-generation') fresh[2] = '2';
    if (scenario === 'wrong-server') fresh[3] = 'https://other.example.test';
    if (scenario === 'wrong-token') fresh[4] = `pd_${'c'.repeat(64)}`;
    const cached = join(root, `pulsedns_${nodeId}_bootstrap.config`);
    const cachedInstaller = join(root, `pulsedns_${nodeId}_installer.sh`);
    await writeFile(cached, oldConfig.join('\0') + '\0');
    await writeFile(cachedInstaller, oldScript);
    await writeFile(join(root, 'fresh.config'), scenario === 'invalid' ? 'invalid' : fresh.join('\0') + '\0');
    await writeFile(join(root, 'new-installer'), newScript);
    const result = bash(`${isolatedInstaller(root)}
curl() {
  local url="" out=""
  while [[ $# -gt 0 ]]; do case "$1" in https://*) url="$1" ;; -o) shift; out="$1" ;; esac; shift; done
  case "$url" in
    */api/v1/bootstrap/*) [[ "$SCENARIO" != expired ]] || return 22; cp ${shell(join(root, 'fresh.config'))} "$out" ;;
    */public/install.sh) cp ${shell(join(root, 'new-installer'))} "$out" ;;
    *) return 99 ;;
  esac
}
run_probe_bootstrap() { printf '%s\\n%s\\n' "$PROBE_INSTALLER_SHA256" "$NYANPASS_INSTALL_SHA256"; }
bootstrap_node ${shell(bootstrapUrl)}
`, {SCENARIO: scenario});
    if (scenario === 'refresh') {
      succeeded(result);
      assert.equal(await readFile(cached, 'utf8'), fresh.join('\0') + '\0');
      assert.equal(await readFile(cachedInstaller, 'utf8'), newScript);
      assert.ok(result.stdout.includes(digest(newScript)) && result.stdout.includes('c'.repeat(64)));
    } else {
      if (scenario === 'expired') succeeded(result); else assert.notEqual(result.status, 0);
      assert.equal(await readFile(cached, 'utf8'), oldConfig.join('\0') + '\0');
      assert.equal(await readFile(cachedInstaller, 'utf8'), oldScript);
    }
  }));
}

for (const scenario of ['accepted', 'offline', 'bad-marker', 'wrong-service']) {
  test(`completed one-click recovery bypasses revoked downloads: ${scenario}`, () => fixture(async (root) => {
    const state = join(root, `state-${nodeId}`);
    await mkdir(state);
    await writeFile(join(state, 'complete'), `1\n${scenario === 'bad-marker' ? 'invalid' : attemptId}\n`);
    await writeFile(join(root, 'ddns.conf'), `SERVER_URL=https://master.example.test\nTOKEN=pd_${'b'.repeat(64)}\n`);
    await writeFile(join(root, 'monitor.sh'), '# fixture\n');
    await writeFile(join(root, 'ddns.service'), `ExecStart=/bin/bash ${root}/${scenario === 'wrong-service' ? 'foreign.sh' : 'monitor.sh'} --run\n`);
    const result = bash(`${isolatedInstaller(root)}
curl() {
  [[ " $* " == *" -X POST "* ]] || { echo unexpected-download >&2; return 99; }
  echo receipt
  [[ "$SCENARIO" != offline ]] || return 7
  printf '{"status":"ok","disposition":"duplicate"}'
}
systemctl() { echo "service:$*"; }
bootstrap_node ${shell(bootstrapUrl)}
`, {SCENARIO: scenario});
    assert.doesNotMatch(result.stderr, /unexpected-download/);
    if (['accepted', 'offline'].includes(scenario)) {
      succeeded(result);
      assert.match(result.stdout, /service:enable --now ddns-monitor/);
      const receipts = await readdir(join(root, 'outcomes'));
      assert.equal(receipts.length, scenario === 'offline' ? 1 : 0);
      if (receipts.length) assert.equal(JSON.parse(await readFile(join(root, 'outcomes', receipts[0]), 'utf8')).outcome, 'succeeded');
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /service:/);
    }
  }));
}

for (const entrypoint of ['agent-upgrade', 'update.sh']) {
  for (const scenario of ['bootstrap-busy', 'task-busy', 'idle']) {
    test(`upgrade serialization ${entrypoint}: ${scenario}`, () => fixture(async (root) => {
      await writeFile(join(root, 'config'), 'fixture');
      const common = `set -eu
BOOTSTRAP_LOCK_FILE=${shell(join(root, 'bootstrap.lock'))}
TASK_LOCK_FILE=${shell(join(root, 'task.lock'))}
CONFIG_FILE=${shell(join(root, 'config'))}
info() { :; }
log() { :; }
fail() { echo "$*" >&2; exit 1; }
need_root() { :; }
install_deps() { :; }
install_runtime_deps() { :; }
load_ddns_config() { :; }
flock() {
  echo "lock:$*"
  [[ "$SCENARIO:$*" != 'bootstrap-busy:-n 9' && "$SCENARIO:$*" != 'task-busy:-w 900 8' ]]
}
install_ddns_service() { echo installed; }
`;
      const code = entrypoint === 'agent-upgrade'
        ? `${fn(installer, 'upgrade_ddns_agent')}\nVERSION=fixture\nupgrade_ddns_agent`
        : `${updater.slice(updater.indexOf('\ninstall_runtime_deps\n'), updater.indexOf('\nvalidate_install_dir\n'))}\necho installed`;
      const result = bash(common + code, {SCENARIO: scenario});
      if (scenario === 'idle') { succeeded(result); assert.match(result.stdout, /lock:-n 9\nlock:-w 900 8\ninstalled/); }
      else { assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /installed/); }
      if (scenario === 'bootstrap-busy') assert.doesNotMatch(result.stdout, /lock:-w/);
    }));
  }
}
