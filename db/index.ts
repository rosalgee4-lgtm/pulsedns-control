import { drizzle } from 'drizzle-orm/mysql2';
import type { SQLWrapper } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import * as schema from './schema';

// PulseDNS 只支持外置 MySQL 8 / MariaDB 10.6+，连接串来自 PULSEDNS_DATABASE_URL，
// 例如 mysql://pulsedns:密码@db.example.internal:3306/pulsedns。

function createDb(pool: mysql.Pool) {
  return drizzle(pool, { schema, mode: 'default' });
}

export type AppDb = ReturnType<typeof createDb>;
type Executable = SQLWrapper & PromiseLike<unknown>;

let cached: { pool: mysql.Pool; db: AppDb } | null = null;

export function databaseUrl() {
  const value = process.env.PULSEDNS_DATABASE_URL?.trim();
  if (!value) throw new Error('缺少 PULSEDNS_DATABASE_URL（MySQL / MariaDB 连接串）');
  return value;
}

export async function getDb(): Promise<AppDb> {
  if (cached) return cached.db;
  const pool = mysql.createPool({
    uri: databaseUrl(),
    connectionLimit: Number(process.env.PULSEDNS_DATABASE_POOL_SIZE) || 10,
    // 所有时间都按 UTC 读写，避免数据库与容器时区不一致。
    timezone: 'Z',
    charset: 'utf8mb4',
    // 允许生成列与 FOR UPDATE 等语句；不允许一次执行多条语句。
    multipleStatements: false,
  });
  cached = { pool, db: createDb(pool) };
  return cached.db;
}

export async function closeDb() {
  if (!cached) return;
  const { pool } = cached;
  cached = null;
  await pool.end();
}

// 原先 SQLite / D1 的 db.batch：按顺序在同一个事务里执行，任一条失败整体回滚。
// 返回每条语句影响的行数（MySQL 不支持 RETURNING）。
export async function runInTransaction(db: AppDb, statements: Executable[]) {
  return db.transaction(async (tx) => {
    const results: number[] = [];
    for (const statement of statements) results.push(affectedRows(await tx.execute(statement.getSQL())));
    return results;
  });
}

export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof value === 'number' ? value : 0;
}

export function isDuplicateKeyError(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === 'ER_DUP_ENTRY' || code?.cause?.code === 'ER_DUP_ENTRY';
}
