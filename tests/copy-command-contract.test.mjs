import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

register('./path-alias-loader.mjs', import.meta.url);

const { copyText } = await import('../lib/copy-text.ts');
const { PROBE_INSTALLER_SHA256, PROBE_INSTALLER_URL } = await import('../lib/install-command.ts');
const { buildNodeStartupLauncher } = await import('../lib/startup-launcher.ts');

const helper = await readFile(new URL('../lib/copy-text.ts', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');

test('HTTP deployments have a synchronous clipboard fallback', () => {
  assert.match(helper, /window\.isSecureContext/);
  assert.match(helper, /navigator\.clipboard\?\.writeText/);
  assert.match(helper, /document\.createElement\('textarea'\)/);
  assert.match(helper, /document\.execCommand\('copy'\)/);
});

test('copy buttons await the result and expose success or failure', () => {
  assert.match(dashboard, /公共安装脚本 \+ 节点专属参数/);
  assert.match(dashboard, /复制[^<]{0,20}探针对接命令/);
  assert.doesNotMatch(dashboard, /created\.installUrl/);
  assert.doesNotMatch(dashboard, /created\.installCommand/);
  assert.match(dashboard, /created\.connectCommand/);
  assert.match(dashboard, /created\.startupScript/);
  assert.match(dashboard, /复制探针对接命令/);
  assert.match(dashboard, /复制 AWS User data/);
  assert.match(dashboard, /setCopyFeedback\(await copyText\(command\) \? 'success' : 'error'\)/);
  assert.match(dashboard, /setStartupCopyFeedback\(await copyText\(script\) \? 'success' : 'error'\)/);
  assert.match(dashboard, /已按 LF 换行复制[\s\S]{0,100}User data/);
  assert.match(dashboard, /AWS User data（可选断网重试）/);
  assert.match(dashboard, /User data 未执行/);
  assert.match(dashboard, /不能作为 ASG 或 Launch Template 的共享 User data/);
  assert.match(dashboard, /剪贴板内容没有更新|手动选中[^。]{0,30}命令/);
  assert.doesNotMatch(dashboard, /onClick=\{\(\) => navigator\.clipboard\.writeText/);
});

test('generated cloud launcher verifies the fixed installer and passes one node parameter', () => {
  const nodeParameter = 'http://203.0.113.9:39900/0123456789abcdef0123456789abcdef/api/v1/bootstrap/11111111-2222-4333-8444-555555555555/pbs_abc123';
  const launcher = buildNodeStartupLauncher('11111111-2222-4333-8444-555555555555', nodeParameter, 1);
  assert.match(launcher, /^#!\/bin\/sh\nset -u\n/);
  assert.match(launcher, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(launcher, /pulsedns-bootstrap-launcher\.log/);
  assert.match(launcher, /bash_ready\(\)/);
  assert.match(launcher, /BASH_VERSINFO\[0\]/);
  assert.match(launcher, /ca_bundle_ready\(\)/);
  assert.match(launcher, /installer_tools_ready\(\)/);
  assert.match(launcher, /apt-get[\s\S]*dnf[\s\S]*yum[\s\S]*apk/);
  assert.match(launcher, /bash curl ca-certificates coreutils grep/);
  assert.match(launcher, /while \[ "\$attempt" -le 24 \]/);
  assert.match(launcher, /while \[ "\$attempt" -le 36 \]/);
  assert.match(launcher, /curl --proto '=https' --proto-redir '=https'[\s\S]*"\$installer_url" -o "\$download_path"/);
  assert.equal(launcher.includes(`installer_url='${PROBE_INSTALLER_URL}'`), true);
  assert.equal(launcher.includes(`installer_sha256='${PROBE_INSTALLER_SHA256}'`), true);
  assert.match(launcher, /valid_installer\(\)[\s\S]*grep -Fq '# PulseDNS \/ 原 DDNS 脚本兼容安装器'[\s\S]*\/bin\/bash -n "\$script_path"[\s\S]*sha256sum "\$script_path"/);
  assert.match(launcher, /\/bin\/bash "\$script_path" probe "\$node_parameter"/);
  assert.doesNotMatch(launcher, /wget|text\/x-shellscript/);
  assert.doesNotMatch(launcher, /\[\[/);
  assert.match(launcher, /complete_matches_generation\(\)/);
  assert.match(launcher, /persist_per_boot\(\)/);
  assert.match(launcher, /run_cached_installer\(\)/);
  assert.match(launcher, /scrub_completed_bootstrap\(\)/);
  assert.match(launcher, /\/var\/lib\/cloud\/scripts\/per-boot\/pulsedns-bootstrap-/);
  assert.match(launcher, /\[ "\$stored_generation" = "\$expected_generation" \]/);
  const completeCheck = launcher.indexOf('if complete_matches_generation; then');
  const persistCheck = launcher.lastIndexOf('\npersist_per_boot\n');
  const packageCheck = launcher.indexOf('if ! bootstrap_ready; then');
  const cachedCheck = launcher.lastIndexOf('\nrun_cached_installer || true\n');
  const downloadCheck = launcher.indexOf('while [ "$attempt" -le 36 ]');
  assert.ok(completeCheck >= 0 && completeCheck < persistCheck && persistCheck < packageCheck && packageCheck < cachedCheck && cachedCheck < downloadCheck);
  assert.ok(Buffer.byteLength(launcher) < 15 * 1024);
  const result = spawnSync('/bin/sh', ['-n'], { input: launcher, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('completed startup skips download, restores service, and removes sensitive caches', async () => {
  const fixture = await createLauncherFixture();
  try {
    await mkdir(fixture.stateDir, { recursive: true });
    const cachedUserData = join(fixture.cloudInstancesDir, 'runner', 'user-data.txt');
    await mkdir(join(fixture.cloudInstancesDir, 'runner'), { recursive: true });
    await writeFile(cachedUserData, 'host-owned user data');
    await chmod(cachedUserData, 0o400);
    await writeFile(join(fixture.stateDir, 'complete'), '1\nattempt\n');
    await writeFile(fixture.scriptPath, 'sensitive installer cache');
    await writeFile(fixture.configPath, 'sensitive configuration cache');
    await writeExecutable(join(fixture.mockBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_CALLS"
`);
    await writeExecutable(join(fixture.mockBin, 'curl'), `#!/bin/sh
printf 'unexpected-download\\n' >> "$MOCK_CALLS"
exit 99
`);

    const result = runLauncher(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.callsFile, 'utf8'), 'enable --now ddns-monitor\n');
    assert.equal(await readFile(cachedUserData, 'utf8'), 'host-owned user data');
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.configPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.perBootPath), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('startup retries fixed-installer downloads and invokes probe with the node parameter', async () => {
  const fixture = await createLauncherFixture();
  try {
    await mkdir(fixture.stateDir, { recursive: true });
    await writeFile(join(fixture.stateDir, 'complete'), '0\nstale-attempt\n');
    await writeExecutable(join(fixture.mockBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    await writeCurlMock(fixture, 3);

    const result = runLauncher(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.countFile, 'utf8'), '3\n');
    assert.match(await readFile(fixture.callsFile, 'utf8'), new RegExp(`probe ${escapeRegExp(fixture.nodeParameter)}`));
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.perBootPath), { code: 'ENOENT' });
    assert.match(await readFile(fixture.logFile, 'utf8'), /等待网络和 GitHub 固定安装器就绪（2\/36）/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed probe execution persists per-boot and reuses the verified installer cache', async () => {
  const fixture = await createLauncherFixture({ requireSuccessFile: true });
  const allowSuccess = join(fixture.root, 'allow-success');
  try {
    await writeExecutable(join(fixture.mockBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    await writeCurlMock(fixture, 1);

    const environment = { MOCK_ALLOW_SUCCESS: allowSuccess };
    const failed = runLauncher(fixture, environment);
    assert.equal(failed.status, 23, failed.stderr);
    assert.equal(await readFile(fixture.countFile, 'utf8'), '1\n');
    assert.match(await readFile(fixture.perBootPath, 'utf8'), /^#!\/bin\/sh/);
    assert.match(await readFile(fixture.scriptPath, 'utf8'), /^#!\/bin\/bash/);

    await writeFile(allowSuccess, '1');
    const retried = runLauncher(fixture, environment, fixture.perBootPath);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(await readFile(fixture.countFile, 'utf8'), '1\n');
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.perBootPath), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('insecure HTTP context copies through the textarea fallback', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let appended = false;
  let removed = false;
  let copiedValue = '';
  const textarea = {
    value: '', readOnly: false, style: {},
    setAttribute() {}, focus() {}, select() {}, setSelectionRange() {},
    remove() { removed = true; },
  };

  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: false } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => assert.fail('modern clipboard must not run on HTTP') } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement(tag) { assert.equal(tag, 'textarea'); return textarea; },
      body: { appendChild(node) { appended = node === textarea; } },
      execCommand(command) { assert.equal(command, 'copy'); copiedValue = textarea.value; return true; },
    } });

    assert.equal(await copyText('full\r\nprovision\rcommand'), true);
    assert.equal(copiedValue, 'full\nprovision\ncommand');
    assert.equal(appended, true);
    assert.equal(removed, true);
  } finally {
    restoreGlobal('window', originalWindow);
    restoreGlobal('navigator', originalNavigator);
    restoreGlobal('document', originalDocument);
  }
});

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

async function createLauncherFixture({ requireSuccessFile = false } = {}) {
  const nodeId = '11111111-2222-4333-8444-555555555555';
  const nodeParameter = `https://bootstrap.example.test/api/v1/bootstrap/${nodeId}/pbs_${'a'.repeat(64)}`;
  const root = await mkdtemp(join(tmpdir(), 'pulsedns-launcher-'));
  const mockBin = join(root, 'bin');
  const stateDir = join(root, `pulsedns-bootstrap-${nodeId}`);
  const scriptPath = join(root, `pulsedns_${nodeId}_installer.sh`);
  const configPath = join(root, `pulsedns_${nodeId}_bootstrap.config`);
  const logFile = join(root, 'launcher.log');
  const callsFile = join(root, 'calls.log');
  const countFile = join(root, 'curl.count');
  const sourcePath = join(root, 'fixed-installer.sh');
  const perBootDir = join(root, 'per-boot');
  const cloudInstancesDir = join(root, 'cloud-instances');
  const perBootPath = join(perBootDir, `pulsedns-bootstrap-${nodeId}.sh`);
  const launcherPath = join(root, 'user-data.sh');
  const installerSource = `#!/bin/bash
# PulseDNS / 原 DDNS 脚本兼容安装器
printf '%s\\n' "$*" >> "$MOCK_CALLS"
${requireSuccessFile ? '[ -f "$MOCK_ALLOW_SUCCESS" ] || exit 23' : ':'}
exit 0
`;
  const installerHash = createHash('sha256').update(installerSource).digest('hex');
  await mkdir(mockBin, { recursive: true });
  await writeFile(callsFile, '');
  await writeFile(sourcePath, installerSource);
  await writeExecutable(join(mockBin, 'id'), '#!/bin/sh\nprintf "0\\n"\n');
  await writeExecutable(join(mockBin, 'sha256sum'), '#!/bin/sh\nprintf "%s  %s\\n" "$MOCK_INSTALLER_SHA256" "$1"\n');

  const generated = buildNodeStartupLauncher(nodeId, nodeParameter, 1);
  const launcher = generated
    .replace(
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `PATH=${mockBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replace(`installer_sha256='${PROBE_INSTALLER_SHA256}'`, `installer_sha256='${installerHash}'`)
    .replaceAll('/var/log/pulsedns-bootstrap-launcher.log', logFile)
    .replaceAll(`/root/pulsedns_${nodeId}_installer.sh`, scriptPath)
    .replaceAll(`/root/pulsedns_${nodeId}_bootstrap.config`, configPath)
    .replaceAll(`/var/lib/pulsedns-bootstrap-${nodeId}`, stateDir)
    .replaceAll('/var/lib/cloud/scripts/per-boot', perBootDir)
    .replaceAll('/var/lib/cloud/instances', cloudInstancesDir);
  await writeExecutable(launcherPath, launcher);

  return {
    root, mockBin, stateDir, scriptPath, configPath, logFile, callsFile, countFile,
    sourcePath, installerHash, perBootPath, cloudInstancesDir, launcherPath, launcher, nodeParameter,
  };
}

async function writeCurlMock(fixture, succeedAt) {
  await writeExecutable(join(fixture.mockBin, 'curl'), `#!/bin/sh
count=0
[ ! -f "$MOCK_CURL_COUNT" ] || count=$(cat "$MOCK_CURL_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOCK_CURL_COUNT"
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then output="$2"; shift 2; else shift; fi
done
[ "$count" -ge "$MOCK_SUCCEED_AT" ] || exit 1
cp "$MOCK_INSTALLER_SOURCE" "$output"
`);
  fixture.environment = { ...(fixture.environment || {}), MOCK_SUCCEED_AT: String(succeedAt) };
}

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function runLauncher(fixture, extraEnvironment = {}, launcherPath = fixture.launcherPath) {
  const shell = existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';
  return spawnSync(shell, [launcherPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MOCK_CALLS: fixture.callsFile,
      MOCK_CURL_COUNT: fixture.countFile,
      MOCK_INSTALLER_SOURCE: fixture.sourcePath,
      MOCK_INSTALLER_SHA256: fixture.installerHash,
      ...fixture.environment,
      ...extraEnvironment,
    },
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
