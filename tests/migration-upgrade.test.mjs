import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import { createTestDatabase } from './mysql-test-db.mjs';

// 升级已有数据库：先只执行第一版迁移并写入旧数据，再执行全部迁移。
const database = await createTestDatabase('upgrade');
const fullFolder = new URL('../drizzle', import.meta.url).pathname;
const firstOnly = mkdtempSync(join(tmpdir(), 'pulsedns-migrations-'));
cpSync(fullFolder, firstOnly, { recursive: true });
const journal = JSON.parse(readFileSync(join(firstOnly, 'meta/_journal.json'), 'utf8'));
journal.entries = journal.entries.slice(0, 1);
writeFileSync(join(firstOnly, 'meta/_journal.json'), JSON.stringify(journal));
const pool = mysql.createPool({ uri: process.env.PULSEDNS_DATABASE_URL, timezone: 'Z', multipleStatements: false });
const db = drizzle(pool);
after(async () => { await pool.end(); await database.drop(); rmSync(firstOnly, { recursive: true, force: true }); });

test('upgrading an existing database assigns existing Nyanpass instances to their machine owner', async () => {
  await migrate(db, { migrationsFolder: firstOnly });
  const now = new Date();
  await database.query("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES ('u-admin', 'admin', 'admin', 'x', ?, ?), ('u-bob', 'bob', 'user', 'x', ?, ?)", [now, now, now, now]);
  await database.query("INSERT INTO nodes (id, owner_id, name, token_hash, created_at, updated_at) VALUES ('n-1', 'u-admin', 'aws-sg', 'h1', ?, ?), ('n-2', 'u-bob', 'aws-jp', 'h2', ?, ?)", [now, now, now, now]);
  await database.query("INSERT INTO nyanpass_instances (id, node_id, name, panel_url, created_at, updated_at) VALUES ('i-1', 'n-1', 'awsin', 'https://ny.example.test', ?, ?), ('i-2', 'n-2', 'awsout', 'https://ny.example.test', ?, ?)", [now, now, now, now]);

  await migrate(db, { migrationsFolder: fullFolder });
  const rows = await database.query('SELECT id, owner_id AS ownerId FROM nyanpass_instances ORDER BY id');
  assert.deepEqual(rows.map((row) => [row.id, row.ownerId]), [['i-1', 'u-admin'], ['i-2', 'u-bob']]);
  const [column] = await database.query("SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nyanpass_instances' AND COLUMN_NAME = 'owner_id'");
  assert.equal(column.nullable, 'NO');
  const tables = (await database.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('node_shares', 'node_dns_records') ORDER BY TABLE_NAME")).map((row) => row.name);
  assert.deepEqual(tables, ['node_dns_records', 'node_shares']);
});
