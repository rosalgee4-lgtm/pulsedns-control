import { asc, count, eq } from 'drizzle-orm';
import { affectedRows, isDuplicateKeyError } from '@/db';
import { ensureSchema } from '@/db/init';
import { aliyunAccounts, domains, nodeDnsRecords, nodes, nyanpassInstances, sessions, users } from '@/db/schema';
import { requireApiUser } from '@/lib/auth';
import { hashPassword, validPassword, validUsername } from '@/lib/passwords';

// 用户管理（仅管理员）：普通用户由管理员创建，不开放注册。

export async function GET(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const rows = await auth.db.select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt }).from(users).orderBy(asc(users.createdAt));
  const counts = await auth.db.select({ ownerId: nodes.ownerId, total: count() }).from(nodes).groupBy(nodes.ownerId);
  const byOwner = new Map(counts.map((row) => [row.ownerId, row.total]));
  return Response.json({ users: rows.map((row) => ({ ...row, nodeCount: byOwner.get(row.id) ?? 0, createdAt: row.createdAt.toISOString() })) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = body?.password;
  if (!validUsername(username)) return Response.json({ error: '用户名须为 3-32 位字母、数字、点、下划线或短横线' }, { status: 400 });
  if (!validPassword(password)) return Response.json({ error: '密码须为 12-128 位，且不能包含换行' }, { status: 400 });
  const now = new Date();
  const id = crypto.randomUUID();
  try {
    await auth.db.insert(users).values({ id, username, role: 'user', passwordHash: await hashPassword(password), createdAt: now, updatedAt: now });
  } catch (error) {
    if (isDuplicateKeyError(error)) return Response.json({ error: `用户名 ${username} 已经存在` }, { status: 409 });
    throw error;
  }
  return Response.json({ user: { id, username, role: 'user', nodeCount: 0, createdAt: now.toISOString() } }, { status: 201 });
}

// 管理员重置普通用户的密码；该用户已登录的会话全部失效。
export async function PATCH(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  const password = body?.password;
  if (!validPassword(password)) return Response.json({ error: '密码须为 12-128 位，且不能包含换行' }, { status: 400 });
  const [target] = await auth.db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!target || target.role !== 'user') return Response.json({ error: '用户不存在' }, { status: 404 });
  await auth.db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(users.id, id));
  await auth.db.delete(sessions).where(eq(sessions.userId, id));
  return Response.json({ status: 'ok' });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const [target] = await auth.db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!target || target.role !== 'user') return Response.json({ error: '用户不存在' }, { status: 404 });
  for (const [table, label] of [[nodes, '节点'], [domains, '主域名'], [aliyunAccounts, '阿里云账号'], [nyanpassInstances, 'Nyanpass 实例'], [nodeDnsRecords, '共享机器上的解析']] as const) {
    const [owned] = await auth.db.select({ total: count() }).from(table).where(eq(table.ownerId, id));
    if (owned.total > 0) return Response.json({ error: `该用户还有 ${owned.total} 个${label}，请先删除后再删除用户` }, { status: 409 });
  }
  const deleted = await auth.db.delete(users).where(eq(users.id, id));
  if (!affectedRows(deleted)) return Response.json({ error: '用户不存在' }, { status: 404 });
  return Response.json({ status: 'ok' });
}

