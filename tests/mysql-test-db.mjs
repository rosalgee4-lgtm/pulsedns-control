// 测试用：在 PULSEDNS_TEST_MYSQL_URL 指向的 MySQL / MariaDB 上为每个测试文件创建一个
// 独立的临时数据库，并设置 PULSEDNS_DATABASE_URL。默认连接本机 13306 端口的测试容器：
//   docker run -d --name pulsedns-mysql-test -e MYSQL_ROOT_PASSWORD=testroot -p 127.0.0.1:13306:3306 mysql:8.4
import mysql from 'mysql2/promise';

export async function createTestDatabase(prefix) {
  const root = process.env.PULSEDNS_TEST_MYSQL_URL || 'mysql://root:testroot@127.0.0.1:13306';
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
  const admin = await mysql.createConnection(root);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  const url = new URL(root);
  url.pathname = `/${name}`;
  process.env.PULSEDNS_DATABASE_URL = url.toString();
  process.env.PULSEDNS_MIGRATIONS_DIR = new URL('../drizzle', import.meta.url).pathname;
  const pool = mysql.createPool({ uri: url.toString(), timezone: 'Z' });
  return {
    name,
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows;
    },
    async drop() {
      await pool.end();
      const cleanup = await mysql.createConnection(root);
      await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await cleanup.end();
    },
  };
}
