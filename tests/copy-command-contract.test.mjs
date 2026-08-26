import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

test('generated cloud startup launcher follows the proven wget chmod bash sequence', (context) => {
  const launcher = buildNodeStartupLauncher(
    '11111111-2222-4333-8444-555555555555',
    'http://203.0.113.9:39900/0123456789abcdef0123456789abcdef/api/v1/bootstrap/11111111-2222-4333-8444-555555555555/pbs_abc123',
  );
  assert.match(launcher, /^#!\/bin\/bash\numask 077\n/);
  assert.match(launcher, /pulsedns-bootstrap-launcher\.log/);
  assert.match(launcher, /command -v wget/);
  assert.match(launcher, /apt-get[\s\S]*dnf[\s\S]*yum[\s\S]*apk/);
  assert.match(launcher, /wget ca-certificates/);
  assert.doesNotMatch(launcher, /\bcurl\b/);
  assert.match(launcher, /wget -O '([^']+)' '[^']+' && chmod \+x '\1' && bash '\1'$/);
  assert.ok(Buffer.byteLength(launcher) < 15 * 1024);
  const bash = process.env.BASH_EXE || 'bash';
  const result = spawnSync(bash, ['-n'], { input: launcher, encoding: 'utf8' });
  if (result.error) context.skip(`Bash unavailable: ${result.error.message}`);
  else assert.equal(result.status, 0, result.stderr);
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
