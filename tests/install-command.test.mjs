import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildNodeStartupScript, shellArg } from '../lib/install-command.ts';

const origin = 'http://203.0.113.9:39900/0123456789abcdef0123456789abcdef';
const command = buildNodeStartupScript({
  nodeId: '11111111-2222-4333-8444-555555555555',
  origin,
  token: 'pd_token_with_underscore',
  rootPassword: "space $ bang ! slash \\ quote '",
  instances: [
    { name: 'tenant-in', optimize: false, args: '-t inbound-token -u https://ny.example.test' },
    { name: 'tenant-out', optimize: true, args: '-o -t outbound-token -u https://ny.example.test' },
  ],
});

test('startup script uses the strict provision action and preserves plain URLs', () => {
  assert.match(command, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/);
  assert.match(command, /bash "\$tmp" provision --server/);
  assert.doesNotMatch(command, /bash "\$tmp" (?:all|install)\b/);
  assert.equal(command.includes(`${origin}/install.sh`), true);
  assert.equal(command.includes(origin), true);
  assert.equal(command.includes('pd_token_with_underscore'), true);
  assert.doesNotMatch(command, /\[[^\]]+\]\(https?:\/\//);
  assert.doesNotMatch(command, /pd\\_/);
  assert.match(command, /grep -Fq '# PulseDNS \/ 原 DDNS 脚本兼容安装器'/);
  assert.match(command, /bash -n "\$tmp"/);
});

test('startup script is boot-safe and only marks a fully successful installation', () => {
  assert.match(command, /pulsedns-bootstrap-11111111-2222-4333-8444-555555555555/);
  assert.match(command, /\/run\/pulsedns-bootstrap\.lock/);
  assert.match(command, /tee -a "\$log_file"/);
  assert.match(command, /for attempt in \{1\.\.36\}/);
  assert.ok(command.indexOf('/api/v1/report') < command.indexOf(': > "$started_file"'));
  assert.ok(command.indexOf(': > "$started_file"') < command.indexOf('bash "$tmp" provision'));
  assert.ok(command.indexOf('bash "$tmp" provision') < command.indexOf('mv -f "$started_file" "$complete_file"'));
  assert.match(command, /上次安装在中途失败/);
  assert.match(command, /systemctl enable --now ddns-monitor/);
});

test('node command keeps all Nyanpass instances and shell-quotes secrets', () => {
  assert.equal((command.match(/--nyanpass-instance/g) ?? []).length, 2);
  assert.equal(command.includes(shellArg("space $ bang ! slash \\ quote '")), true);
  assert.ok(command.indexOf("'tenant-in'") < command.indexOf("'tenant-out'"));
  assert.match(command, /--nyanpass-instance 'tenant-out' '1' '-o -t outbound-token/);
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
log() { :; }
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
  assert.deepEqual(failed.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials', 'fix_locale', 'ssh', 'ddns']);

  const rejected = spawnSync(bash, ['-s', '--', 'credentials-fail'], { input: harness, encoding: 'utf8' });
  assert.equal(rejected.status, 41, rejected.stderr);
  assert.deepEqual(rejected.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials']);

  const succeeded = spawnSync(bash, ['-s', '--', 'success'], { input: harness, encoding: 'utf8' });
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.deepEqual(succeeded.stdout.trim().split('\n'), ['root', 'validate', 'deps', 'credentials', 'fix_locale', 'ssh', 'ddns', 'deps', 'nyanpass', 'bbr', 'verify']);
});
