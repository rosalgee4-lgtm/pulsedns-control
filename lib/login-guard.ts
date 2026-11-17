import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { loginAttempts } from '@/db/schema';

// 防爆破：15 分钟窗口内，
//   同一来源 IP + 用户名 失败 5 次 → 该组合锁定 15 分钟；
//   同一来源 IP 失败 20 次（不论用户名）→ 该 IP 锁定 15 分钟。
// 锁定期间即使密码正确也拒绝登录。登录成功会清除「IP + 用户名」的计数。
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LIMITS = { pair: 5, ip: 20 } as const;

function scopes(ip: string, username: string) {
  return { pair: `pair:${ip}|${username.toLowerCase()}`.slice(0, 200), ip: `ip:${ip}`.slice(0, 200) };
}

export async function loginLockedUntil(db: AppDb, ip: string, username: string, now = new Date()) {
  let until: Date | null = null;
  for (const scope of Object.values(scopes(ip, username))) {
    const [row] = await db.select({ lockedUntil: loginAttempts.lockedUntil }).from(loginAttempts).where(eq(loginAttempts.scope, scope)).limit(1);
    if (row?.lockedUntil && row.lockedUntil > now && (!until || row.lockedUntil > until)) until = row.lockedUntil;
  }
  return until;
}

export async function recordLoginFailure(db: AppDb, ip: string, username: string, now = new Date()) {
  const keys = scopes(ip, username);
  for (const [kind, scope] of Object.entries(keys) as Array<[keyof typeof LIMITS, string]>) {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(loginAttempts).where(eq(loginAttempts.scope, scope)).for('update');
      const windowExpired = !row || now.getTime() - row.windowStartedAt.getTime() >= LOGIN_WINDOW_MS;
      const failures = windowExpired ? 1 : row.failures + 1;
      const windowStartedAt = windowExpired ? now : row.windowStartedAt;
      const lockedUntil = failures >= LIMITS[kind] ? new Date(now.getTime() + LOGIN_LOCK_MS) : (row?.lockedUntil ?? null);
      if (row) {
        await tx.update(loginAttempts).set({ failures: failures >= LIMITS[kind] ? 0 : failures, windowStartedAt: failures >= LIMITS[kind] ? now : windowStartedAt, lockedUntil })
          .where(eq(loginAttempts.scope, scope));
      } else {
        await tx.insert(loginAttempts).values({ scope, failures, windowStartedAt, lockedUntil })
          .onDuplicateKeyUpdate({ set: { failures: 1, windowStartedAt: now } });
      }
    });
  }
}

export async function clearLoginFailures(db: AppDb, ip: string, username: string) {
  await db.delete(loginAttempts).where(eq(loginAttempts.scope, scopes(ip, username).pair));
}
