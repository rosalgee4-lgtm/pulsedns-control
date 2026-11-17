import { join } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { count } from 'drizzle-orm';
import { getDb } from './index';
import { users } from './schema';
import { hashPassword, validPassword, validUsername } from '@/lib/passwords';

let initialized = false;
let initialization: Promise<void> | null = null;

// 启动后第一次访问数据库时：执行未应用的迁移；如果还没有任何账号，
// 用 PULSEDNS_INITIAL_ADMIN_USER / PULSEDNS_INITIAL_ADMIN_PASSWORD 创建管理员（只保存哈希）。
export async function ensureSchema() {
  if (initialized) return;
  if (initialization) return initialization;
  initialization = initializeSchema();
  try {
    await initialization;
    initialized = true;
  } finally {
    initialization = null;
  }
}

// 启动时检查关键配置，配置错误时给出明确提示，而不是在运行中途失败。
function validateEnvironment() {
  const key = process.env.PULSEDNS_TASK_ENCRYPTION_KEY?.trim() ?? '';
  if (key.length < 32) throw new Error('PULSEDNS_TASK_ENCRYPTION_KEY 至少 32 个字符（建议 openssl rand -hex 32 生成）');
  const publicUrl = process.env.PULSEDNS_PUBLIC_URL?.trim();
  if (publicUrl && !publicUrl.startsWith('https://') && process.env.PULSEDNS_ALLOW_HTTP !== '1') {
    throw new Error('PULSEDNS_PUBLIC_URL 必须是 https:// 地址（由宝塔等反向代理提供 HTTPS）');
  }
}

async function initializeSchema() {
  validateEnvironment();
  const db = await getDb();
  await migrate(db, { migrationsFolder: process.env.PULSEDNS_MIGRATIONS_DIR || join(process.cwd(), 'drizzle') });
  const [{ total }] = await db.select({ total: count() }).from(users);
  if (total > 0) return;
  const username = process.env.PULSEDNS_INITIAL_ADMIN_USER?.trim() ?? '';
  const password = process.env.PULSEDNS_INITIAL_ADMIN_PASSWORD ?? '';
  if (!validUsername(username) || !validPassword(password)) {
    throw new Error('数据库里还没有管理员：请设置 PULSEDNS_INITIAL_ADMIN_USER 与 PULSEDNS_INITIAL_ADMIN_PASSWORD（12-128 位）后重启');
  }
  const now = new Date();
  await db.insert(users).values({
    id: crypto.randomUUID(),
    username,
    role: 'admin',
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  }).catch(async (error) => {
    // 多个进程同时启动时只有一个能创建成功。
    const [{ total: after }] = await db.select({ total: count() }).from(users);
    if (after === 0) throw error;
  });
}
