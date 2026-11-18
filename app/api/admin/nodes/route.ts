import { and, eq, inArray, isNull } from 'drizzle-orm';
import { affectedRows, runInTransaction, type AppDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { agentTasks, events, nodes, nyanpassInstances } from '@/db/schema';
import { requireApiUser, type CurrentUser } from '@/lib/auth';
import { canAccessNode, domainUsableBy } from '@/lib/ownership';
import { syncAliDnsRecord } from '@/lib/alidns';
import { buildNodeBootstrapConfig, buildNodeConnectCommand, DEFAULT_BBR_PROFILE, isBbrProfile, MAX_BOOTSTRAP_RESPONSE_BYTES, MAX_CLOUD_LAUNCHER_BYTES, PROBE_AGENT_VERSION } from '@/lib/install-command';
import { settleAgentUpgrades, supportsRemoteUpgrade, upgradeAvailable } from '@/lib/agent-upgrade';
import { parseNyanpassArgs, parseOfficialNyanpassCommand, validNyanpassServiceName } from '@/lib/nyanpass-command';
import { publicOrigin } from '@/lib/public-origin';
import { newAgentToken, newBootstrapDownloadToken, sha256 } from '@/lib/security';
import { cleanText, normalizeDnsRr, normalizeDomainName, validDnsRr, validDomainName } from '@/lib/validation';
import { expireProvisionAttempts, isBootstrapLocked } from '@/lib/provision-lifecycle';
import { acquireNodeOperationLock, releaseNodeOperationLock } from '@/lib/node-operation-lock';
import { nodeResponse } from '@/lib/node-response';
import { decryptBootstrapPayload, encryptBootstrapPayload } from '@/lib/bootstrap-payload';
import { buildNodeStartupLauncher } from '@/lib/startup-launcher';
import { trustedNyanpassRelease } from '@/lib/nyanpass-release';
import { dnsOwnershipConflictMessage, findDnsOwnershipConflict, isDnsOwnershipConstraintError } from '@/lib/dns-ownership';
import { decryptNyanpassCredential } from '@/lib/nyanpass-credential';
import { reinstallArgs } from '@/lib/reinstall-plan';

export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.action === 'installation') return installationCommands(request, db, user, body);
  if (body?.action === 'agentUpgrade') return requestAgentUpgrade(db, user, body);
  if (body?.action === 'restoreInstallation') return restoreInstallation(request, db, user, body);
  const name = cleanText(body?.name, 60);
  const region = 'unknown';
  const bbrProfile = body?.bbrProfile === undefined || body?.bbrProfile === '' ? DEFAULT_BBR_PROFILE : body.bbrProfile;
  if (!isBbrProfile(bbrProfile)) return Response.json({ error: 'BBR 优化只能选择 c5in 或 c6in' }, { status: 400 });
  const domainName = normalizeDomainName(body?.domainName) || null;
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  const rootPassword = typeof body?.rootPassword === 'string' ? body.rootPassword : '';
  const nyanpassInput = Array.isArray(body?.nyanpass) ? body.nyanpass : [];
  if (!name) return Response.json({ error: '节点名称不能为空' }, { status: 400 });
  if (rootPassword.length < 8 || rootPassword.length > 128 || /[\x00-\x1f\x7f]/.test(rootPassword)) {
    return Response.json({ error: 'root 密码必须为 8-128 个字符，且不能包含控制字符' }, { status: 400 });
  }
  if (!nyanpassInput.length || nyanpassInput.length > 16) {
    return Response.json({ error: '请预先配置 1-16 个 Nyanpass 实例' }, { status: 400 });
  }
  if ((recordV4 || recordV6) && !domainName) return Response.json({ error: '配置 DNS 记录时必须填写阿里云主域名' }, { status: 400 });
  if (domainName && !validDomainName(domainName)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });

  const instanceNames = new Set<string>();
  const preparedInstances: Array<{
    id: string; name: string; args: string; panelUrl: string; role: 'inbound' | 'outbound'; optimize: boolean;
  }> = [];
  for (const input of nyanpassInput) {
    if (!input || typeof input !== 'object') return Response.json({ error: 'Nyanpass 实例参数无效' }, { status: 400 });
    const entry = input as Record<string, unknown>;
    const instanceName = cleanText(entry.name, 48);
    if (!validNyanpassServiceName(instanceName)) {
      return Response.json({ error: 'Nyanpass 实例名无效或属于系统保留名称；不要使用 systemd 单元后缀' }, { status: 400 });
    }
    if (instanceNames.has(instanceName)) return Response.json({ error: `Nyanpass 实例名重复：${instanceName}` }, { status: 400 });
    const parsed = parseOfficialNyanpassCommand(entry.command);
    if (!parsed.ok) return Response.json({ error: `${instanceName}：${parsed.error}` }, { status: 400 });
    instanceNames.add(instanceName);
    // OPTIMIZE 已移除：系统参数只由节点的 c5in / c6in BBR 选项控制。
    preparedInstances.push({ id: crypto.randomUUID(), name: instanceName, args: parsed.args, panelUrl: parsed.panelUrl, role: parsed.role, optimize: false });
  }

  const token = newAgentToken();
  const downloadToken = newBootstrapDownloadToken();
  const id = crypto.randomUUID();
  const provisionGeneration = 1;
  const now = new Date();
  const origin = publicOrigin(request);
  let nyanpassRelease;
  try {
    nyanpassRelease = await trustedNyanpassRelease();
  } catch {
    return Response.json({ error: 'Nyanpass 可信发布清单配置无效，请先修正主控环境变量' }, { status: 503 });
  }
  const bootstrapConfig = buildNodeBootstrapConfig({ nodeId: id, generation: provisionGeneration, origin, token, rootPassword, instances: preparedInstances, nyanpassRelease });
  if (new TextEncoder().encode(bootstrapConfig).byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) {
    return Response.json({ error: '节点配置数据超过 64 KiB 服务端安全上限；请减少首次预配实例，节点上线后再用远程同步添加' }, { status: 400 });
  }
  let bootstrapPayloadCiphertext = '';
  try {
    bootstrapPayloadCiphertext = await encryptBootstrapPayload({
      protocol: 1,
      agentToken: token,
      downloadToken,
      rootPassword,
      bbrProfile,
      instances: preparedInstances.map(({ name: instanceName, optimize, args }) => ({ name: instanceName, optimize, args })),
    }, { nodeId: id, generation: provisionGeneration });
  } catch (error) {
    return Response.json({ error: safeBootstrapEncryptionError(error) }, { status: 503 });
  }
  const [tokenHash, bootstrapDownloadTokenHash] = await Promise.all([sha256(token), sha256(downloadToken)]);
  const installUrl = `${origin}/api/v1/bootstrap/${id}/${downloadToken}`;
  const connectCommand = buildNodeConnectCommand(installUrl, bbrProfile, name);
  const startupScript = buildNodeStartupLauncher(id, installUrl, provisionGeneration, bbrProfile);
  if (new TextEncoder().encode(startupScript).byteLength > MAX_CLOUD_LAUNCHER_BYTES) {
    return Response.json({ error: '开机启动器超过 AWS user-data 的 15 KiB 安全上限' }, { status: 500 });
  }

  if (domainName && !await domainUsableBy(db, user.id, domainName)) return Response.json({ error: `主域名 ${domainName} 不在你的「阿里云主域名」列表中，请先添加` }, { status: 400 });
  const ownershipConflict = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6 });
  if (ownershipConflict) return Response.json({ error: dnsOwnershipConflictMessage(ownershipConflict) }, { status: 409 });
  try {
    await runInTransaction(db, [
      db.insert(nodes).values({ id, ownerId: user.id, name, region, tokenHash, provider: 'alidns', domainName, recordV4, recordV6, nyanpassStatus: 'awaiting', provisionGeneration, bootstrapPayloadCiphertext, bootstrapDownloadTokenHash, createdAt: now, updatedAt: now }),
      ...preparedInstances.map((instance) => db.insert(nyanpassInstances).values({ id: instance.id, nodeId: id, ownerId: user.id, name: instance.name, role: instance.role, panelUrl: instance.panelUrl, status: 'bootstrap', bootstrapGeneration: provisionGeneration, optimize: instance.optimize, createdAt: now, updatedAt: now })),
      db.insert(events).values({ nodeId: id, kind: 'node_created', message: `${user.username} 创建了节点并预配 ${preparedInstances.length} 个 Nyanpass 实例`, createdAt: now }),
    ]);
  } catch (error) {
    if (!isDnsOwnershipConstraintError(error)) throw error;
    const concurrentOwner = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6 });
    return Response.json({ error: concurrentOwner ? dnsOwnershipConflictMessage(concurrentOwner) : '该 DNS 记录刚刚被其他节点占用，请刷新后重试' }, { status: 409 });
  }

  return Response.json({
    node: { id, name, region },
    installUrl,
    connectCommand,
    startupScript,
    expiresAt: null,
    instances: preparedInstances.map((instance) => ({ id: instance.id, nodeId: id, nodeName: name, ownerId: user.id, ownerName: user.username, name: instance.name, role: instance.role, panelUrl: instance.panelUrl, optimize: instance.optimize, status: 'bootstrap', hasCredential: false, lastReportedAt: null, syncError: null, activeTaskId: null, configRevision: 0, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null })),
  }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

// 远程升级探针：只排队一个固定的升级任务，由探针下一次轮询时领取。
async function requestAgentUpgrade(db: AppDb, user: CurrentUser, body: Record<string, unknown>) {
  const id = cleanText(body.id, 64);
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  if (!await canAccessNode(db, user, id)) return Response.json({ error: '节点不存在' }, { status: 404 });
  const now = new Date();
  await settleAgentUpgrades(db, now, id);
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (node.agentUpgradeId) return Response.json({ error: '这台机器的探针正在升级，请等待完成' }, { status: 409 });
  if (isBootstrapLocked(node.nyanpassStatus)) return Response.json({ error: '开机安装尚未完成，暂时不能升级探针' }, { status: 409 });
  if (!supportsRemoteUpgrade(node.agentVersion)) {
    return Response.json({ error: `探针 ${node.agentVersion ? `v${node.agentVersion}` : '旧版本'} 还不支持远程升级，请先复制升级命令到机器上执行一次` }, { status: 409 });
  }
  if (!upgradeAvailable(node.agentVersion)) return Response.json({ error: `探针已经是最新版本 v${node.agentVersion}` }, { status: 409 });
  if (!node.lastTaskPollAt || now.getTime() - node.lastTaskPollAt.getTime() > 2 * 60 * 1000) {
    return Response.json({ error: '探针最近 2 分钟没有在线，无法远程升级；请确认机器正在运行' }, { status: 409 });
  }
  const upgradeId = crypto.randomUUID();
  const queued = await db.update(nodes).set({
    agentUpgradeId: upgradeId,
    agentUpgradeStatus: 'queued',
    agentUpgradeTargetVersion: PROBE_AGENT_VERSION,
    agentUpgradeRequestedAt: now,
    agentUpgradeStartedAt: null,
  }).where(and(eq(nodes.id, id), isNull(nodes.agentUpgradeId)));
  if (!affectedRows(queued)) return Response.json({ error: '这台机器的探针正在升级，请等待完成' }, { status: 409 });
  await db.insert(events).values({ nodeId: id, kind: 'agent_upgrade_requested', message: `${user.username} 请求把探针从 v${node.agentVersion} 远程升级到 v${PROBE_AGENT_VERSION}`, createdAt: now });
  const [latest] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  return Response.json({ node: nodeResponse(latest ?? node) });
}

async function installationCommands(request: Request, db: AppDb, user: CurrentUser, body: Record<string, unknown>) {
  const id = cleanText(body.id, 64);
  const headers = { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    return Response.json({ error: '节点 ID 无效' }, { status: 400, headers });
  }
  if (!await canAccessNode(db, user, id)) return Response.json({ error: '节点不存在' }, { status: 404, headers });
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404, headers });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409, headers });
  try {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return Response.json({ error: '节点不存在' }, { status: 404, headers });
    if (!node.bootstrapPayloadCiphertext) {
      return Response.json({ error: '该节点由旧版本安装，首次安装凭据已清除，不能再次下发完整安装；现有探针可使用升级命令' }, { status: 409, headers });
    }
    const payload = await decryptBootstrapPayload(node.bootstrapPayloadCiphertext, { nodeId: id, generation: node.provisionGeneration });
    // 链接长期有效，始终复用同一个下载凭据：已写入 AWS 启动模板的 User data 不会因为
    // 再次打开安装命令而失效。旧版本节点没有保存原始凭据时才签发一次新的。
    const reusable = Boolean(payload.downloadToken && await sha256(payload.downloadToken) === node.bootstrapDownloadTokenHash);
    const downloadToken = reusable ? payload.downloadToken! : newBootstrapDownloadToken();
    const origin = publicOrigin(request);
    const nyanpassRelease = await trustedNyanpassRelease();
    const config = buildNodeBootstrapConfig({ ...payload, token: payload.agentToken, nodeId: id, generation: node.provisionGeneration, origin, nyanpassRelease });
    const installUrl = `${origin}/api/v1/bootstrap/${id}/${downloadToken}`;
    const bbrProfile = payload.bbrProfile ?? DEFAULT_BBR_PROFILE;
    const startupScript = buildNodeStartupLauncher(id, installUrl, node.provisionGeneration, bbrProfile);
    if (new TextEncoder().encode(config).byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES
      || new TextEncoder().encode(startupScript).byteLength > MAX_CLOUD_LAUNCHER_BYTES) {
      return Response.json({ error: '安装配置超过安全大小上限' }, { status: 409, headers });
    }
    if (!reusable) {
      const ciphertext = await encryptBootstrapPayload({ ...payload, downloadToken }, { nodeId: id, generation: node.provisionGeneration });
      await db.update(nodes).set({
        bootstrapPayloadCiphertext: ciphertext,
        bootstrapDownloadTokenHash: await sha256(downloadToken),
      }).where(and(eq(nodes.id, id), eq(nodes.dnsOperationId, operationId)));
    }
    return Response.json({
      node: { id, name: node.name, region: node.region },
      installUrl, connectCommand: buildNodeConnectCommand(installUrl, bbrProfile, node.name), startupScript,
      expiresAt: null,
    }, { headers });
  } catch {
    return Response.json({ error: '无法读取安装凭据，请检查主控加密密钥和 Nyanpass 发布配置；原节点未重置' }, { status: 503, headers });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
}

// 旧版本节点首次安装后擦除了开机凭据。这里沿用机器上正在使用的探针令牌补存一次，
// 之后安装命令和开机脚本就和新节点一样长期固定；机器上的探针不受影响。
async function restoreInstallation(request: Request, db: AppDb, user: CurrentUser, body: Record<string, unknown>) {
  const id = cleanText(body.id, 64);
  const agentToken = typeof body.agentToken === 'string' ? body.agentToken.trim() : '';
  const rootPassword = typeof body.rootPassword === 'string' ? body.rootPassword : '';
  const bbrProfile = body.bbrProfile === undefined || body.bbrProfile === '' ? DEFAULT_BBR_PROFILE : body.bbrProfile;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return Response.json({ error: '节点 ID 无效' }, { status: 400 });
  if (!isBbrProfile(bbrProfile)) return Response.json({ error: 'BBR 优化只能选择 c5in 或 c6in' }, { status: 400 });
  if (!/^pd_[a-f0-9]{64}$/.test(agentToken)) return Response.json({ error: '探针令牌格式无效：应为 pd_ 开头加 64 位十六进制字符' }, { status: 400 });
  if (rootPassword.length < 8 || rootPassword.length > 128 || /[\x00-\x1f\x7f]/.test(rootPassword)) {
    return Response.json({ error: 'root 密码必须为 8-128 个字符，且不能包含控制字符' }, { status: 400 });
  }
  if (!await canAccessNode(db, user, id)) return Response.json({ error: '节点不存在' }, { status: 404 });
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试' }, { status: 409 });
  try {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });
    if (node.bootstrapPayloadCiphertext) return Response.json({ error: '该节点已有安装命令，无需补存' }, { status: 409 });
    if (await sha256(agentToken) !== node.tokenHash) return Response.json({ error: '探针令牌与该节点不符，请从这台机器的 /etc/ddns-monitor.conf 复制 TOKEN=' }, { status: 400 });

    // 换机重装计划：优先用本次粘贴的官方命令；没粘贴时用仍保存着的同步凭据；都没有的实例不加入。
    const pasted = Array.isArray(body.instances) ? body.instances : [];
    const commandsById = new Map<string, unknown>();
    for (const entry of pasted) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.id === 'string' && typeof item.command === 'string' && item.command.trim()) commandsById.set(item.id, item.command);
    }
    const registered = await db.select().from(nyanpassInstances).where(eq(nyanpassInstances.nodeId, id));
    const planned: Array<{ id: string; name: string; optimize: boolean; args: string }> = [];
    for (const instance of registered) {
      if (planned.length >= 16) break;
      const command = commandsById.get(instance.id);
      if (command !== undefined) {
        const parsed = parseOfficialNyanpassCommand(command);
        if (!parsed.ok) return Response.json({ error: `${instance.name}：${parsed.error}` }, { status: 400 });
        if (parsed.role !== instance.role || parsed.panelUrl !== instance.panelUrl) {
          return Response.json({ error: `${instance.name}：粘贴的命令与登记的实例不一致（入口/出口或对接面板地址不同）` }, { status: 400 });
        }
        planned.push({ id: instance.id, name: instance.name, optimize: false, args: parsed.args });
        continue;
      }
      if (!instance.credentialCiphertext) continue;
      try {
        const clientToken = await decryptNyanpassCredential(instance.credentialCiphertext, { nodeId: id, instanceId: instance.id, revision: instance.configRevision });
        const args = reinstallArgs(instance.role, clientToken, instance.panelUrl);
        const parsed = parseNyanpassArgs(args);
        if (parsed.ok && parsed.args === args) planned.push({ id: instance.id, name: instance.name, optimize: false, args });
      } catch {
        // 无法解密的凭据跳过，不影响其他实例。
      }
    }
    if (!planned.length) {
      return Response.json({ error: '这台机器上没有保存了同步凭据的 Nyanpass 实例，请至少粘贴一个实例的 Nyanpass 官方安装命令' }, { status: 409 });
    }

    const downloadToken = newBootstrapDownloadToken();
    let ciphertext = '';
    try {
      ciphertext = await encryptBootstrapPayload({
        protocol: 1,
        agentToken,
        downloadToken,
        rootPassword,
        bbrProfile,
        instances: planned.map(({ name, optimize, args }) => ({ name, optimize, args })),
      }, { nodeId: id, generation: node.provisionGeneration });
    } catch (error) {
      return Response.json({ error: safeBootstrapEncryptionError(error) }, { status: 503 });
    }
    const now = new Date();
    const updated = await db.update(nodes).set({
      bootstrapPayloadCiphertext: ciphertext,
      bootstrapDownloadTokenHash: await sha256(downloadToken),
      updatedAt: now,
    }).where(and(eq(nodes.id, id), eq(nodes.dnsOperationId, operationId), isNull(nodes.bootstrapPayloadCiphertext)));
    if (!affectedRows(updated)) return Response.json({ error: '节点状态已变化，请刷新后重试' }, { status: 409 });
    await db.update(nyanpassInstances).set({ bootstrapGeneration: node.provisionGeneration })
      .where(and(eq(nyanpassInstances.nodeId, id), inArray(nyanpassInstances.id, planned.map((instance) => instance.id))));
    const skipped = registered.length - planned.length;
    await db.insert(events).values({
      nodeId: id,
      kind: 'node_installation_restored',
      message: `${user.username} 补存了节点安装命令，换机重装 ${planned.length} 个 Nyanpass 实例${skipped ? `（${skipped} 个未提供安装命令，未加入）` : ''}`,
      createdAt: now,
    });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
  return installationCommands(request, db, user, { id });
}

function safeBootstrapEncryptionError(error: unknown) {
  return error instanceof Error && error.message.includes('PULSEDNS_TASK_ENCRYPTION_KEY')
    ? error.message
    : '开机脚本凭据加密失败，请检查主控密钥配置';
}

export async function PATCH(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = cleanText(body?.id, 64);
  const name = cleanText(body?.name, 60);
  const domainName = normalizeDomainName(body?.domainName) || null;
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  const syncEnabled = body?.syncEnabled;
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  if (!name) return Response.json({ error: '节点名称不能为空' }, { status: 400 });
  if (typeof syncEnabled !== 'boolean') return Response.json({ error: '同步状态参数无效' }, { status: 400 });
  if ((recordV4 || recordV6) && !domainName) return Response.json({ error: '配置 DNS 记录时必须填写阿里云主域名' }, { status: 400 });
  if (domainName && !validDomainName(domainName)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });

  if (!await canAccessNode(db, user, id)) return Response.json({ error: '节点不存在' }, { status: 404 });
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试修改' }, { status: 409 });
  try {
    const [current] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!current) return Response.json({ error: '节点不存在' }, { status: 404 });
    if (domainName && domainName !== current.domainName && !await domainUsableBy(db, current.ownerId, domainName)) {
      return Response.json({ error: `主域名 ${domainName} 不在该节点所属用户的「阿里云主域名」列表中，请先添加` }, { status: 400 });
    }

    if (syncEnabled) {
      const ownershipConflict = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6, excludeNodeId: id });
      if (ownershipConflict) return Response.json({ error: dnsOwnershipConflictMessage(ownershipConflict) }, { status: 409 });
    }

  const now = new Date();
  try {
    await db.update(nodes).set({ name, domainName, recordV4, recordV6, syncEnabled, updatedAt: now }).where(eq(nodes.id, id));
  } catch (error) {
    if (!isDnsOwnershipConstraintError(error)) throw error;
    const concurrentOwner = await findDnsOwnershipConflict(db, { domainName, recordV4, recordV6, excludeNodeId: id });
    return Response.json({ error: concurrentOwner ? dnsOwnershipConflictMessage(concurrentOwner) : '该 DNS 记录刚刚被其他节点占用，请刷新后重试' }, { status: 409 });
  }

  const returnedEvents: Array<{ id: number; nodeId: string; nodeName: string; level: string; kind: string; message: string; createdAt: Date }> = [];
  const updatedEvent = { nodeId: id, level: 'info', kind: 'node_updated', message: `${user.username} 修改了节点 ${name} 的控制台配置`, createdAt: now };
  const [updatedEventId] = await db.insert(events).values(updatedEvent).$returningId();
  returnedEvents.push({ ...updatedEvent, id: updatedEventId.id, nodeName: name });

  const warnings: string[] = [];
  const dnsMappingChanged = current.domainName !== domainName || current.recordV4 !== recordV4 || current.recordV6 !== recordV6;
  if (dnsMappingChanged && current.domainName && (current.recordV4 || current.recordV6)) {
    warnings.push('旧的阿里云 DNS 记录不会自动删除，如已不再使用请到阿里云控制台清理');
  }

  // Re-read addresses after publishing the new mapping. A probe report may
  // have committed a newer IP between the initial read and this update.
  const [addressState] = await db.select({ ipv4: nodes.ipv4, ipv6: nodes.ipv6 }).from(nodes).where(eq(nodes.id, id)).limit(1);
  const targets = [
    { type: 'A' as const, record: recordV4, ip: addressState?.ipv4 ?? null },
    { type: 'AAAA' as const, record: recordV6, ip: addressState?.ipv6 ?? null },
  ];
  if (syncEnabled && domainName) {
    for (const target of targets) {
      if (!target.record || !target.ip) continue;
      const result = await syncAliDnsRecord(domainName, target.record, target.type, target.ip);
      if (!result.ok) warnings.push(`${target.type} 同步失败：${result.error}`);
      const dnsEvent = {
        nodeId: id,
        level: result.ok ? 'info' : 'error',
        kind: result.ok ? 'dns_synced' : 'dns_failed',
        message: result.ok ? `${target.type} 记录 ${target.record} 已按修改后的配置同步` : `${target.type} 同步失败：${result.error}`,
        ipType: target.type,
        ip: target.ip,
        createdAt: now,
      };
      const [dnsEventId] = await db.insert(events).values(dnsEvent).$returningId();
      returnedEvents.push({ id: dnsEventId.id, nodeId: id, level: dnsEvent.level, kind: dnsEvent.kind, message: dnsEvent.message, createdAt: now, nodeName: name });
    }
  }

  const [latestNode] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    return Response.json({
      node: nodeResponse(latestNode ?? { ...current, name, domainName, recordV4, recordV6, syncEnabled, updatedAt: now }),
      events: returnedEvents,
      warnings,
    });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  if (!await canAccessNode(db, user, id)) return Response.json({ error: '节点不存在' }, { status: 404 });
  const operationId = await acquireNodeOperationLock(db, id);
  if (operationId === undefined) return Response.json({ error: '节点不存在' }, { status: 404 });
  if (operationId === null) return Response.json({ error: '节点正在处理其他操作，请稍后重试删除' }, { status: 409 });
  try {
    await expireProvisionAttempts(db, new Date(), id);
    const [node] = await db.select({ nyanpassStatus: nodes.nyanpassStatus, provisionAttemptId: nodes.provisionAttemptId }).from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });
    if (isBootstrapLocked(node.nyanpassStatus) && searchParams.get('confirmProvisioning') !== 'checked') {
      return Response.json({ error: '节点尚未安全完成开机预配；明确确认脚本未执行或安装进程已停止后才能删除' }, { status: 409 });
    }
    const [activeTask] = await db.select({ id: agentTasks.id }).from(agentTasks)
      .where(and(eq(agentTasks.nodeId, id), inArray(agentTasks.status, ['queued', 'running']))).limit(1);
    if (activeTask) return Response.json({ error: '节点还有排队或执行中的同步任务；请先取消尚未领取的排队，机器开始安装后不能删除节点' }, { status: 409 });
    const [[uncertainInstance], [uncertainTask]] = await Promise.all([
      db.select({ id: nyanpassInstances.id }).from(nyanpassInstances)
        .where(and(eq(nyanpassInstances.nodeId, id), eq(nyanpassInstances.status, 'uncertain'))).limit(1),
      db.select({ id: agentTasks.id }).from(agentTasks)
        .where(and(eq(agentTasks.nodeId, id), eq(agentTasks.status, 'uncertain'))).limit(1),
    ]);
    if ((node.nyanpassStatus === 'failed' || uncertainInstance || uncertainTask) && searchParams.get('confirmUncertain') !== 'checked') {
      return Response.json({
        error: '节点存在结果未知的开机安装或远程任务；请先核查 VPS，明确确认后才能删除登记',
        requiresUncertainConfirmation: true,
      }, { status: 409 });
    }
    const attemptCondition = node.provisionAttemptId === null ? isNull(nodes.provisionAttemptId) : eq(nodes.provisionAttemptId, node.provisionAttemptId);
    const deleted = await db.delete(nodes).where(and(eq(nodes.id, id), eq(nodes.nyanpassStatus, node.nyanpassStatus), attemptCondition));
    if (!affectedRows(deleted)) return Response.json({ error: '节点开机安装状态已经变化，请刷新后重试' }, { status: 409 });
    return Response.json({ status: 'ok' });
  } finally {
    await releaseNodeOperationLock(db, id, operationId);
  }
}
