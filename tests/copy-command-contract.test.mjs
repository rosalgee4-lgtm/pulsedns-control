import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { copyText } from '../lib/copy-text.ts';

const helper = await readFile(new URL('../lib/copy-text.ts', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');

test('HTTP deployments have a synchronous clipboard fallback', () => {
  assert.match(helper, /window\.isSecureContext/);
  assert.match(helper, /navigator\.clipboard\?\.writeText/);
  assert.match(helper, /document\.createElement\('textarea'\)/);
  assert.match(helper, /document\.execCommand\('copy'\)/);
});

test('copy buttons await the result and expose success or failure', () => {
  assert.match(dashboard, /setCopyFeedback\(await copyText\(command\) \? 'success' : 'error'\)/);
  assert.match(dashboard, /复制成功，请直接粘贴到云厂商开机脚本/);
  assert.match(dashboard, /剪贴板内容没有更新/);
  assert.doesNotMatch(dashboard, /onClick=\{\(\) => navigator\.clipboard\.writeText/);
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
