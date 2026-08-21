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
