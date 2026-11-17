import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { users } from '@/db/schema';
import { clientIp, createSession, httpAllowed, requestIsHttps, sameOriginRequest, SESSION_LIFETIME_MS, sessionCookie } from '@/lib/auth';
import { clearLoginFailures, loginLockedUntil, recordLoginFailure } from '@/lib/login-guard';
import { dummyPasswordHash, verifyPassword } from '@/lib/passwords';
import { multiUserEnabled } from '@/lib/settings';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  if (!sameOriginRequest(request.headers)) return Response.json({ error: '拒绝跨站请求' }, { status: 403, headers: noStore });
  const secure = requestIsHttps(request.headers, request.url);
  if (!secure && !httpAllowed()) {
    return Response.json({ error: '请通过 HTTPS 访问面板后再登录（在宝塔等反向代理中开启 HTTPS）' }, { status: 400, headers: noStore });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const username = typeof body?.username === 'string' ? body.username.trim().slice(0, 64) : '';
  const password = typeof body?.password === 'string' ? body.password.slice(0, 256) : '';
  if (!username || !password) return Response.json({ error: '请输入用户名和密码' }, { status: 400, headers: noStore });

  await ensureSchema();
  const db = await getDb();
  const ip = clientIp(request.headers);
  const now = new Date();
  const lockedUntil = await loginLockedUntil(db, ip, username, now);
  if (lockedUntil) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    return Response.json({ error: `登录失败次数过多，请 ${minutes} 分钟后再试` }, { status: 429, headers: { ...noStore, 'Retry-After': String(minutes * 60) } });
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  // 用户名不存在时也做一次同等耗时的校验，避免按响应时间探测用户名。
  const valid = await verifyPassword(password, user?.passwordHash ?? await dummyPasswordHash());
  if (!user || !valid) {
    await recordLoginFailure(db, ip, username, now);
    return Response.json({ error: '用户名或密码错误' }, { status: 401, headers: noStore });
  }
  await clearLoginFailures(db, ip, username);
  if (user.role !== 'admin' && !await multiUserEnabled(db)) {
    return Response.json({ error: '多用户模式未开启，目前只允许管理员登录' }, { status: 403, headers: noStore });
  }
  const token = await createSession(db, user.id, now);
  return Response.json({ status: 'ok' }, { headers: { ...noStore, 'Set-Cookie': sessionCookie(token, secure, SESSION_LIFETIME_MS / 1000) } });
}
