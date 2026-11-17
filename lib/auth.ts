import { and, eq, gt, lt } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb, type AppDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { sessions, users } from '@/db/schema';
import { sha256 } from '@/lib/security';
import { multiUserEnabled } from '@/lib/settings';

export type CurrentUser = { id: string; username: string; role: 'admin' | 'user' };

export const SESSION_COOKIE = 'pulsedns_session';
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function basePath() {
  const value = process.env.PULSEDNS_BASE_PATH?.trim() ?? '';
  return /^\/[a-f0-9]{32}$/.test(value) ? value : '';
}

// 面板只应通过宝塔等反向代理以 HTTPS 访问；PULSEDNS_TRUST_PROXY=1 时才信任代理传来的
// X-Forwarded-Proto / X-Real-IP / X-Forwarded-Host（容器端口只绑定 127.0.0.1）。
export function trustProxy() {
  return process.env.PULSEDNS_TRUST_PROXY === '1';
}

export function requestIsHttps(requestHeaders: Headers, url?: string) {
  if (trustProxy() && requestHeaders.get('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  return url ? new URL(url).protocol === 'https:' : false;
}

// 仅用于本机测试：PULSEDNS_ALLOW_HTTP=1 时允许不经 HTTPS 登录。
export function httpAllowed() {
  return process.env.PULSEDNS_ALLOW_HTTP === '1';
}

// 防爆破用的来源 IP。优先取 X-Forwarded-For 最右侧一跳：它由最近的反向代理
// （宝塔 $proxy_add_x_forwarded_for）追加，客户端无法伪造；代理没有追加时才用 X-Real-IP。
export function clientIp(requestHeaders: Headers) {
  if (!trustProxy()) return 'direct';
  const forwarded = requestHeaders.get('x-forwarded-for')?.split(',').map((part) => part.trim()).filter(Boolean);
  if (forwarded?.length) return forwarded[forwarded.length - 1].slice(0, 64);
  const realIp = requestHeaders.get('x-real-ip')?.trim();
  return realIp ? realIp.slice(0, 64) : 'direct';
}

export function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `ps_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number) {
  const path = basePath() || '/';
  return `${SESSION_COOKIE}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export async function createSession(db: AppDb, userId: string, now = new Date()) {
  const token = newSessionToken();
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.insert(sessions).values({ tokenHash: await sha256(token), userId, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS) });
  return token;
}

async function userForToken(token: string | undefined): Promise<CurrentUser | null> {
  if (!token || !/^ps_[a-f0-9]{64}$/.test(token)) return null;
  await ensureSchema();
  const db = await getDb();
  const [row] = await db.select({ id: users.id, username: users.username, role: users.role })
    .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, await sha256(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!row) return null;
  // 多用户模式关闭时，只有管理员能继续使用面板。
  if (row.role !== 'admin' && !await multiUserEnabled(db)) return null;
  return row;
}

// 页面（服务端组件）读取当前登录用户。
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  return userForToken(store.get(SESSION_COOKIE)?.value);
}

export function sessionTokenFromRequest(request: Request) {
  return request.headers.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

export async function requirePageUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (user) return user;
  redirect('/login');
}

// 跨站请求防护：修改类请求必须来自面板自己的页面。
// 浏览器会带上 Sec-Fetch-Site；旧浏览器退回比对 Origin 与 Host。
export function sameOriginRequest(requestHeaders: Headers) {
  const fetchSite = requestHeaders.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  const origin = requestHeaders.get('origin');
  if (!origin) return false;
  const host = (trustProxy() && requestHeaders.get('x-forwarded-host')?.split(',')[0].trim()) || requestHeaders.get('host');
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

type ApiAuth = { user: CurrentUser; db: AppDb } | { response: Response };

export async function requireApiUser(request: Request, options: { admin?: boolean } = {}): Promise<ApiAuth> {
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOriginRequest(request.headers)) {
    return { response: Response.json({ error: '拒绝跨站请求' }, { status: 403 }) };
  }
  const user = await userForToken(sessionTokenFromRequest(request));
  if (!user) return { response: Response.json({ error: '请先登录' }, { status: 401 }) };
  if (options.admin && user.role !== 'admin') return { response: Response.json({ error: '只有管理员可以执行这个操作' }, { status: 403 }) };
  return { user, db: await getDb() };
}
