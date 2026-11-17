import { asc, eq } from 'drizzle-orm';
import type { AppDb } from '@/db';
import { aliyunAccounts, domains, users } from '@/db/schema';
import type { CurrentUser } from '@/lib/auth';
import { controlPlaneEncryptionSecret } from '@/lib/control-plane-secret';

export type AliDnsCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
};

const encoder = new TextEncoder();

// 与阿里云 AccessKey 的字符集保持一致。
export function validAccessKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{8,128}$/.test(value);
}

export function validAccessKeySecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{8,256}$/.test(value);
}

// 页面只显示头尾几位：输入之后不再回显完整的 AccessKey ID 与 Secret。
export function maskKey(value: string) {
  if (value.length <= 8) return `${value.slice(0, 1)}****${value.slice(-1)}`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export async function accountCredentials(db: AppDb, accountId: string): Promise<AliDnsCredentials> {
  const [account] = await db.select({ id: aliyunAccounts.id, keyCiphertext: aliyunAccounts.keyCiphertext }).from(aliyunAccounts).where(eq(aliyunAccounts.id, accountId)).limit(1);
  if (!account) throw new Error('主域名绑定的阿里云账号不存在');
  return decryptAliyunKey(account.keyCiphertext, account.id);
}

export async function domainCredentials(db: AppDb, domainName: string): Promise<AliDnsCredentials> {
  const [domain] = await db.select({ accountId: domains.accountId }).from(domains).where(eq(domains.name, domainName)).limit(1);
  if (!domain) throw new Error(`主域名 ${domainName} 不在「阿里云主域名」列表中`);
  return accountCredentials(db, domain.accountId);
}

// 管理员看到全部账号（并显示所属用户），普通用户只看到自己的。
export async function listAccounts(db: AppDb, user: CurrentUser) {
  const query = db.select({
    id: aliyunAccounts.id,
    ownerId: aliyunAccounts.ownerId,
    ownerName: users.username,
    name: aliyunAccounts.name,
    accessKeyId: aliyunAccounts.accessKeyIdHint,
    accessKeySecret: aliyunAccounts.accessKeySecretHint,
    createdAt: aliyunAccounts.createdAt,
  }).from(aliyunAccounts).innerJoin(users, eq(aliyunAccounts.ownerId, users.id));
  const rows = await (user.role === 'admin' ? query : query.where(eq(aliyunAccounts.ownerId, user.id))).orderBy(asc(aliyunAccounts.name));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function encryptAliyunKey(credentials: AliDnsCredentials, accountId: string) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ id: credentials.accessKeyId, secret: credentials.accessKeySecret }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(accountId) }, key, plaintext);
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptAliyunKey(value: string, accountId: string): Promise<AliDnsCredentials> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('阿里云账号密钥格式无效');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(parts[1]), additionalData: aad(accountId) }, await encryptionKey(), fromBase64Url(parts[2]));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { id?: unknown; secret?: unknown };
  if (!validAccessKeyId(parsed.id) || !validAccessKeySecret(parsed.secret)) throw new Error('阿里云账号密钥内容无效');
  return { accessKeyId: parsed.id, accessKeySecret: parsed.secret };
}

async function encryptionKey() {
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('主控缺少 PULSEDNS_TASK_ENCRYPTION_KEY，无法安全保存阿里云 AccessKey');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`PulseDNS:aliyun-accounts:v2:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(accountId: string) {
  return encoder.encode(`aliyun_account_v2\n${accountId}`);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('阿里云账号密钥格式无效');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}
