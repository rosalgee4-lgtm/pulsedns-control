import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validIPv4, validIPv6 } from '../lib/validation.ts';

const [installer, monitor] = await Promise.all([
  readFile(new URL('../public/install.sh', import.meta.url), 'utf8'),
  readFile(new URL('../public/monitor.sh', import.meta.url), 'utf8'),
]);

test('TypeScript accepts only complete canonical IP addresses', () => {
  for (const ip of ['0.0.0.0', '1.2.3.4', '255.255.255.255']) assert.equal(validIPv4(ip), true, ip);
  for (const ip of ['01.2.3.4', '256.1.2.3', '1.2.3', ' 1.2.3.4', 'ip=1.2.3.4']) assert.equal(validIPv4(ip), false, ip);

  for (const ip of ['::', '::1', '2001:db8::1', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.128']) {
    assert.equal(validIPv6(ip), true, ip);
  }
  for (const ip of ['1:2', '10:30:45', '12:34:56', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', ':::', ' 2001:db8::1']) {
    assert.equal(validIPv6(ip), false, ip);
  }
});

test('both probe scripts validate the complete provider response with the same functions', (context) => {
  assert.doesNotMatch(installer, /grep -oE[^\n]*(?:[Ii][Pp][Vv]?[46]?|0-9a-fA-F)/);
  assert.doesNotMatch(monitor, /grep -oE[^\n]*(?:[Ii][Pp][Vv]?[46]?|0-9a-fA-F)/);
  assert.match(installer, /ip=\$\(trim_space "\$ip"\)[\s\S]*valid_ipv4 "\$ip"/);
  assert.match(installer, /ip=\$\(trim_space "\$ip"\)[\s\S]*valid_ipv6 "\$ip"/);
  assert.equal(extractFunction(installer, 'valid_ipv4'), extractFunction(monitor, 'valid_ipv4'));
  assert.equal(extractFunction(installer, 'valid_ipv6'), extractFunction(monitor, 'valid_ipv6'));

  const bash = process.env.BASH_EXE || 'bash';
  const script = `${extractFunction(monitor, 'valid_ipv4')}\n${extractFunction(monitor, 'valid_ipv6')}
valid_ipv4 '1.2.3.4'
! valid_ipv4 '01.2.3.4'
! valid_ipv4 '256.1.2.3'
valid_ipv6 '::1'
valid_ipv6 '2001:db8::1'
valid_ipv6 '::ffff:192.0.2.128'
! valid_ipv6 '10:30:45'
! valid_ipv6 '1::2::3'
! valid_ipv6 ':::'
`;
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8' });
  if (result.error) context.skip(`Bash unavailable: ${result.error.message}`);
  else assert.equal(result.status, 0, result.stderr);
});

function extractFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}\\n`, 'm'));
  assert.ok(match, `${name} missing`);
  return `${name}() {\n${match[1]}}`;
}
