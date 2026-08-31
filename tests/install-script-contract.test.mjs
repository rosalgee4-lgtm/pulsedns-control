import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('boot-time dependency installation retries package locks and network startup', () => {
  const packages = body('install_packages_with_retry');
  const dependencies = body('install_deps');
  assert.match(packages, /for attempt in \{1\.\.24\}/);
  assert.match(packages, /apt-get[\s\S]*dnf[\s\S]*yum[\s\S]*apk/);
  assert.match(packages, /等待包管理器或网络/);
  assert.match(dependencies, /install_packages_with_retry "\$\{missing\[@\]\}"/);
  assert.match(dependencies, /运行依赖安装后仍不完整/);
});

test('compact bootstrap action validates one node parameter, caches it, and reports progress', () => {
  const bootstrap = body('bootstrap_node');
  const validation = body('valid_node_bootstrap_script');
  assert.match(source, /if \[\[ "\$ACTION" == "bootstrap" \]\]; then[\s\S]*\[\[ \$# -eq 1 \]\][\s\S]*bootstrap_node "\$1"/);
  assert.match(bootstrap, /\/api\/v1\/bootstrap\/[\s\S]*pbs_\[a-f0-9\]/);
  assert.match(bootstrap, /\/root\/pulsedns_\$\{node_id\}_install\.sh/);
  assert.match(bootstrap, /if valid_node_bootstrap_script "\$cache_path" "\$node_id"; then/);
  assert.match(bootstrap, /for attempt in \{1\.\.12\}/);
  assert.match(bootstrap, /curl "\$\{protocol_args\[@\]\}"[\s\S]*-fLSs "\$bootstrap_url" -o "\$BOOTSTRAP_TMP"/);
  assert.match(bootstrap, /开始执行 PulseDNS 节点安装/);
  assert.ok(bootstrap.indexOf('bash "$cache_path"') < bootstrap.lastIndexOf('rm -f -- "$cache_path"'));
  assert.match(bootstrap, /安装未完成，已保留缓存/);
  assert.doesNotMatch(bootstrap, /\beval\b/);
  assert.match(validation, /65536/);
  assert.match(validation, /grep -Fq "pulsedns-bootstrap-\$\{node_id\}"/);
  assert.match(validation, /bash -n "\$candidate"/);
});

test('Nyanpass parser only classifies independent -o and preserves safe official extras', (context) => {
  const bash = process.env.BASH_EXE || 'bash';
  if (spawnSync(bash, ['--version'], { encoding: 'utf8' }).error) {
    context.skip('Bash unavailable');
    return;
  }
  const actionOffset = source.indexOf('\nACTION="${1:-menu}"');
  assert.ok(actionOffset > 0, 'installer action dispatcher missing');
  const harness = `${source.slice(0, actionOffset)}
parse_nyanpass_input "$1" || exit 23
printf '%s\\n%s\\n' "$PARSED_NYANPASS_ROLE" "$PARSED_NYANPASS_ARGS"
`;
  const command = 'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t 123e4567-e89b-42d3-a456-426614174000 -u https://ny.example.test --ws-port 1145"';
  const accepted = spawnSync(bash, ['-c', harness, 'parser', command], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, '出口\n-o -t 123e4567-e89b-42d3-a456-426614174000 -u https://ny.example.test --ws-port 1145\n');
  const rejected = spawnSync(bash, ['-c', harness, 'parser', '-t abcdefgh -u https://ny.example.test --exec=$(id)'], { encoding: 'utf8' });
  assert.equal(rejected.status, 23);
});

test('probe installation avoids Bash 4-only state and descriptor helpers', () => {
  assert.doesNotMatch(source, /\breadarray\b|\bmapfile\b|exec \{[A-Za-z_][A-Za-z0-9_]*\}>/);
  assert.match(source, /while IFS= read -r -d '' value/);
  assert.match(source, /exec 8>"\$TASK_LOCK_FILE"[\s\S]*flock 8/);
});

test('DDNS installation clears stale IP state and verifies the service', () => {
  const install = body('install_ddns_service');
  assert.ok(install.indexOf('systemctl stop "$SERVICE_NAME"') < install.indexOf('rm -f "$CACHE_V4" "$CACHE_V6" "$REPORT_ACCEPTED_MARK"'));
  assert.ok(install.indexOf('rm -f "$CACHE_V4" "$CACHE_V6" "$REPORT_ACCEPTED_MARK"') < install.indexOf('systemctl restart "$SERVICE_NAME"'));
  assert.ok(install.indexOf('systemctl restart "$SERVICE_NAME"') < install.indexOf('verify_ddns_service'));
  assert.match(install, /for download_attempt in 1 2 3 4 5/);
  assert.match(install, /连续 5 次下载/);
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
  assert.match(verify, /for attempt in \{1\.\.90\}/);
  assert.match(verify, /-s "\$CACHE_V4" \|\| -s "\$CACHE_V6"/);
  assert.match(verify, /-f "\$REPORT_ACCEPTED_MARK"/);
  assert.match(verify, /主控已接受首次地址上报/);
});

test('SSH changes are validated, effective, atomic, and reversible', () => {
  const ssh = body('configure_ssh');
  assert.doesNotMatch(source, /rm\s+-rf\s+\/etc\/ssh\/sshd_config\.d/);
  assert.match(ssh, /BEGIN PulseDNS managed SSH options/);
  assert.match(ssh, /awk -v begin=/);
  assert.match(ssh, /"\$sshd_bin" -t -f "\$candidate_config"/);
  assert.match(ssh, /"\$sshd_bin" -T -f "\$candidate_config" -C user=root/);
  assert.match(ssh, /cp -a -- "\$backup_config" "\$rollback_config"/);
  assert.match(ssh, /systemctl reload "\$ssh_service"/);
  assert.ok(ssh.indexOf('"$sshd_bin" -t -f') < ssh.indexOf('mv -f -- "$candidate_config" "$sshd_config"'));
  assert.ok(ssh.indexOf('mv -f -- "$candidate_config" "$sshd_config"') < ssh.indexOf("printf 'root:%s\\n' \"$root_password\" | chpasswd"));
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

test('Web provision validates first and changes SSH only after external installation steps', () => {
  const provision = body('provision_node');
  const validation = provision.indexOf('validate_provision_request');
  const ssh = provision.indexOf('configure_ssh');
  const ddns = provision.indexOf('install_ddns_service');
  const nyanpass = provision.indexOf('install_nyanpass_batch');
  const bbr = provision.indexOf('configure_bbr');
  const finalVerification = provision.lastIndexOf('verify_ddns_service');
  assert.ok(validation >= 0 && validation < ddns && ddns < nyanpass && nyanpass < bbr && bbr < ssh && ssh < finalVerification);
  assert.match(provision, /\[\[ "\$APPLY_BBR" == "1" \]\] && configure_bbr/);
  assert.match(source, /--bbr\)[\s\S]*APPLY_BBR="\$2"/);
  assert.match(source, /--provision-config\)[\s\S]*load_provision_config "\$2"/);
  assert.match(source, /load_provision_config\(\)[\s\S]*PULSEDNS_PROVISION_V2/);
  assert.match(source, /load_provision_config\(\)[\s\S]*600:0/);
  assert.match(source, /record_provision_stage ddns[\s\S]*record_provision_stage nyanpass[\s\S]*record_provision_stage bbr[\s\S]*record_provision_stage ssh/);
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
  assert.match(panelSource, /lib\/startup-launcher\.ts/);
  assert.match(panelSource, /startupScript/);
  assert.match(panelSource, /lib\/install-command\.ts/);
  assert.match(panelSource, /connectCommand/);
  assert.match(panelSource, /next\/font\/google/);
  assert.match(readme, /panel-install\.sh\?v=0\.8\.2[^\n]+sha256sum[^\n]+grep -Fq[^\n]+bash -n[^\n]+bash "\$tmp" install/);
  assert.match(readme, /panel-install\.sh\?v=0\.8\.2[^\n]+sha256sum[^\n]+grep -Fq[^\n]+bash -n[^\n]+bash "\$tmp" update/);
});

test('Nyanpass installation executes only pinned installer and binary payloads', () => {
  const install = body('install_nyanpass_once');
  const installerDownload = install.indexOf('"$NYANPASS_INSTALL_URL" -o "$installer"');
  const installerDigest = install.indexOf('"$digest" == "$NYANPASS_INSTALL_SHA256"');
  const binaryDownload = install.indexOf('"$NYANPASS_BINARY_URL" -o "$archive"');
  const binaryDigest = install.indexOf('"$archive_digest" == "$NYANPASS_BINARY_SHA256"');
  const stage = install.indexOf('stage_nyanpass_binary');
  const startScript = install.indexOf('write_nyanpass_start_script');
  const execute = install.indexOf('NO_DOWNLOAD=1 timeout --kill-after=30s');
  assert.ok(installerDownload >= 0 && installerDownload < installerDigest);
  assert.ok(installerDigest < binaryDownload && binaryDownload < binaryDigest);
  assert.ok(binaryDigest < stage && stage < startScript && startScript < execute);
  assert.match(install, /OPTIMIZE="\$optimize_env"/);
  assert.match(source, /validate_nyanpass_release_manifest\(\)/);
  assert.match(source, /PULSEDNS_NYANPASS_INSTALLER_SHA256/);
});
