import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildNodeBootstrapConfig,
  buildNodeConnectCommand,
  PROBE_INSTALLER_SHA256,
  PROBE_INSTALLER_URL,
  shellArg,
} from '../lib/install-command.ts';

const nodeId = '11111111-2222-4333-8444-555555555555';
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
const rootPassword = "space $ bang ! slash \\ quote ' 中文";
const instances = [
  { name: 'tenant-in', optimize: false, args: '-t inbound-token -u https://ny.example.test' },
  { name: 'tenant-out', optimize: true, args: '-o -t outbound-token -u https://ny.example.test --ws-port 1145' },
];

function buildConfig(overrides = {}) {
  return buildNodeBootstrapConfig({
    nodeId,
    generation: 7,
    origin,
    token: 'pd_token_with_underscore',
    rootPassword,
    instances,
    nyanpassRelease,
    ...overrides,
  });
}

test('node connection command is one fixed public script plus one opaque node parameter', () => {
  const installUrl = `${origin}/api/v1/bootstrap/${nodeId}/pbs_${'a'.repeat(64)}`;
  const connectCommand = buildNodeConnectCommand(installUrl);
  assert.equal(connectCommand, `bash <(curl --proto '=https' --proto-redir '=https' -fLSs '${PROBE_INSTALLER_URL}') probe '${installUrl}'`);
  assert.equal(connectCommand.includes('\n'), false);
  assert.doesNotMatch(connectCommand, /rootPassword|nyanpass|--server|--token/);
  const result = spawnSync(process.env.BASH_EXE || 'bash', ['-n'], { input: connectCommand, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('bootstrap endpoint payload is bounded configuration data rather than generated shell', () => {
  const config = buildConfig();
  assert.equal(config.endsWith('\0'), true);
  assert.equal(config.includes('\n'), false);
  assert.doesNotMatch(config, /^#!|set -E|\/api\/v1\/provision|setsid bash/);
  assert.ok(new TextEncoder().encode(config).byteLength < 64 * 1024);

  const fields = config.split('\0');
  assert.equal(fields.pop(), '');
  assert.deepEqual(fields.slice(0, 16), [
    'PULSEDNS_BOOTSTRAP_V1',
    nodeId,
    '7',
    origin,
    'pd_token_with_underscore',
    rootPassword,
    PROBE_INSTALLER_URL,
    PROBE_INSTALLER_SHA256,
    nyanpassRelease.installerUrl,
    nyanpassRelease.installerSha256,
    nyanpassRelease.binaryBaseUrl,
    nyanpassRelease.binaryRelease,
    nyanpassRelease.binaryAmd64Sha256,
    nyanpassRelease.binaryAmd64v3Sha256,
    nyanpassRelease.binaryArm64Sha256,
    '2',
  ]);
  assert.deepEqual(fields.slice(16), [
    'tenant-in', '0', '-t inbound-token -u https://ny.example.test',
    'tenant-out', '1', '-o -t outbound-token -u https://ny.example.test --ws-port 1145',
  ]);
});

test('bootstrap configuration rejects NUL bytes instead of truncating a field', () => {
  assert.throws(() => buildConfig({ rootPassword: 'valid-prefix\0hidden-tail' }), /NUL byte/);
});

test('fixed probe installer URL and digest match the published installer', () => {
  assert.match(PROBE_INSTALLER_URL, /^https:\/\/raw\.githubusercontent\.com\/rosalgee4-lgtm\/pulsedns-control\/release-v0\.8\.2\/public\/install\.sh$/);
  const installer = readFileSync(new URL('../public/install.sh', import.meta.url));
  assert.equal(PROBE_INSTALLER_SHA256, createHash('sha256').update(installer).digest('hex'));
  assert.equal(shellArg("a'b"), "'a'\\''b'");
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
