import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');
const panelSource = await readFile(new URL('../public/panel-install.sh', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

function body(name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}\\n`, 'm'));
  assert.ok(match, `missing ${name}()`);
  return match[1];
}

test('DDNS installation clears stale IP state and verifies the service', () => {
  const install = body('install_ddns_service');
  assert.ok(install.indexOf('systemctl stop "$SERVICE_NAME"') < install.indexOf('rm -f "$CACHE_V4" "$CACHE_V6"'));
  assert.ok(install.indexOf('rm -f "$CACHE_V4" "$CACHE_V6"') < install.indexOf('systemctl restart "$SERVICE_NAME"'));
  assert.ok(install.indexOf('systemctl restart "$SERVICE_NAME"') < install.indexOf('verify_ddns_service'));
});

test('DDNS verification checks artifacts, enablement, and sustained activity', () => {
  const verify = body('verify_ddns_service');
  for (const required of [
    '[[ -f "$INSTALL_PATH"',
    '[[ -f "$CONFIG_FILE"',
    '[[ -f "$SERVICE_FILE"',
    'grep -Fqx "ExecStart=/bin/bash ${INSTALL_PATH} --run"',
    'systemctl is-enabled --quiet "$SERVICE_NAME"',
    'for attempt in 1 2 3',
    'systemctl is-active --quiet "$SERVICE_NAME"',
  ]) assert.equal(verify.includes(required), true, `missing verification: ${required}`);
  assert.match(verify, /for attempt in \{1\.\.30\}/);
  assert.match(verify, /-s "\$CACHE_V4" \|\| -s "\$CACHE_V6"/);
  assert.match(verify, /主控已接受首次地址上报/);
});

test('installer validates the token with the master before changing the VPS', () => {
  const validate = body('validate_ddns_credentials_remote');
  const provision = body('provision_node');
  assert.match(validate, /\/api\/v1\/report/);
  assert.match(validate, /X-Secret-Token/);
  assert.match(validate, /主控未接受探针令牌/);
  assert.ok(provision.indexOf('install_deps') < provision.indexOf('validate_ddns_credentials_remote'));
  assert.ok(provision.indexOf('validate_ddns_credentials_remote') < provision.indexOf('configure_ssh'));
});

test('systemd start-limit directives are in Unit rather than Service', () => {
  const unit = body('write_ddns_service_unit');
  const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
  const serviceSection = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'));
  assert.match(unitSection, /StartLimitIntervalSec=120/);
  assert.match(unitSection, /StartLimitBurst=5/);
  assert.doesNotMatch(serviceSection, /StartLimit/);
});

test('Web provision validates first and never reaches Nyanpass before DDNS verification', () => {
  const provision = body('provision_node');
  const validation = provision.indexOf('validate_provision_request');
  const ssh = provision.indexOf('configure_ssh');
  const ddns = provision.indexOf('install_ddns_service');
  const nyanpass = provision.indexOf('install_nyanpass_batch');
  const bbr = provision.indexOf('configure_bbr');
  const finalVerification = provision.lastIndexOf('verify_ddns_service');
  assert.ok(validation >= 0 && validation < ssh && ssh < ddns && ddns < nyanpass && nyanpass < bbr && bbr < finalVerification);
  assert.match(provision, /\[\[ "\$APPLY_BBR" == "1" \]\] && configure_bbr/);
  assert.match(source, /--bbr\)[\s\S]*APPLY_BBR="\$2"/);
  assert.match(source, /--provision-config\)[\s\S]*load_provision_config "\$2"/);
  assert.match(source, /load_provision_config\(\)[\s\S]*PULSEDNS_PROVISION_V1/);
  assert.match(source, /load_provision_config\(\)[\s\S]*600:0/);
  assert.match(source, /Web 一键安装必须显式传入原脚本 BBR 参数/);
  assert.match(source, /^    provision\) provision_node ;;/m);
});

test('all 23 original BBR and fq sysctl parameters are preserved', () => {
  const bbr = body('configure_bbr');
  const parameters = [
    'fs.file-max = 6815744',
    'net.ipv4.tcp_no_metrics_save=1',
    'net.ipv4.tcp_ecn=0',
    'net.ipv4.tcp_frto=0',
    'net.ipv4.tcp_mtu_probing=0',
    'net.ipv4.tcp_rfc1337=0',
    'net.ipv4.tcp_sack=1',
    'net.ipv4.tcp_fack=1',
    'net.ipv4.tcp_window_scaling=1',
    'net.ipv4.tcp_adv_win_scale=1',
    'net.ipv4.tcp_moderate_rcvbuf=1',
    'net.core.rmem_max=10000000',
    'net.core.wmem_max=10000000',
    'net.ipv4.tcp_rmem=4096 131072 10000000',
    'net.ipv4.tcp_wmem=4096 131072 10000000',
    'net.ipv4.udp_rmem_min=8192',
    'net.ipv4.udp_wmem_min=8192',
    'net.ipv4.ip_forward=1',
    'net.ipv4.conf.all.route_localnet=1',
    'net.ipv4.conf.all.forwarding=1',
    'net.ipv4.conf.default.forwarding=1',
    'net.core.default_qdisc=fq',
    'net.ipv4.tcp_congestion_control=bbr',
  ];
  assert.equal(parameters.length, 23);
  for (const parameter of parameters) assert.ok(bbr.includes(parameter), `missing original BBR parameter: ${parameter}`);
});

test('DDNS uninstall removes persisted task leases but leaves Nyanpass itself alone', () => {
  const uninstall = body('uninstall_ddns');
  assert.match(uninstall, /rm -rf "\$TASK_STATE_DIR"/);
  assert.doesNotMatch(uninstall, /nyanpass\.uninstall|systemctl.*nyanpass/i);
});

test('panel installer uses immutable source and README verifies the downloaded entrypoint', () => {
  const sourceCommit = panelSource.match(/^SOURCE_COMMIT="([a-f0-9]{40})"$/m)?.[1];
  assert.ok(sourceCommit, 'panel source must be pinned to a full commit');
  assert.match(panelSource, /archive\/\$\{SOURCE_COMMIT\}\.tar\.gz/);
  assert.doesNotMatch(panelSource, /archive\/refs\/heads|SOURCE_REF=/);

  const panelHash = createHash('sha256').update(panelSource).digest('hex');
  assert.equal(readme.includes(panelHash), true, 'README panel command must pin the entrypoint digest');
  assert.match(readme, /panel-install\.sh\?v=0\.8\.0[^\n]+sha256sum[^\n]+grep -Fq[^\n]+bash -n[^\n]+bash "\$tmp" install/);
  assert.match(readme, /panel-install\.sh\?v=0\.8\.0[^\n]+sha256sum[^\n]+grep -Fq[^\n]+bash -n[^\n]+bash "\$tmp" update/);
});
