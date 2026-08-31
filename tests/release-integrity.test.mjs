import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Object.fromEntries(await Promise.all([
  'README.md',
  'app/dashboard.tsx',
  'app/layout.tsx',
  'lib/install-command.ts',
  'package.json',
  'pnpm-lock.yaml',
  'public/install.sh',
  'public/monitor.sh',
  'public/og.png',
  'public/panel-install.sh',
  'public/update.sh',
].map(async (name) => [name, await readFile(new URL(`../${name}`, import.meta.url))])));

const text = (name) => files[name].toString('utf8');
const digest = (name) => createHash('sha256').update(files[name]).digest('hex');
const capture = (name, pattern) => {
  const value = text(name).match(pattern)?.[1];
  assert.ok(value, `${name} is missing ${pattern}`);
  return value;
};

test('release scripts and documentation pin every published SHA-256', () => {
  const monitorHash = digest('public/monitor.sh');
  const installHash = digest('public/install.sh');
  const updateHash = digest('public/update.sh');
  const panelHash = digest('public/panel-install.sh');

  assert.equal(capture('public/install.sh', /^MONITOR_SHA256="([a-f0-9]{64})"$/m), monitorHash);
  assert.equal(capture('public/update.sh', /^MONITOR_SHA256="([a-f0-9]{64})"$/m), monitorHash);
  assert.equal(capture('lib/install-command.ts', /PROBE_INSTALLER_SHA256 = '([a-f0-9]{64})'/), installHash);
  for (const hash of [installHash, updateHash, panelHash]) assert.ok(text('README.md').includes(hash), `README missing ${hash}`);

  assert.equal(capture('public/panel-install.sh', /^SOURCE_LOCK_SHA256="([a-f0-9]{64})"$/m), digest('pnpm-lock.yaml'));
  assert.equal(capture('public/panel-install.sh', /^SOURCE_OG_SHA256="([a-f0-9]{64})"$/m), digest('public/og.png'));
});

test('release version and immutable channel agree across runtime entrypoints', () => {
  const version = JSON.parse(text('package.json')).version;
  assert.equal(version, '0.8.2');
  for (const name of ['public/install.sh', 'public/monitor.sh', 'public/panel-install.sh']) {
    assert.equal(capture(name, /^VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m), version);
  }
  assert.match(text('lib/install-command.ts'), new RegExp(`release-v${version.replaceAll('.', '\\.')}\\/public\\/install\\.sh`));
  assert.match(text('public/install.sh'), new RegExp(`release-v${version.replaceAll('.', '\\.')}\\/public\\/monitor\\.sh`));
  assert.match(text('public/update.sh'), new RegExp(`release-v${version.replaceAll('.', '\\.')}\\/public\\/monitor\\.sh`));
  assert.match(text('app/dashboard.tsx'), new RegExp(`v${version.replaceAll('.', '\\.')}`));
});

test('self-hosted build is independent of Google Fonts and panel source checks the launcher', () => {
  assert.doesNotMatch(text('app/layout.tsx'), /next\/font\/google/);
  assert.match(text('public/panel-install.sh'), /lib\/startup-launcher\.ts/);
  assert.match(text('public/panel-install.sh'), /lib\/install-command\.ts/);
  assert.match(text('public/panel-install.sh'), /app\/api\/admin\/nodes\/route\.ts/);
  assert.match(text('public/panel-install.sh'), /grep -Fq 'startupScript'/);
  assert.match(text('public/panel-install.sh'), /grep -Fq 'connectCommand'/);
  assert.match(text('public/panel-install.sh'), /^SOURCE_COMMIT="[a-f0-9]{40}"$/m);
});
