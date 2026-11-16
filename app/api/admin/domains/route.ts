import { asc, eq } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { domains, nodes } from '@/db/schema';
import { normalizeDomainName, validDomainName } from '@/lib/validation';

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
  await ensureSchema();
  const db = await getDb();
  const [existing] = await db.select().from(domains).where(eq(domains.name, name)).limit(1);
  if (existing) return Response.json({ error: `主域名 ${name} 已经存在` }, { status: 409 });
  const now = new Date();
  await db.insert(domains).values({ name, createdAt: now }).onConflictDoNothing();
  return Response.json({ domain: domainResponse({ name, createdAt: now }) }, { status: 201 });
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

function domainResponse(domain: { name: string; createdAt: Date }) {
  return { name: domain.name, createdAt: domain.createdAt.toISOString() };
}
