import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildNodeConnectCommand, buildNodeStartupScript, PROBE_INSTALLER_SHA256, PROBE_INSTALLER_URL, shellArg } from '../lib/install-command.ts';

const origin = 'http://203.0.113.9:39900/0123456789abcdef0123456789abcdef';
const nyanpassRelease = {
  installerUrl: 'https://dl.nyafw.com/download/nyanpass-install.sh',
  installerSha256: 'a'.repeat(64),
  binaryBaseUrl: 'https://dl.nyafw.com/download/zf-contract',
  binaryRelease: '11111111-2222-4333-8444-555555555555',
  binaryAmd64Sha256: 'b'.repeat(64),
  binaryAmd64v3Sha256: 'c'.repeat(64),
  binaryArm64Sha256: 'd'.repeat(64),
};
const command = buildNodeStartupScript({
  nodeId: '11111111-2222-4333-8444-555555555555',
  generation: 1,
  origin,
  token: 'pd_token_with_underscore',
  rootPassword: "space $ bang ! slash \\ quote '",
  instances: [
    { name: 'tenant-in', optimize: false, args: '-t inbound-token -u https://ny.example.test' },
    { name: 'tenant-out', optimize: true, args: '-o -t outbound-token -u https://ny.example.test' },
  ],
  nyanpassRelease,
});

test('node connection command is one public script plus one opaque node parameter', () => {
  const installUrl = `${origin}/api/v1/bootstrap/11111111-2222-4333-8444-555555555555/pbs_${'a'.repeat(64)}`;
  const connectCommand = buildNodeConnectCommand(installUrl);
  assert.equal(connectCommand, `bash <(curl --proto '=https' --proto-redir '=https' -fLSs '${PROBE_INSTALLER_URL}') bootstrap '${installUrl}'`);
  assert.equal(connectCommand.includes('\n'), false);
  assert.doesNotMatch(connectCommand, /rootPassword|nyanpass|--server|--token/);
  const result = spawnSync(process.env.BASH_EXE || 'bash', ['-n'], { input: connectCommand, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('startup script uses the strict provision action and a pinned HTTPS installer', () => {
  assert.match(command, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/);
  assert.match(command, /bash "\$tmp" provision --provision-config/);
  assert.match(command, /provision --provision-config "\$provision_config" --bbr '1'/);
  assert.doesNotMatch(command, /provision[^\n]*(?:--token|--root-password|--nyanpass-instance)/);
  assert.doesNotMatch(command, /bash "\$tmp" (?:all|install)\b/);
  assert.equal(command.includes(PROBE_INSTALLER_URL), true);
  assert.equal(command.includes(PROBE_INSTALLER_SHA256), true);
  assert.doesNotMatch(command, new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/install\\.sh`));
  assert.equal(command.includes(origin), true);
  assert.equal(command.includes('pd_token_with_underscore'), true);
  assert.doesNotMatch(command, /\[[^\]]+\]\(https?:\/\//);
  assert.doesNotMatch(command, /pd\\_/);
  assert.match(command, /grep -Fq '# PulseDNS \/ 原 DDNS 脚本兼容安装器'/);
  assert.match(command, /bash -n "\$tmp"/);
  const installer = readFileSync(new URL('../public/install.sh', import.meta.url));
  assert.equal(PROBE_INSTALLER_SHA256, createHash('sha256').update(installer).digest('hex'));
});

test('startup script is boot-safe and only marks a fully successful installation', () => {
  assert.match(command, /pulsedns-bootstrap-11111111-2222-4333-8444-555555555555/);
  assert.match(command, /\/run\/pulsedns-bootstrap\.lock/);
  assert.match(command, /ensure_bootstrap_environment/);
  assert.match(command, /for attempt in \{1\.\.24\}/);
  assert.match(command, /等待包管理器或网络/);
  assert.match(command, /apt-get install -y -qq curl ca-certificates coreutils util-linux sed grep gawk/);
  assert.match(command, /for command_name in curl sha256sum flock setsid tee sed tr mktemp install chmod stat mv rm sleep grep awk systemctl/);
  for (const caBundle of [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ]) assert.equal(command.includes(caBundle), true, `missing CA bundle check: ${caBundle}`);
  assert.match(command, /bootstrap_commands_ready && bootstrap_ca_bundle_ready && return 0/);
  assert.match(command, /bootstrap_commands_ready && bootstrap_ca_bundle_ready\n}/);
  const ensureInvocation = command.lastIndexOf('\nensure_bootstrap_environment\n');
  const logRedirection = command.indexOf('exec > >(tee -a "$log_file")');
  const operationLock = command.indexOf('exec 9>"$lock_file"');
  assert.ok(ensureInvocation >= 0 && ensureInvocation < logRedirection && logRedirection < operationLock);
  assert.match(command, /exec 9>"\$lock_file"[\s\S]*flock -n 9/);
  assert.doesNotMatch(command, /exec \{[A-Za-z_][A-Za-z0-9_]*\}>/);
  assert.doesNotMatch(command, /mkdir "\$lock_dir"/);
  assert.match(command, /tee -a "\$log_file"/);
  assert.match(command, /for attempt in \{1\.\.36\}/);
  assert.ok(command.indexOf('report_provision_message start') < command.indexOf('mv -f "$attempt_file" "$started_file"'));
  assert.ok(command.indexOf('mv -f "$attempt_file" "$started_file"') < command.indexOf('bash "$tmp" provision'));
  assert.ok(command.indexOf('bash "$tmp" provision') < command.indexOf('mv -f "$started_file" "$complete_file"'));
  assert.ok(command.indexOf('mv -f "$started_file" "$complete_file"') < command.lastIndexOf('\nstop_heartbeat\n'));
  assert.ok(command.indexOf('mv -f "$started_file" "$complete_file"') < command.lastIndexOf('deliver_finish_outcome succeeded'));
  assert.match(command, /\/var\/lib\/ddns-monitor\/provision-outcomes/);
  assert.match(command, /\/api\/v1\/provision/);
  assert.match(command, /"protocol":1,"phase":"%s","generation":%s,"attemptId":"%s"/);
  assert.match(command, /persist_finish_outcome failed/);
  assert.match(command, /heartbeat_loop "\$\$"/);
  assert.match(command, /PULSEDNS_PROVISION_STAGE_FILE="\$stage_file" setsid bash "\$tmp" provision[\s\S]*provision_pid=\$![\s\S]*wait "\$provision_pid"/);
  assert.match(command, /on_signal\(\)[\s\S]*stop_provision_process_group "\$signal"/);
  assert.match(command, /kill -s "\$signal" -- "-\$provision_pid"/);
  assert.match(command, /terminal_written/);
  assert.match(command, /install -d -m 0700 "\$outcome_dir" \|\| return 1/);
  assert.match(command, /if outcome_file=\$\(persist_finish_outcome "\$terminal_outcome"\); then[\s\S]*terminal_written=1/);
  assert.match(command, /无法持久化最终回执；本地状态标记仍保留/);
  assert.match(command, /for stale_config in "\$state_dir"\/\.provision-config\.\*[\s\S]*! -L "\$stale_config"[\s\S]*rm -f "\$stale_config"/);
  assert.match(command, /-f "\$complete_file"[\s\S]*terminal_outcome='succeeded'/);
  assert.match(command, /deliver_finish_outcome "\$terminal_outcome"/);
  assert.match(command, /上次安装在中途停止/);
  assert.match(command, /主控尚未确认旧安装已结束；不要删除 started 标记/);
  assert.match(command, /主控已确认旧安装失败[\s\S]*删除 \$started_file/);
  assert.match(command, /provision_disposition" == 'accepted'.*provision_disposition" == 'duplicate'/);
  assert.match(command, /systemctl enable --now ddns-monitor/);
  assert.match(command, /current_provision_step\(\)/);
  assert.match(command, /"lastCompletedStep":"%s"/);
});

test('node command keeps all Nyanpass instances in a root-only config instead of child argv', () => {
  assert.match(command, /PULSEDNS_PROVISION_V2/);
  assert.match(command, /printf '%s\\0' 'PULSEDNS_PROVISION_V2' "\$server_url" "\$token" "\$root_password"/);
  assert.equal(command.includes(nyanpassRelease.binaryRelease), true);
  assert.equal(command.includes(nyanpassRelease.binaryArm64Sha256), true);
  assert.equal(command.includes(shellArg("space $ bang ! slash \\ quote '")), true);
  assert.ok(command.indexOf("'tenant-in'") < command.indexOf("'tenant-out'"));
  assert.match(command, /printf '%s\\0' 'tenant-out' '1' '-o -t outbound-token/);
  assert.doesNotMatch(command, /setsid bash[^\n]*inbound-token/);
});

test('generated command parses in Bash when Bash is available', (context) => {
  const bash = process.env.BASH_EXE || 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (available.error) {
    context.skip(`Bash unavailable: ${available.error.message}`);
    return;
  }
  const result = spawnSync(bash, ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('provision stops before Nyanpass when DDNS installation fails', (context) => {
  const bash = process.env.BASH_EXE || 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (available.error) {
    context.skip(`Bash unavailable: ${available.error.message}`);
    return;
  }

  const installer = readFileSync(new URL('../public/install.sh', import.meta.url), 'utf8');
  const actionOffset = installer.indexOf('\nACTION="${1:-menu}"');
  assert.ok(actionOffset > 0, 'installer action dispatcher missing');
  const harness = `${installer.slice(0, actionOffset)}
SCENARIO="\${1:-success}"
APPLY_BBR=1
TASK_LOCK_FILE=/tmp/ddns-monitor-nyanpass-contract.lock
log() { :; }
flock() { :; }
need_root() { printf '%s\\n' root; }
validate_provision_request() { printf '%s\\n' validate; }
fix_locale() { printf '%s\\n' fix_locale; }
configure_ssh() { printf '%s\\n' ssh; }
install_ddns_service() { printf '%s\\n' ddns; [[ "$SCENARIO" != ddns-fail ]] || return 23; }
install_deps() { printf '%s\\n' deps; }
validate_ddns_credentials_remote() { printf '%s\\n' credentials; [[ "$SCENARIO" != credentials-fail ]] || return 41; }
install_nyanpass_batch() { printf '%s\\n' nyanpass; }
configure_bbr() { printf '%s\\n' bbr; }
verify_ddns_service() { printf '%s\\n' verify; }
provision_node
`;

  const failed = spawnSync(bash, ['-s', '--', 'ddns-fail'], { input: harness, encoding: 'utf8' });
  assert.equal(failed.status, 23, failed.stderr);
  assert.deepEqual(failed.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials', 'fix_locale', 'ddns']);

  const rejected = spawnSync(bash, ['-s', '--', 'credentials-fail'], { input: harness, encoding: 'utf8' });
  assert.equal(rejected.status, 41, rejected.stderr);
  assert.deepEqual(rejected.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials']);

  const succeeded = spawnSync(bash, ['-s', '--', 'success'], { input: harness, encoding: 'utf8' });
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.deepEqual(succeeded.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials', 'fix_locale', 'ddns', 'nyanpass', 'bbr', 'ssh', 'verify']);
});
