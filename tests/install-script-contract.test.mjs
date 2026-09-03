import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('probe action downloads bounded configuration and runs the fixed installer state machine', () => {
  const bootstrap = body('bootstrap_node');
  const config = body('load_bootstrap_config');
  const installer = body('valid_probe_installer');
  assert.match(source, /if \[\[ "\$ACTION" == "probe" \|\| "\$ACTION" == "bootstrap" \]\]; then[\s\S]*\[\[ \$# -eq 1 \]\][\s\S]*bootstrap_node "\$1"/);
  assert.match(bootstrap, /\/api\/v1\/bootstrap\/[\s\S]*pbs_\[a-f0-9\]/);
  assert.match(bootstrap, /\/root\/pulsedns_\$\{BOOTSTRAP_NODE_ID\}_bootstrap\.config/);
  assert.match(bootstrap, /\/root\/pulsedns_\$\{BOOTSTRAP_NODE_ID\}_installer\.sh/);
  assert.match(bootstrap, /if valid_bootstrap_config "\$BOOTSTRAP_CONFIG_PATH" "\$BOOTSTRAP_NODE_ID"; then/);
  assert.match(bootstrap, /for attempt in \{1\.\.12\}/);
  assert.match(bootstrap, /curl "\$\{protocol_args\[@\]\}"[\s\S]*-fLSs "\$bootstrap_url" -o "\$BOOTSTRAP_TMP"/);
  assert.match(bootstrap, /prepare_probe_installer_cache[\s\S]*run_probe_bootstrap/);
  assert.match(bootstrap, /开始执行 PulseDNS 探针对接/);
  assert.doesNotMatch(bootstrap, /\beval\b/);
  assert.match(config, /stat -c '%a:%u'[\s\S]*"600:0"/);
  assert.match(config, /65536/);
  assert.match(config, /while IFS= read -r -d '' value/);
  assert.match(config, /PULSEDNS_BOOTSTRAP_V1/);
  assert.match(config, /EXPECTED_PROBE_INSTALLER_URL/);
  assert.match(config, /expected=\$\(\(16 \+ 10#\$count \* 3\)\)/);
  assert.match(installer, /262144/);
  assert.match(installer, /grep -Fq '# PulseDNS \/ 原 DDNS 脚本兼容安装器'/);
  assert.match(installer, /bash -n "\$candidate"/);
  assert.match(installer, /sha256sum "\$candidate"/);
});

test('fixed installer owns bootstrap lifecycle, durable outcomes, and process-group cleanup', () => {
  const bootstrap = body('bootstrap_node');
  const lifecycle = body('run_probe_bootstrap');
  assert.ok(bootstrap.indexOf('umask 077') < bootstrap.indexOf('valid_bootstrap_config'));
  assert.ok(bootstrap.indexOf('ensure_probe_bootstrap_environment') < bootstrap.indexOf('valid_bootstrap_config'));
  assert.match(lifecycle, /chmod 0600 "\$BOOTSTRAP_LOG_FILE"[\s\S]*tee -a "\$BOOTSTRAP_LOG_FILE"/);
  assert.match(source, /exec 9>"\$BOOTSTRAP_LOCK_FILE"[\s\S]*flock -n 9/);
  assert.match(lifecycle, /bootstrap_heartbeat_loop "\$\$"/);
  assert.match(lifecycle, /PULSEDNS_PROVISION_STAGE_FILE="\$BOOTSTRAP_STAGE_FILE"[\s\S]*setsid bash "\$BOOTSTRAP_INSTALLER_PATH" provision --provision-config "\$BOOTSTRAP_RUN_CONFIG" --bbr '1'/);
  assert.ok(lifecycle.indexOf('report_bootstrap_message start') < lifecycle.indexOf('mv -f -- "$BOOTSTRAP_ATTEMPT_FILE" "$BOOTSTRAP_STARTED_FILE"'));
  assert.ok(lifecycle.indexOf('mv -f -- "$BOOTSTRAP_ATTEMPT_FILE" "$BOOTSTRAP_STARTED_FILE"') < lifecycle.indexOf('setsid bash "$BOOTSTRAP_INSTALLER_PATH" provision'));
  assert.ok(lifecycle.indexOf('setsid bash "$BOOTSTRAP_INSTALLER_PATH" provision') < lifecycle.indexOf('mv -f -- "$BOOTSTRAP_STARTED_FILE" "$BOOTSTRAP_COMPLETE_FILE"'));
  assert.match(source, /persist_bootstrap_outcome failed/);
  assert.match(source, /\/var\/lib\/ddns-monitor\/provision-outcomes/);
  assert.match(source, /"lastCompletedStep":"%s"/);
  assert.match(source, /stop_bootstrap_process_group\(\)[\s\S]*kill -s "\$signal" -- "-\$BOOTSTRAP_PROVISION_PID"/);
  assert.match(source, /bootstrap_on_exit\(\)[\s\S]*persist_bootstrap_outcome "\$terminal_outcome"/);
  assert.match(source, /remove_completed_bootstrap_cache\(\)[\s\S]*BOOTSTRAP_CONFIG_PATH[\s\S]*BOOTSTRAP_INSTALLER_PATH/);
  assert.match(lifecycle, /上次安装在中途停止/);
  assert.match(lifecycle, /不要删除 started 标记/);
});

test('Bash 3 parser reads the config protocol exactly and rejects trailing bytes', async (context) => {
  const bash = process.env.BASH_EXE || 'bash';
  if (spawnSync(bash, ['--version'], { encoding: 'utf8' }).error) {
    context.skip('Bash unavailable');
    return;
  }
  const nodeId = '11111111-2222-4333-8444-555555555555';
  const root = await mkdtemp(join(tmpdir(), 'pulsedns-config-'));
  const validPath = join(root, 'valid.config');
  const invalidPath = join(root, 'invalid.config');
  const fields = [
    'PULSEDNS_BOOTSTRAP_V1', nodeId, '3',
    'https://master.example.test', 'pd_token_value', 'password with spaces',
    'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/install.sh',
    'a'.repeat(64), 'https://dl.nyafw.com/download/nyanpass-install.sh', 'b'.repeat(64),
    'https://dl.nyafw.com/download/zf-contract', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), '2',
    'tenant-in', '0', '-t inbound-token -u https://ny.example.test',
    'tenant-out', '1', '-o -t outbound-token -u https://ny.example.test --ws-port 1145',
  ];
  try {
    const payload = Buffer.from(`${fields.join('\0')}\0`);
    await writeFile(validPath, payload);
    await writeFile(invalidPath, Buffer.concat([payload, Buffer.from('trailing-data')]));
    await chmod(validPath, 0o600);
    await chmod(invalidPath, 0o600);
    const actionOffset = source.indexOf('\nACTION="${1:-menu}"');
    const harness = `${source.slice(0, actionOffset)}
stat() { printf '600:0\\n'; }
validate_provision_request() { :; }
valid_bootstrap_config "$1" '${nodeId}' || exit 23
printf '%s|%s|%s|%s\\n' "$BOOTSTRAP_NODE_ID" "$BOOTSTRAP_GENERATION" "$ROOT_PASSWORD" "\${#NYANPASS_BATCH_NAMES[@]}"
printf '%s|%s|%s\\n' "\${NYANPASS_BATCH_NAMES[1]}" "\${NYANPASS_BATCH_OPTIMIZES[1]}" "\${NYANPASS_BATCH_INPUTS[1]}"
valid_bootstrap_config "$2" '${nodeId}' && exit 24
exit 0
`;
    const result = spawnSync(bash, ['-s', '--', validPath, invalidPath], { input: harness, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${nodeId}|3|password with spaces|2\ntenant-out|1|-o -t outbound-token -u https://ny.example.test --ws-port 1145\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.match(panelSource, /buildNodeBootstrapConfig/);
  assert.match(panelSource, /application\/octet-stream/);
  assert.match(panelSource, /public\/install\.sh/);
  assert.match(panelSource, /"\$ACTION" == "probe"/);
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
