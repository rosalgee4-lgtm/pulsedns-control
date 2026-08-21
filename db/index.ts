import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

type AppDb = ReturnType<typeof drizzleD1<typeof schema>>;
type LocalSqlite = import('node:sqlite').DatabaseSync;
type ProxyMethod = 'run' | 'all' | 'values' | 'get';
type ProxyResult = { rows: unknown };

let cachedDb: AppDb | null = null;
let localSqlite: LocalSqlite | null = null;

export function isSelfHosted() {
  return process.env.PULSEDNS_SELF_HOSTED === '1';
}

export async function getDb(): Promise<AppDb> {
  if (cachedDb) return cachedDb;

  if (isSelfHosted()) {
    const sqlite = await getLocalSqlite();
    const execute = (query: string, params: unknown[], method: ProxyMethod): ProxyResult => {
      const statement = sqlite.prepare(query);
      if (method === 'run') {
        const result = statement.run(...params);
        return { rows: { changes: result.changes, lastInsertRowid: result.lastInsertRowid } };
      }
      statement.setReturnArrays(true);
      if (method === 'get') return { rows: statement.get(...params) };
      return { rows: statement.all(...params) };
    };
    const executeBatch = (queries: Array<{ sql: string; params: unknown[]; method: ProxyMethod }>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = queries.map((query) => execute(query.sql, query.params, query.method));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    };
    cachedDb = drizzleProxy(execute, executeBatch, { schema }) as unknown as AppDb;
    return cachedDb;
  }

  const [{ env }, { drizzle }] = await Promise.all([
    import('cloudflare:workers'),
    import('drizzle-orm/d1'),
  ]);
  if (!env.DB) throw new Error('Cloudflare D1 binding `DB` is unavailable.');
  cachedDb = drizzle(env.DB, { schema });
  return cachedDb;
}

export async function getLocalSqlite(): Promise<LocalSqlite> {
  if (!isSelfHosted()) throw new Error('Local SQLite is only available in self-hosted mode');
  if (localSqlite) return localSqlite;

  const databasePath = process.env.PULSEDNS_DB_PATH || '/var/lib/pulsedns-control/pulsedns.db';
  await mkdir(dirname(databasePath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  localSqlite = new DatabaseSync(databasePath);
  localSqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return localSqlite;
}
