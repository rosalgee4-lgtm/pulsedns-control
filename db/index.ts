import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import type { AsyncBatchRemoteCallback, RemoteCallback } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

type AppDb = ReturnType<typeof drizzleD1<typeof schema>>;
type LocalSqlite = import('node:sqlite').DatabaseSync;
type SqliteInputValue = import('node:sqlite').SQLInputValue;
type RemoteResult = Awaited<ReturnType<RemoteCallback>>;

let cachedDb: AppDb | null = null;
let localSqlite: LocalSqlite | null = null;

export function isSelfHosted() {
  return process.env.PULSEDNS_SELF_HOSTED === '1';
}

export async function getDb(): Promise<AppDb> {
  if (cachedDb) return cachedDb;

  if (isSelfHosted()) {
    const sqlite = await getLocalSqlite();
    const executeSync = (query: string, params: unknown[], method: 'run' | 'all' | 'values' | 'get'): RemoteResult => {
      const statement = sqlite.prepare(query);
      const sqliteParams = params as SqliteInputValue[];
      if (method === 'run') {
        const result = statement.run(...sqliteParams);
        return { rows: { changes: result.changes, lastInsertRowid: result.lastInsertRowid } } as unknown as RemoteResult;
      }
      statement.setReturnArrays(true);
      if (method === 'get') return { rows: statement.get(...sqliteParams) } as unknown as RemoteResult;
      return { rows: statement.all(...sqliteParams) } as RemoteResult;
    };
    const execute: RemoteCallback = async (query, params, method) => executeSync(query, params, method);
    const executeBatch: AsyncBatchRemoteCallback = async (queries) => {
      // DatabaseSync is intentionally executed without an await between BEGIN and
      // COMMIT. Yielding here would let another request enter the same connection
      // and accidentally participate in (or collide with) this transaction.
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: RemoteResult[] = [];
        for (const query of queries) results.push(executeSync(query.sql, query.params, query.method));
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
