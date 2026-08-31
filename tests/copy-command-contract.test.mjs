import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyText } from '../lib/copy-text.ts';
import { buildNodeStartupLauncher } from '../lib/startup-launcher.ts';

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

test('generated cloud startup launcher is POSIX, boot-resilient, and bounded', () => {
  const launcher = buildNodeStartupLauncher(
    '11111111-2222-4333-8444-555555555555',
    'http://203.0.113.9:39900/0123456789abcdef0123456789abcdef/api/v1/bootstrap/11111111-2222-4333-8444-555555555555/pbs_abc123',
    1,
  );
  assert.match(launcher, /^#!\/bin\/sh\nset -u\n/);
  assert.match(launcher, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(launcher, /pulsedns-bootstrap-launcher\.log/);
  assert.match(launcher, /bash_ready\(\)/);
  assert.match(launcher, /BASH_VERSINFO\[0\]/);
  assert.match(launcher, /ca_bundle_ready\(\)/);
  assert.match(launcher, /downloader_ready\(\)/);
  assert.match(launcher, /apt-get[\s\S]*dnf[\s\S]*yum[\s\S]*apk/);
  assert.match(launcher, /bash wget ca-certificates/);
  assert.match(launcher, /while \[ "\$attempt" -le 24 \]/);
  assert.match(launcher, /while \[ "\$attempt" -le 36 \]/);
  assert.match(launcher, /wget -q -T 20 -t 1/);
  assert.match(launcher, /curl --connect-timeout 10 --max-time 30 -fLSs/);
  assert.match(launcher, /\/bin\/bash -n "\$download_path"/);
  assert.doesNotMatch(launcher, /\[\[/);
  assert.match(launcher, /complete_matches_generation\(\)/);
  assert.match(launcher, /persist_per_boot\(\)/);
  assert.match(launcher, /run_cached_script\(\)/);
  assert.match(launcher, /scrub_completed_bootstrap\(\)/);
  assert.match(launcher, /\/var\/lib\/cloud\/scripts\/per-boot\/pulsedns-bootstrap-/);
  assert.match(launcher, /\[ "\$stored_generation" = "\$expected_generation" \]/);
  const completeCheck = launcher.indexOf('if complete_matches_generation; then');
  const persistCheck = launcher.lastIndexOf('\npersist_per_boot\n');
  const packageCheck = launcher.indexOf('if ! bootstrap_ready; then');
  const cachedCheck = launcher.lastIndexOf('\nrun_cached_script || true\n');
  const downloadCheck = launcher.indexOf('while [ "$attempt" -le 36 ]');
  assert.ok(completeCheck >= 0 && completeCheck < persistCheck && persistCheck < packageCheck && packageCheck < cachedCheck && cachedCheck < downloadCheck);
  assert.ok(Buffer.byteLength(launcher) < 15 * 1024);
  const result = spawnSync('/bin/sh', ['-n'], { input: launcher, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('completed startup skips the revoked URL and restores the existing service', async () => {
  const fixture = await createLauncherFixture();
  try {
    await mkdir(fixture.stateDir, { recursive: true });
    const cachedUserData = join(fixture.cloudInstancesDir, 'runner', 'user-data.txt');
    await mkdir(join(fixture.cloudInstancesDir, 'runner'), { recursive: true });
    await writeFile(cachedUserData, 'host-owned user data');
    await chmod(cachedUserData, 0o400);
    await writeFile(join(fixture.stateDir, 'complete'), '1\nattempt\n');
    await writeFile(fixture.scriptPath, 'sensitive bootstrap payload');
    await writeExecutable(join(fixture.mockBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_CALLS"
`);
    await writeExecutable(join(fixture.mockBin, 'wget'), `#!/bin/sh
printf 'wget\\n' >> "$MOCK_CALLS"
exit 99
`);

    const result = runLauncher(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.callsFile, 'utf8'), 'enable --now ddns-monitor\n');
    assert.equal(await readFile(cachedUserData, 'utf8'), 'host-owned user data');
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.perBootPath), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('startup retries transient downloads and removes the payload after success', async () => {
  const fixture = await createLauncherFixture();
  try {
    await mkdir(fixture.stateDir, { recursive: true });
    await writeFile(join(fixture.stateDir, 'complete'), '0\nstale-attempt\n');
    await writeExecutable(join(fixture.mockBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fixture.mockBin, 'curl'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(join(fixture.mockBin, 'wget'), `#!/bin/sh
count=0
[ ! -f "$MOCK_WGET_COUNT" ] || count=$(cat "$MOCK_WGET_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOCK_WGET_COUNT"
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-O' ]; then output="$2"; shift 2; else shift; fi
done
[ "$count" -ge 3 ] || exit 1
printf '#!/bin/bash\\nexit 0\\n' > "$output"
`);

    const result = runLauncher(fixture, { MOCK_WGET_COUNT: fixture.countFile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.countFile, 'utf8'), '3\n');
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.perBootPath), { code: 'ENOENT' });
    assert.match(await readFile(fixture.logFile, 'utf8'), /等待网络和主控下载地址就绪（2\/36）/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed execution persists per-boot and reuses the cached payload without the consumed URL', async () => {
  const fixture = await createLauncherFixture();
  const allowSuccess = join(fixture.root, 'allow-success');
  try {
    await writeExecutable(join(fixture.mockBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fixture.mockBin, 'curl'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(join(fixture.mockBin, 'wget'), `#!/bin/sh
count=0
[ ! -f "$MOCK_WGET_COUNT" ] || count=$(cat "$MOCK_WGET_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOCK_WGET_COUNT"
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-O' ]; then output="$2"; shift 2; else shift; fi
done
printf '#!/bin/bash\\n[ -f "$MOCK_ALLOW_SUCCESS" ] || exit 23\\nexit 0\\n' > "$output"
`);

    const environment = { MOCK_WGET_COUNT: fixture.countFile, MOCK_ALLOW_SUCCESS: allowSuccess };
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

async function createLauncherFixture() {
  const nodeId = '11111111-2222-4333-8444-555555555555';
  const root = await mkdtemp(join(tmpdir(), 'pulsedns-launcher-'));
  const mockBin = join(root, 'bin');
  const stateDir = join(root, `pulsedns-bootstrap-${nodeId}`);
  const scriptPath = join(root, `pulsedns_${nodeId}_install.sh`);
  const logFile = join(root, 'launcher.log');
  const callsFile = join(root, 'calls.log');
  const countFile = join(root, 'wget.count');
  const perBootDir = join(root, 'per-boot');
  const cloudInstancesDir = join(root, 'cloud-instances');
  const perBootPath = join(perBootDir, `pulsedns-bootstrap-${nodeId}.sh`);
  const launcherPath = join(root, 'user-data.sh');
  await mkdir(mockBin, { recursive: true });
  await writeFile(callsFile, '');
  await writeExecutable(join(mockBin, 'id'), '#!/bin/sh\nprintf "0\\n"\n');

  const generated = buildNodeStartupLauncher(
    nodeId,
    'https://bootstrap.example.test/api/v1/bootstrap/node/token',
    1,
  );
  const launcher = generated
    .replace(
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `PATH=${mockBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll('/var/log/pulsedns-bootstrap-launcher.log', logFile)
    .replaceAll(`/root/pulsedns_${nodeId}_install.sh`, scriptPath)
    .replaceAll(`/var/lib/pulsedns-bootstrap-${nodeId}`, stateDir)
    .replaceAll('/var/lib/cloud/scripts/per-boot', perBootDir)
    .replaceAll('/var/lib/cloud/instances', cloudInstancesDir);
  await writeExecutable(launcherPath, launcher);

  return { root, mockBin, stateDir, scriptPath, logFile, callsFile, countFile, perBootPath, cloudInstancesDir, launcherPath, launcher };
}

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function runLauncher(fixture, extraEnvironment = {}, launcherPath = fixture.launcherPath) {
  const shell = existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';
  return spawnSync(shell, [launcherPath], {
    encoding: 'utf8',
    env: { ...process.env, MOCK_CALLS: fixture.callsFile, ...extraEnvironment },
  });
}
