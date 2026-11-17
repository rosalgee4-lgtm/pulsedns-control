import { eq } from 'drizzle-orm';
import { affectedRows, isDuplicateKeyError, type AppDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { aliyunAccounts, domains, nodes } from '@/db/schema';
import { verifyAliDnsDomain } from '@/lib/alidns';
import { accountCredentials } from '@/lib/aliyun-accounts';
import { requireApiUser, type CurrentUser } from '@/lib/auth';
import { listDomains } from '@/lib/domains';
import { normalizeDomainName, validDomainName } from '@/lib/validation';

export async function GET(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  return Response.json({ domains: await listDomains(auth.db, auth.user) }, { headers: { 'Cache-Control': 'no-store' } });
}

// 主域名属于添加它的用户；绑定的阿里云账号也必须属于同一个用户。
export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = normalizeDomainName(body?.name);
  if (!name || !validDomainName(name)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const [existing] = await db.select({ name: domains.name }).from(domains).where(eq(domains.name, name)).limit(1);
  if (existing) return Response.json({ error: `主域名 ${name} 已经存在` }, { status: 409 });
  const checked = await checkDomainAccount(db, user.id, name, accountId);
  if (checked) return checked;
  const now = new Date();
  try {
    await db.insert(domains).values({ name, ownerId: user.id, accountId, createdAt: now });
  } catch (error) {
    if (isDuplicateKeyError(error)) return Response.json({ error: `主域名 ${name} 已经存在` }, { status: 409 });
    throw error;
  }
  return Response.json({ domain: { name, ownerId: user.id, ownerName: user.username, accountId, createdAt: now.toISOString() } }, { status: 201 });
}

// 把主域名改到同一用户的另一个阿里云账号。
export async function PATCH(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = normalizeDomainName(body?.name);
  if (!name) return Response.json({ error: '缺少主域名' }, { status: 400 });
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const existing = await visibleDomain(db, user, name);
  if (!existing) return Response.json({ error: '主域名不存在' }, { status: 404 });
  const checked = await checkDomainAccount(db, existing.ownerId, name, accountId);
  if (checked) return checked;
  await db.update(domains).set({ accountId }).where(eq(domains.name, name));
  return Response.json({ domain: { name, accountId } });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const name = normalizeDomainName(new URL(request.url).searchParams.get('name'));
  if (!name) return Response.json({ error: '缺少主域名' }, { status: 400 });
  if (!await visibleDomain(db, user, name)) return Response.json({ error: '主域名不存在' }, { status: 404 });
  const [used] = await db.select({ name: nodes.name }).from(nodes).where(eq(nodes.domainName, name)).limit(1);
  if (used) return Response.json({ error: `主域名 ${name} 正在被节点 ${used.name} 使用，请先修改或删除该节点` }, { status: 409 });
  const deleted = await db.delete(domains).where(eq(domains.name, name));
  if (!affectedRows(deleted)) return Response.json({ error: '主域名不存在' }, { status: 404 });
  return Response.json({ status: 'ok' });
}

async function visibleDomain(db: AppDb, user: CurrentUser, name: string) {
  const [domain] = await db.select({ name: domains.name, ownerId: domains.ownerId }).from(domains).where(eq(domains.name, name)).limit(1);
  if (!domain || (user.role !== 'admin' && domain.ownerId !== user.id)) return null;
  return domain;
}

// 保存前用所选账号的 Key 读取一次该域名的解析记录；失败则拒绝保存。
async function checkDomainAccount(db: AppDb, ownerId: string, name: string, accountId: string) {
  if (!accountId) return Response.json({ error: '请先选择阿里云账号（没有账号时先在上方添加）' }, { status: 400 });
  const [account] = await db.select({ ownerId: aliyunAccounts.ownerId }).from(aliyunAccounts).where(eq(aliyunAccounts.id, accountId)).limit(1);
  if (!account || account.ownerId !== ownerId) return Response.json({ error: '所选阿里云账号不存在' }, { status: 400 });
  const verified = await verifyAliDnsDomain(await accountCredentials(db, accountId), name);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  return null;
}
