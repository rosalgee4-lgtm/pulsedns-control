// 测试用：为每个测试文件准备独立的 MySQL 数据库、管理员账号与登录会话。
import { register } from 'node:module';
import { after } from 'node:test';
import { createTestDatabase } from './mysql-test-db.mjs';

register('./path-alias-loader.mjs', import.meta.url);

export const ADMIN = { username: 'admin', password: 'admin-password-123' };

export async function setupTestApp(prefix) {
  const database = await createTestDatabase(prefix);
  process.env.PULSEDNS_TASK_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.PULSEDNS_INITIAL_ADMIN_USER = ADMIN.username;
  process.env.PULSEDNS_INITIAL_ADMIN_PASSWORD = ADMIN.password;
  process.env.PULSEDNS_ALLOW_HTTP = '1';
  const { ensureSchema } = await import('../db/init.ts');
  const { getDb, closeDb } = await import('../db/index.ts');
  const { createSession } = await import('../lib/auth.ts');
  await ensureSchema();
  const db = await getDb();
  after(async () => { await closeDb(); await database.drop(); });

  async function sessionFor(username) {
    const [user] = await database.query('SELECT id FROM users WHERE username = ?', [username]);
    if (!user) throw new Error(`no such user ${username}`);
    return `pulsedns_session=${await createSession(db, user.id)}`;
  }

  async function createUser(username, password = 'member-password-123') {
    const { POST } = await import('../app/api/admin/users/route.ts');
    const response = await POST(api('https://panel.test/api/admin/users', 'POST', { username, password }, await sessionFor(ADMIN.username)));
    if (response.status !== 201) throw new Error(`create user failed: ${response.status} ${await response.text()}`);
    return (await response.json()).user;
  }

  return { database, db, sessionFor, createUser, adminCookie: await sessionFor(ADMIN.username) };
}

// 模拟浏览器从面板页面发起的请求：带会话 Cookie 和 Sec-Fetch-Site: same-origin。
export function api(url, method = 'GET', body, cookie, extraHeaders = {}) {
  const headers = { 'Sec-Fetch-Site': 'same-origin', ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
