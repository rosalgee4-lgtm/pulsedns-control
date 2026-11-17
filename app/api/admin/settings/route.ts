import { eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/init';
import { sessions, users } from '@/db/schema';
import { requireApiUser } from '@/lib/auth';
import { multiUserEnabled, setMultiUserEnabled } from '@/lib/settings';

// 管理员设置：多用户模式开关。关闭时只允许管理员登录，普通用户的会话立即失效
// （其节点照常运行、照常同步解析，只是不能登录面板）。

export async function GET(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  return Response.json({ multiUserEnabled: await multiUserEnabled(auth.db) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request, { admin: true });
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.multiUserEnabled !== 'boolean') return Response.json({ error: '参数无效' }, { status: 400 });
  await setMultiUserEnabled(auth.db, body.multiUserEnabled);
  if (!body.multiUserEnabled) {
    const members = await auth.db.select({ id: users.id }).from(users).where(eq(users.role, 'user'));
    for (const member of members) await auth.db.delete(sessions).where(eq(sessions.userId, member.id));
  }
  return Response.json({ multiUserEnabled: body.multiUserEnabled });
}
