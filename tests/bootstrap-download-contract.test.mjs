import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';

register('./path-alias-loader.mjs', import.meta.url);

const [nodeRoute, downloadRoute, provisionRoute, proxy, dashboard] = await Promise.all([
  readFile(new URL('../app/api/admin/nodes/route.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app/api/v1/bootstrap/[nodeId]/[token]/route.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app/api/v1/provision/route.ts', import.meta.url), 'utf8'),
  readFile(new URL('../proxy.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8'),
]);

const { encryptBootstrapPayload, decryptBootstrapPayload } = await import('../lib/bootstrap-payload.ts');
const { DEFAULT_NYANPASS_RELEASE, validateTrustedNyanpassRelease } = await import('../lib/nyanpass-release.ts');

function handler(source, method, nextMethod) {
  source = source.replace(/\r\n?/g, '\n');
  const start = source.indexOf(`export async function ${method}`);
  const end = nextMethod ? source.indexOf(`export async function ${nextMethod}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${method} handler missing`);
  return source.slice(start, end);
}

test('node creation returns both a download-run command and a boot-resilient launcher', () => {
  const post = handler(nodeRoute, 'POST', 'PATCH');
  const successStart = post.indexOf('return Response.json({\n    node:');
  assert.ok(successStart >= 0, 'successful node response missing');
  const successResponse = post.slice(successStart, post.indexOf('\nasync function installationCommands'));

  assert.match(post, /const downloadToken = newBootstrapDownloadToken\(\)/);
  assert.match(post, /encryptBootstrapPayload\([\s\S]*agentToken: token[\s\S]*downloadToken[\s\S]*rootPassword[\s\S]*instances/);
  assert.match(post, /sha256\(downloadToken\)/);
  assert.match(post, /bootstrapPayloadCiphertext, bootstrapDownloadTokenHash/);
  assert.doesNotMatch(post, /db\.insert\(nodes\)\.values\(\{[^}]*bootstrapDownloadExpiresAt/);
  assert.match(post, /expiresAt: null/);
  assert.match(post, /const installUrl = `\$\{origin\}\/api\/v1\/bootstrap\/\$\{id\}\/\$\{downloadToken\}`/);
  assert.match(post, /const bootstrapConfig = buildNodeBootstrapConfig\(\{/);
  assert.match(post, /TextEncoder\(\)\.encode\(bootstrapConfig\)\.byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES/);
  assert.match(post, /const connectCommand = buildNodeConnectCommand\(installUrl, bbrProfile\)/);
  assert.match(post, /const startupScript = buildNodeStartupLauncher\(id, installUrl, provisionGeneration, bbrProfile\)/);
  assert.match(post, /if \(!isBbrProfile\(bbrProfile\)\)/);
  assert.match(post, /encryptBootstrapPayload\([\s\S]*bbrProfile,[\s\S]*instances/);
  assert.match(post, /domainUsableBy\(db, user\.id, domainName\)/);
  assert.match(successResponse, /\n\s*installUrl,/);
  assert.match(successResponse, /\n\s*connectCommand,/);
  assert.match(successResponse, /\n\s*startupScript,/);
  assert.doesNotMatch(successResponse, /\n\s*token\s*[,}:]/);
  assert.doesNotMatch(successResponse, /\n\s*installCommand\s*[,}:]/);
  assert.match(successResponse, /Cache-Control': 'no-store'/);
});

test('bootstrap GET authenticates and renders configuration data on every reuse, including ready nodes', () => {
  assert.match(downloadRoute, /\^pbs_\[a-f0-9\]\{64\}\$/);
  assert.match(downloadRoute, /const tokenHash = await sha256\(token\)/);
  assert.match(downloadRoute, /eq\(nodes\.id, nodeId\)[\s\S]*eq\(nodes\.bootstrapDownloadTokenHash, tokenHash\)/);
  assert.match(downloadRoute, /acquireNodeOperationLock\(db, nodeId\)/);
  assert.match(downloadRoute, /finally \{[\s\S]*releaseNodeOperationLock\(db, nodeId, operationId\)/);
  assert.match(downloadRoute, /new Set\(\['awaiting', 'provisioning', 'failed', 'uncertain', 'ready'\]\)/);

  const decryptAt = downloadRoute.indexOf('decryptBootstrapPayload(');
  const renderAt = downloadRoute.indexOf('buildNodeBootstrapConfig({');
  assert.ok(decryptAt >= 0 && renderAt > decryptAt, 'the configuration builder must render the validated encrypted payload');
  assert.match(downloadRoute.slice(renderAt), /generation: node\.generation[\s\S]*token: payload\.agentToken[\s\S]*rootPassword: payload\.rootPassword[\s\S]*instances: payload\.instances[\s\S]*nyanpassRelease/);
  assert.match(downloadRoute, /TextEncoder\(\)\.encode\(config\)\.byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES/);
  // Spot 替换后的新机器复用同一份 User data，因此下载凭据既不过期也不被消费。
  assert.doesNotMatch(downloadRoute, /bootstrapDownloadConsumedAt|bootstrapDownloadExpiresAt/);
  assert.doesNotMatch(downloadRoute, /bootstrapDownloadTokenHash: null/);

  assert.match(downloadRoute, /'Cache-Control': 'no-store, private, max-age=0'/);
  assert.match(downloadRoute, /Pragma: 'no-cache'/);
  assert.match(downloadRoute, /'Referrer-Policy': 'no-referrer'/);
  assert.match(downloadRoute, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(downloadRoute, /'Content-Type': 'application\/octet-stream'/);
  assert.match(downloadRoute, /Content-Disposition[\s\S]*pulsedns-\$\{node\.id\}\.config/);
  assert.doesNotMatch(downloadRoute, /buildNodeStartupScript|text\/x-shellscript|\.id\}\.sh/);

  assert.doesNotMatch(downloadRoute, /bootstrapPayloadCiphertext:\s*null/);
});

test('dynamic Nyanpass trust manifests stay on the official HTTPS origin with pinned digests', () => {
  assert.doesNotThrow(() => validateTrustedNyanpassRelease(DEFAULT_NYANPASS_RELEASE));
  assert.throws(() => validateTrustedNyanpassRelease({ ...DEFAULT_NYANPASS_RELEASE, installerUrl: 'https://example.test/install.sh' }), /trusted dl\.nyafw\.com/);
  assert.throws(() => validateTrustedNyanpassRelease({ ...DEFAULT_NYANPASS_RELEASE, binaryArm64Sha256: 'not-a-hash' }), /SHA-256/);
});

test('provision outcomes keep the encrypted bootstrap secrets for spot replacement reinstalls', () => {
  const finishAt = provisionRoute.indexOf('async function finishProvision');
  assert.ok(finishAt >= 0, 'finishProvision missing');
  const finish = provisionRoute.slice(finishAt);
  assert.doesNotMatch(finish, /bootstrapPayloadCiphertext:\s*null/);
  assert.doesNotMatch(finish, /bootstrapDownloadTokenHash:\s*null/);
  assert.match(finish, /const targetStatus = outcome === 'succeeded' \? 'ready' : 'failed'/);
  assert.match(provisionRoute, /lastCompletedStep/);
  assert.match(provisionRoute, /provisionLastCompletedStep/);
  assert.match(provisionRoute, /ddns[\s\S]*nyanpass[\s\S]*bbr[\s\S]*ssh/);
});

test('the proxy no longer gates the bootstrap link; it only adds anti-framing headers', () => {
  // 开机配置链接由节点专属的 256 位下载凭据保护，面板登录与它无关。
  assert.doesNotMatch(proxy, /bootstrap/);
  assert.match(proxy, /X-Frame-Options', 'DENY'/);
  assert.match(proxy, /frame-ancestors 'none'/);
});

test('bootstrap payload encrypts round-trip and binds ciphertext to node plus generation AAD', async () => {
  const previousSelfHosted = process.env.PULSEDNS_SELF_HOSTED;
  const previousKey = process.env.PULSEDNS_TASK_ENCRYPTION_KEY;
  process.env.PULSEDNS_SELF_HOSTED = '1';
  process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'a'.repeat(64);
  const payload = {
    protocol: 1,
    agentToken: `pd_${'b'.repeat(64)}`,
    rootPassword: 'correct-horse-battery-staple',
    instances: [{
      name: 'tenant-a-out',
      optimize: true,
      args: '-o -t abcdefgh-1234 -u https://ny.example.test',
    }],
  };
  const context = { nodeId: '11111111-2222-4333-8444-555555555555', generation: 7 };

  try {
    const ciphertext = await encryptBootstrapPayload(payload, context);
    assert.match(ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(ciphertext.includes(payload.agentToken), false);
    assert.equal(ciphertext.includes(payload.rootPassword), false);
    assert.deepEqual(await decryptBootstrapPayload(ciphertext, context), payload);
    await assert.rejects(
      decryptBootstrapPayload(ciphertext, { ...context, nodeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
      (error) => error instanceof Error && error.name === 'OperationError',
    );
    await assert.rejects(
      decryptBootstrapPayload(ciphertext, { ...context, generation: context.generation + 1 }),
      (error) => error instanceof Error && error.name === 'OperationError',
    );
  } finally {
    restoreEnvironment('PULSEDNS_SELF_HOSTED', previousSelfHosted);
    restoreEnvironment('PULSEDNS_TASK_ENCRYPTION_KEY', previousKey);
  }
});

test('node commands remain accessible and present startup and download-run as equal options', () => {
  assert.match(dashboard, /type InstallationCommands = \{[^}]*installUrl: string; connectCommand: string; startupScript: string/);
  assert.doesNotMatch(dashboard, /type CreatedNode = \{[^}]*\btoken: string/);
  assert.doesNotMatch(dashboard, /type CreatedNode = \{[^}]*installCommand: string/);
  assert.doesNotMatch(dashboard, /created\.installUrl/);
  assert.doesNotMatch(dashboard, /created\.installCommand/);
  assert.match(dashboard, /created\.connectCommand/);
  assert.match(dashboard, /created\.startupScript/);
  assert.match(dashboard, /公共安装脚本 \+ 节点专属参数/);
  assert.match(dashboard, /role="tablist" aria-label="安装方式"/);
  assert.match(dashboard, /action: 'installation', id: node.id/);
  assert.match(dashboard, /node.installationAvailable \? '安装命令' : '升级命令'/);
  assert.doesNotMatch(dashboard, /<details className="advanced-install">/);
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
