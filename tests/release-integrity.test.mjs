import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('release version agrees across runtime entrypoints', () => {
  const version = JSON.parse(text('package.json')).version;
  assert.equal(version, '0.8.2');
  for (const name of ['public/install.sh', 'public/monitor.sh', 'public/panel-install.sh']) {
    assert.equal(capture(name, /^VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m), version);
  }
  assert.match(text('app/dashboard.tsx'), new RegExp(`v${version.replaceAll('.', '\\.')}`));
});

test('download URLs pin actual Git objects, not movable release branches', () => {
  const downloads = [
    ['lib/install-command.ts', /PROBE_INSTALLER_URL = '([^']+)'/, 'public/install.sh'],
    ['public/install.sh', /^MONITOR_DOWNLOAD_URL="([^"]+)"$/m, 'public/monitor.sh'],
    ['public/update.sh', /^MONITOR_DOWNLOAD_URL="([^"]+)"$/m, 'public/monitor.sh'],
  ];
  for (const [name, pattern, path] of downloads) {
    const url = capture(name, pattern);
    const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/rosalgee4-lgtm\/pulsedns-control\/([a-f0-9]{40})\/(public\/[a-z-]+\.sh)$/);
    assert.ok(match, `${name}: mutable or untrusted download URL`);
    assert.equal(match[2], path);
    const published = execFileSync('git', ['show', `${match[1]}:${path}`], { cwd: new URL('..', import.meta.url) });
    assert.equal(createHash('sha256').update(published).digest('hex'), digest(path), `${url}: pinned commit has different bytes`);
  }
});

test('documented downloads and deployed panel source use matching immutable payloads', () => {
  const urls = [...text('README.md').matchAll(/https:\/\/raw\.githubusercontent\.com\/rosalgee4-lgtm\/pulsedns-control\/([^/\s]+)\/(public\/(?:panel-install|install|update)\.sh)/g)];
  assert.ok(urls.length >= 5);
  for (const [, commit, path] of urls) {
    assert.match(commit, /^[a-f0-9]{40}$/);
    const published = execFileSync('git', ['show', `${commit}:${path}`], { cwd: new URL('..', import.meta.url) });
    assert.equal(createHash('sha256').update(published).digest('hex'), digest(path), `${commit}:${path} differs from documented checksum`);
  }
  const sourceCommit = capture('public/panel-install.sh', /^SOURCE_COMMIT="([a-f0-9]{40})"$/m);
  const deployed = execFileSync('git', ['show', `${sourceCommit}:lib/install-command.ts`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(deployed, text('lib/install-command.ts'), 'panel installer would deploy stale probe download URLs');
});

test('self-hosted build is independent of Google Fonts and panel source checks the launcher', () => {
  assert.doesNotMatch(text('app/layout.tsx'), /next\/font\/google/);
  assert.match(text('public/panel-install.sh'), /lib\/startup-launcher\.ts/);
  assert.match(text('public/panel-install.sh'), /lib\/install-command\.ts/);
  assert.match(text('public/panel-install.sh'), /app\/api\/admin\/nodes\/route\.ts/);
  assert.match(text('public/panel-install.sh'), /grep -Fq 'startupScript'/);
  assert.match(text('public/panel-install.sh'), /grep -Fq 'connectCommand'/);
  assert.match(text('public/panel-install.sh'), /grep -Fq 'buildNodeBootstrapConfig'/);
  assert.match(text('public/panel-install.sh'), /application\/octet-stream/);
  assert.match(text('public/panel-install.sh'), /"\$ACTION" == "probe"/);
  assert.match(text('public/panel-install.sh'), /^SOURCE_COMMIT="[a-f0-9]{40}"$/m);
});
