import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { settings } from '@/db/schema';

const MULTI_USER_KEY = 'multi_user_enabled';

// 默认关闭：只有管理员可以登录。
export async function multiUserEnabled(db: AppDb) {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MULTI_USER_KEY)).limit(1);
  return row?.value === '1';
}

export async function setMultiUserEnabled(db: AppDb, enabled: boolean) {
  const now = new Date();
  await db.insert(settings).values({ key: MULTI_USER_KEY, value: enabled ? '1' : '0', updatedAt: now })
    .onDuplicateKeyUpdate({ set: { value: enabled ? '1' : '0', updatedAt: now } });
}
