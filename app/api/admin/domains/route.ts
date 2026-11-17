import { asc, eq } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { aliyunAccounts, domains, nodes } from '@/db/schema';
import { verifyAliDnsDomain } from '@/lib/alidns';
import { accountCredentials } from '@/lib/aliyun-accounts';
import { normalizeDomainName, validDomainName } from '@/lib/validation';

type AppDb = Awaited<ReturnType<typeof getDb>>;

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select().from(domains).orderBy(asc(domains.name));
  return Response.json({ domains: rows.map(domainResponse) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = normalizeDomainName(body?.name);
  if (!name || !validDomainName(name)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  const accountId = requestedAccountId(body?.accountId);
  await ensureSchema();
  const db = await getDb();
  const [existing] = await db.select().from(domains).where(eq(domains.name, name)).limit(1);
  if (existing) return Response.json({ error: `主域名 ${name} 已经存在` }, { status: 409 });
  const checked = await checkDomainAccount(db, name, accountId);
  if (checked) return checked;
  const now = new Date();
  const inserted = await db.insert(domains).values({ name, accountId, createdAt: now }).onConflictDoNothing().returning({ name: domains.name });
  if (!inserted.length) return Response.json({ error: `主域名 ${name} 已经存在` }, { status: 409 });
  return Response.json({ domain: domainResponse({ name, accountId, createdAt: now }) }, { status: 201 });
}

// 把主域名改到另一个阿里云账号（空值表示默认 Key）。
export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = normalizeDomainName(body?.name);
  if (!name) return Response.json({ error: '缺少主域名' }, { status: 400 });
  const accountId = requestedAccountId(body?.accountId);
  await ensureSchema();
  const db = await getDb();
  const [existing] = await db.select().from(domains).where(eq(domains.name, name)).limit(1);
  if (!existing) return Response.json({ error: '主域名不存在' }, { status: 404 });
  const checked = await checkDomainAccount(db, name, accountId);
  if (checked) return checked;
  await db.update(domains).set({ accountId }).where(eq(domains.name, name));
  return Response.json({ domain: domainResponse({ ...existing, accountId }) });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const name = normalizeDomainName(new URL(request.url).searchParams.get('name'));
  if (!name) return Response.json({ error: '缺少主域名' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const [used] = await db.select({ name: nodes.name }).from(nodes).where(eq(nodes.domainName, name)).limit(1);
  if (used) return Response.json({ error: `主域名 ${name} 正在被节点 ${used.name} 使用，请先修改或删除该节点` }, { status: 409 });
  const deleted = await db.delete(domains).where(eq(domains.name, name)).returning({ name: domains.name });
  if (!deleted.length) return Response.json({ error: '主域名不存在' }, { status: 404 });
  return Response.json({ status: 'ok' });
}

function requestedAccountId(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

// 保存前用所选账号的 Key 读取一次该域名的解析记录；失败则拒绝保存。
async function checkDomainAccount(db: AppDb, name: string, accountId: string | null) {
  if (accountId) {
    const [account] = await db.select({ id: aliyunAccounts.id }).from(aliyunAccounts).where(eq(aliyunAccounts.id, accountId)).limit(1);
    if (!account) return Response.json({ error: '所选阿里云账号不存在' }, { status: 400 });
  }
  const credentials = await accountCredentials(db, accountId);
  if (!credentials.accessKeyId || !credentials.accessKeySecret) {
    return Response.json({ error: '安装面板时没有配置默认 AccessKey，请先添加阿里云账号并选择它' }, { status: 400 });
  }
  const verified = await verifyAliDnsDomain(credentials, name);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  return null;
}

function domainResponse(domain: { name: string; accountId: string | null; createdAt: Date }) {
  return { name: domain.name, accountId: domain.accountId, createdAt: domain.createdAt.toISOString() };
}
