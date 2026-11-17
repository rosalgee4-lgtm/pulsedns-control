import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 探针侧的远程升级：只接受固定 commit 的公共安装器并校验 SHA-256，校验通过才在独立 systemd 单元中执行。
const monitor = readFileSync(new URL('../public/monitor.sh', import.meta.url), 'utf8');
const fn = (name) => {
  const match = monitor.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(match, name);
  return match[0];
};
const constant = (name) => {
  const match = monitor.match(new RegExp(`^${name}=.*$`, 'm'));
  assert.ok(match, name);
  return match[0];
};

const installer = '#!/usr/bin/env bash\n# PulseDNS / 原 DDNS 脚本兼容安装器\necho upgraded\n';
const installerSha = createHash('sha256').update(installer).digest('hex');
const goodUrl = `https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/${'a'.repeat(40)}/public/install.sh`;
const upgradeId = '11111111-2222-4333-8444-555555555555';
const job = (payload) => JSON.stringify({ status: 'job', protocol: 1, job: { id: upgradeId, action: 'agent_upgrade_v1', payload } });

function run(response, scenario = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'pulsedns-upgrade-'));
  const calls = join(root, 'calls');
  const write = (name, body) => writeFileSync(join(root, name), body, { mode: 0o700 });
  // curl：带 -o 时模拟下载，否则记录失败回执的请求体。
  write('curl', `#!/bin/bash
out=""; data=""
while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -d) data="$2"; shift 2 ;; *) shift ;; esac; done
if [[ -n "$out" ]]; then
  [[ "$SCENARIO" == download-fails ]] && exit 22
  if [[ "$SCENARIO" == tampered ]]; then printf 'tampered\\n' > "$out"; else printf '%s' "$INSTALLER" > "$out"; fi
  exit 0
fi
printf 'POST %s\\n' "$data" >> "$CALLS"
`);
  write('sha256sum', '#!/bin/bash\nshasum -a 256 "$@"\n');
  write('systemd-run', '#!/bin/bash\nprintf "systemd-run %s\\n" "$*" >> "$CALLS"\n[[ "$SCENARIO" != launch-fails ]]\n');
  const script = [
    'set -euo pipefail',
    'VERSION="0.9.0"; SERVER_URL="https://panel.test"; TOKEN="pd_token"',
    `AGENT_UPGRADE_DIR="${join(root, 'agent-upgrade')}"`,
    constant('EXPECTED_PROBE_INSTALLER_URL_RE'),
    'log() { printf "%s %s\\n" "$1" "$2" >> "$CALLS"; }',
    fn('valid_task_uuid'), fn('report_agent_upgrade_failure'), fn('run_agent_upgrade_job'),
    'run_agent_upgrade_job "$RESPONSE"',
  ].join('\n');
  const result = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS: calls, SCENARIO: scenario, INSTALLER: installer, RESPONSE: response },
  });
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  const downloaded = existsSync(join(root, 'agent-upgrade/install.sh'));
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return { log, downloaded };
}

test('a valid upgrade job verifies the pinned installer and runs it in its own systemd unit', () => {
  const { log, downloaded } = run(job({ installerUrl: goodUrl, installerSha256: installerSha, version: '9.9.9' }));
  assert.match(log, /^systemd-run --unit=pulsedns-agent-upgrade-11111111 --collect --quiet \/bin\/bash \S+\/agent-upgrade\/install\.sh agent-upgrade$/m);
  assert.match(log, /开始把探针从 v0\.9\.0 升级到 v9\.9\.9/);
  assert.doesNotMatch(log, /^POST /m);
  assert.equal(downloaded, true);
});

test('jobs pointing anywhere but a pinned commit of this repository are rejected and reported', () => {
  for (const installerUrl of [
    'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/main/public/install.sh',
    `https://raw.githubusercontent.com/someone-else/pulsedns-control/${'a'.repeat(40)}/public/install.sh`,
    `https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/${'a'.repeat(40)}/public/update.sh`,
    `http://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/${'a'.repeat(40)}/public/install.sh`,
  ]) {
    const { log, downloaded } = run(job({ installerUrl, installerSha256: installerSha, version: '9.9.9' }));
    assert.match(log, /POST \{"upgradeId":"11111111-2222-4333-8444-555555555555","outcome":"failed","errorCode":"validation_failed"\}/, installerUrl);
    assert.doesNotMatch(log, /systemd-run/);
    assert.equal(downloaded, false);
  }
});

test('a tampered or failed download never runs, and unexpected job shapes are ignored', () => {
  const tampered = run(job({ installerUrl: goodUrl, installerSha256: installerSha, version: '9.9.9' }), 'tampered');
  assert.match(tampered.log, /"errorCode":"installer_invalid"/);
  assert.doesNotMatch(tampered.log, /systemd-run/);
  assert.equal(tampered.downloaded, false, 'the rejected download is removed');

  const failed = run(job({ installerUrl: goodUrl, installerSha256: installerSha, version: '9.9.9' }), 'download-fails');
  assert.match(failed.log, /"errorCode":"installer_download"/);
  assert.doesNotMatch(failed.log, /systemd-run/);

  const launch = run(job({ installerUrl: goodUrl, installerSha256: installerSha, version: '9.9.9' }), 'launch-fails');
  assert.match(launch.log, /"errorCode":"launch_failed"/);

  const extra = run(job({ installerUrl: goodUrl, installerSha256: installerSha, version: '9.9.9', command: 'rm -rf /' }));
  assert.doesNotMatch(extra.log, /systemd-run|POST/);
  assert.match(extra.log, /格式无效/);
});
