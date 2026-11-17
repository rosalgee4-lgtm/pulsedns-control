import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Object.fromEntries(await Promise.all([
  'README.md',
  'app/api/admin/nodes/route.ts',
  'app/api/admin/nyanpass/route.ts',
  'app/api/admin/nyanpass/sync/route.ts',
  'app/dashboard.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'lib/bootstrap-payload.ts',
  'lib/install-command.ts',
  'lib/node-response.ts',
  'lib/nyanpass-command.ts',
  'lib/nyanpass-credential.ts',
  'lib/startup-launcher.ts',
  'package.json',
  'pnpm-lock.yaml',
  'public/install.sh',
  'public/monitor.sh',
  'public/og.png',
  'Dockerfile',
  'docker-compose.yml',
  'db/schema.ts',
  'lib/auth.ts',
  'proxy.ts',
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

  assert.equal(capture('public/install.sh', /^MONITOR_SHA256="([a-f0-9]{64})"$/m), monitorHash);
  assert.equal(capture('public/update.sh', /^MONITOR_SHA256="([a-f0-9]{64})"$/m), monitorHash);
  assert.equal(capture('lib/install-command.ts', /PROBE_INSTALLER_SHA256 = '([a-f0-9]{64})'/), installHash);
  for (const hash of [installHash, updateHash]) assert.ok(text('README.md').includes(hash), `README missing ${hash}`);
});

test('release version agrees across runtime entrypoints', () => {
  const version = JSON.parse(text('package.json')).version;
  assert.equal(version, '0.9.0');
  for (const name of ['public/install.sh', 'public/monitor.sh']) {
    assert.equal(capture(name, /^VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m), version);
  }
  assert.match(text('app/dashboard.tsx'), new RegExp(`v${version.replaceAll('.', '\\.')}`));
  // 面板以「探针上报这个版本」判断远程升级完成，必须与固定的安装器版本一致。
  assert.equal(capture('lib/install-command.ts', /PROBE_AGENT_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/), version);
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

test('documented probe downloads and the Docker panel source use matching immutable payloads', () => {
  const urls = [...text('README.md').matchAll(/https:\/\/raw\.githubusercontent\.com\/rosalgee4-lgtm\/pulsedns-control\/([^/\s]+)\/(public\/(?:install|update)\.sh)/g)];
  assert.ok(urls.length >= 2);
  for (const [, commit, path] of urls) {
    assert.match(commit, /^[a-f0-9]{40}$/);
    const published = execFileSync('git', ['show', `${commit}:${path}`], { cwd: new URL('..', import.meta.url) });
    assert.equal(createHash('sha256').update(published).digest('hex'), digest(path), `${commit}:${path} differs from documented checksum`);
  }
  // README 的 Docker 部署按固定 commit 检出源码；该 commit 必须就是当前发布的代码。
  const sourceCommit = capture('README.md', /git -C pulsedns-control checkout --detach ([a-f0-9]{40})/);
  for (const name of ['Dockerfile', 'docker-compose.yml', 'db/schema.ts', 'lib/auth.ts', 'proxy.ts', 'app/api/admin/nodes/route.ts', 'app/api/admin/nyanpass/route.ts', 'app/api/admin/nyanpass/sync/route.ts', 'app/dashboard.tsx', 'app/globals.css', 'lib/bootstrap-payload.ts', 'lib/install-command.ts', 'lib/node-response.ts', 'lib/nyanpass-command.ts', 'lib/nyanpass-credential.ts', 'lib/startup-launcher.ts', 'package.json', 'pnpm-lock.yaml']) {
    const deployed = execFileSync('git', ['show', `${sourceCommit}:${name}`], { cwd: new URL('..', import.meta.url) });
    assert.ok(deployed.equals(files[name]), `Docker deployment would build stale ${name}`);
  }
});

test('the Docker image is built from pinned inputs and runs unprivileged behind a local-only port', () => {
  assert.doesNotMatch(text('app/layout.tsx'), /next\/font\/google/);
  const bases = [...text('Dockerfile').matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.ok(bases.length >= 2);
  for (const base of bases) assert.match(base, /^node:22\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/, 'base images are pinned by digest');
  assert.match(text('Dockerfile'), /corepack prepare pnpm@10\.28\.2 --activate/);
  assert.match(text('Dockerfile'), /pnpm install --frozen-lockfile/);
  assert.match(text('Dockerfile'), /^USER node$/m);
  assert.match(text('docker-compose.yml'), /"127\.0\.0\.1:\$\{PULSEDNS_PANEL_PORT:-3100\}:3100"/);
  assert.match(text('docker-compose.yml'), /no-new-privileges:true/);
  assert.match(text('docker-compose.yml'), /cap_drop:\s*\n\s*- ALL/);
});
