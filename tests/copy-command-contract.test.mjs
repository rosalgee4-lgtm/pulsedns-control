import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.match(dashboard, /节点专属[^。；<]{0,80}下载直链/);
  assert.match(dashboard, /直链只显示一次/);
  assert.match(dashboard, /复制[^<]{0,20}下载直链/);
  assert.match(dashboard, /created\.installUrl/);
  assert.doesNotMatch(dashboard, /created\.installCommand/);
  assert.match(dashboard, /created\.startupScript/);
  assert.match(dashboard, /复制开机脚本/);
  assert.match(dashboard, /复制下载直链/);
  assert.match(dashboard, /setCopyFeedback\(await copyText\(command\) \? 'success' : 'error'\)/);
  assert.match(dashboard, /setStartupCopyFeedback\(await copyText\(script\) \? 'success' : 'error'\)/);
  assert.match(dashboard, /(?:复制成功|下载直链已复制)[\s\S]{0,80}云厂商/);
  assert.match(dashboard, /剪贴板内容没有更新|手动选中[^。]{0,30}链接复制/);
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
  assert.match(launcher, /\[ "\$stored_generation" = "\$expected_generation" \]/);
  const completeCheck = launcher.indexOf('if complete_matches_generation; then');
  const packageCheck = launcher.indexOf('if ! bootstrap_ready; then');
  const downloadCheck = launcher.indexOf('while [ "$attempt" -le 36 ]');
  assert.ok(completeCheck >= 0 && completeCheck < packageCheck && packageCheck < downloadCheck);
  assert.ok(Buffer.byteLength(launcher) < 15 * 1024);
  const result = spawnSync('/bin/sh', ['-n'], { input: launcher, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('completed startup skips the revoked URL and restores the existing service', async () => {
  const fixture = await createLauncherFixture();
  try {
    await mkdir(fixture.stateDir, { recursive: true });
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
    await assert.rejects(readFile(fixture.scriptPath), { code: 'ENOENT' });
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
    assert.match(await readFile(fixture.logFile, 'utf8'), /等待网络和主控下载地址就绪（2\/36）/);
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

    assert.equal(await copyText('full provision command'), true);
    assert.equal(copiedValue, 'full provision command');
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
    .replaceAll(`/var/lib/pulsedns-bootstrap-${nodeId}`, stateDir);

  return { root, mockBin, stateDir, scriptPath, logFile, callsFile, countFile, launcher };
}

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function runLauncher(fixture, extraEnvironment = {}) {
  return spawnSync('/bin/sh', ['-s'], {
    input: fixture.launcher,
    encoding: 'utf8',
    env: { ...process.env, MOCK_CALLS: fixture.callsFile, ...extraEnvironment },
  });
}
