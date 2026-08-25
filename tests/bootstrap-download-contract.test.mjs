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

function handler(source, method, nextMethod) {
  const start = source.indexOf(`export async function ${method}`);
  const end = nextMethod ? source.indexOf(`export async function ${nextMethod}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${method} handler missing`);
  return source.slice(start, end);
}

test('node creation returns only an unguessable bootstrap download URL', () => {
  const post = handler(nodeRoute, 'POST', 'PATCH');
  const successStart = post.lastIndexOf('return Response.json({');
  assert.ok(successStart >= 0, 'successful node response missing');
  const successResponse = post.slice(successStart);

  assert.match(post, /const downloadToken = newBootstrapDownloadToken\(\)/);
  assert.match(post, /encryptBootstrapPayload\([\s\S]*agentToken: token[\s\S]*rootPassword[\s\S]*instances/);
  assert.match(post, /sha256\(downloadToken\)/);
  assert.match(post, /bootstrapPayloadCiphertext, bootstrapDownloadTokenHash/);
  assert.match(post, /const installUrl = `\$\{origin\}\/api\/v1\/bootstrap\/\$\{id\}\/\$\{downloadToken\}`/);
  assert.match(successResponse, /\n\s*installUrl,/);
  assert.doesNotMatch(successResponse, /\n\s*token\s*[,}:]/);
  assert.doesNotMatch(successResponse, /\n\s*installCommand\s*[,}:]/);
  assert.match(successResponse, /Cache-Control': 'no-store'/);
});

test('bootstrap GET authenticates the link, serializes generation, and renders the current script without consuming it', () => {
  assert.match(downloadRoute, /\^pbs_\[a-f0-9\]\{64\}\$/);
  assert.match(downloadRoute, /const tokenHash = await sha256\(token\)/);
  assert.match(downloadRoute, /eq\(nodes\.id, nodeId\)[\s\S]*eq\(nodes\.bootstrapDownloadTokenHash, tokenHash\)/);
  assert.match(downloadRoute, /acquireNodeOperationLock\(db, nodeId\)/);
  assert.match(downloadRoute, /finally \{[\s\S]*releaseNodeOperationLock\(db, nodeId, operationId\)/);
  assert.match(downloadRoute, /new Set\(\['awaiting', 'provisioning', 'failed', 'uncertain'\]\)/);

  const decryptAt = downloadRoute.indexOf('decryptBootstrapPayload(');
  const renderAt = downloadRoute.indexOf('buildNodeStartupScript({');
  assert.ok(decryptAt >= 0 && renderAt > decryptAt, 'the latest startup builder must render a validated encrypted payload');
  assert.match(downloadRoute.slice(renderAt), /generation: node\.generation[\s\S]*token: payload\.agentToken[\s\S]*rootPassword: payload\.rootPassword[\s\S]*instances: payload\.instances/);
  assert.match(downloadRoute, /TextEncoder\(\)\.encode\(script\)\.byteLength > MAX_NODE_STARTUP_SCRIPT_BYTES/);

  assert.match(downloadRoute, /'Cache-Control': 'no-store, private, max-age=0'/);
  assert.match(downloadRoute, /Pragma: 'no-cache'/);
  assert.match(downloadRoute, /'Referrer-Policy': 'no-referrer'/);
  assert.match(downloadRoute, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(downloadRoute, /'Content-Type': 'text\/x-shellscript; charset=utf-8'/);
  assert.match(downloadRoute, /Content-Disposition/);

  assert.doesNotMatch(downloadRoute, /db\.(?:update|delete)\(nodes\)/);
  assert.doesNotMatch(downloadRoute, /bootstrapPayloadCiphertext:\s*null|bootstrapDownloadTokenHash:\s*null/);
});

test('only successful provision outcomes revoke both bootstrap secrets, including duplicate success', () => {
  const finishAt = provisionRoute.indexOf('async function finishProvision');
  assert.ok(finishAt >= 0, 'finishProvision missing');
  const finish = provisionRoute.slice(finishAt);
  const duplicateStart = finish.indexOf('if (node.nyanpassStatus === targetStatus)');
  const transitionStart = finish.indexOf('const [transitioned]', duplicateStart);
  assert.ok(duplicateStart >= 0 && transitionStart > duplicateStart, 'duplicate terminal branch missing');
  const duplicateBranch = finish.slice(duplicateStart, transitionStart);
  assert.match(duplicateBranch, /if \(outcome === 'succeeded'\)[\s\S]*db\.update\(nodes\)\.set\(\{[\s\S]*bootstrapPayloadCiphertext:\s*null[\s\S]*bootstrapDownloadTokenHash:\s*null/);

  const transition = finish.slice(transitionStart);
  assert.match(transition, /db\.update\(nodes\)\.set\(\{[\s\S]*\.\.\.\(outcome === 'succeeded' \? \{[\s\S]*bootstrapPayloadCiphertext:\s*null[\s\S]*bootstrapDownloadTokenHash:\s*null[\s\S]*\} : \{\}\)/);

  assert.match(finish, /const targetStatus = outcome === 'succeeded' \? 'ready' : 'failed'/);
});

test('self-hosted auth proxy publishes only the node-specific bootstrap prefix', () => {
  assert.match(proxy, /pathname\.startsWith\('\/api\/v1\/bootstrap\/'\)\) return NextResponse\.next\(\)/);
  assert.doesNotMatch(proxy, /PUBLIC_PATHS[\s\S]*['"]\/api\/v1\/bootstrap['"]/);
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

test('the dashboard keeps the one-time URL contract instead of receiving the full script', () => {
  assert.match(dashboard, /type CreatedNode = \{[^}]*installUrl: string/);
  assert.doesNotMatch(dashboard, /type CreatedNode = \{[^}]*\btoken: string/);
  assert.doesNotMatch(dashboard, /type CreatedNode = \{[^}]*installCommand: string/);
  assert.match(dashboard, /created\.installUrl/);
  assert.doesNotMatch(dashboard, /created\.installCommand/);
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
