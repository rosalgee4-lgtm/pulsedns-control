import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');

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
  assert.match(source, /^    provision\) provision_node ;;/m);
});
