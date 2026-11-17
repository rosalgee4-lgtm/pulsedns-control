import { and, eq, ne } from 'drizzle-orm';
import { ensureSchema } from '@/db/init';
import { sessions, users } from '@/db/schema';
import { requireApiUser, sessionTokenFromRequest } from '@/lib/auth';
import { hashPassword, validPassword, verifyPassword } from '@/lib/passwords';
import { sha256 } from '@/lib/security';

// 修改自己的密码：需要输入当前密码；其他设备上的登录会话全部失效。
export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = body?.newPassword;
  if (!validPassword(newPassword)) return Response.json({ error: '新密码须为 12-128 位，且不能包含换行' }, { status: 400 });
  const [row] = await auth.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, auth.user.id)).limit(1);
  if (!row || !await verifyPassword(currentPassword, row.passwordHash)) return Response.json({ error: '当前密码不正确' }, { status: 400 });
  await auth.db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, auth.user.id));
  const token = sessionTokenFromRequest(request) ?? '';
  await auth.db.delete(sessions).where(and(eq(sessions.userId, auth.user.id), ne(sessions.tokenHash, await sha256(token))));
  return Response.json({ status: 'ok' });
}
