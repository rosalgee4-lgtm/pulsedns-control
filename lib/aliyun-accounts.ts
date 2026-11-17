import { asc, eq } from 'drizzle-orm';
import type { getDb } from '@/db';
import { aliyunAccounts, domains } from '@/db/schema';
import { controlPlaneEncryptionSecret } from '@/lib/control-plane-secret';

type AppDb = Awaited<ReturnType<typeof getDb>>;

export type AliDnsCredentials = {
  accessKeyId: string | undefined;
  accessKeySecret: string | undefined;
  securityToken: string | undefined;
};

const encoder = new TextEncoder();

// 与面板安装脚本对 AccessKey 的格式要求保持一致。
export function validAccessKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{8,128}$/.test(value);
}

export function validAccessKeySecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{8,256}$/.test(value);
}

export function maskAccessKeyId(value: string | undefined | null) {
  if (!value) return null;
  return value.length <= 8 ? `${value.slice(0, 2)}****` : `${value.slice(0, 4)}****${value.slice(-4)}`;
}

// 安装面板时填写的全局 AccessKey：作为「默认账号」，未绑定账号的主域名使用它。
export async function defaultAliDnsCredentials(): Promise<AliDnsCredentials> {
  if (process.env.PULSEDNS_SELF_HOSTED === '1') {
    return {
      accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
    };
  }
  const { env } = await import('cloudflare:workers');
  return {
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN,
  };
}

export async function accountCredentials(db: AppDb, accountId: string | null): Promise<AliDnsCredentials> {
  if (!accountId) return defaultAliDnsCredentials();
  const [account] = await db.select().from(aliyunAccounts).where(eq(aliyunAccounts.id, accountId)).limit(1);
  if (!account) throw new Error('主域名绑定的阿里云账号不存在');
  return {
    accessKeyId: account.accessKeyId,
    accessKeySecret: await decryptAliyunSecret(account.secretCiphertext, account.id),
    securityToken: undefined,
  };
}

export async function domainCredentials(db: AppDb, domainName: string): Promise<AliDnsCredentials> {
  const [domain] = await db.select({ accountId: domains.accountId }).from(domains).where(eq(domains.name, domainName)).limit(1);
  return accountCredentials(db, domain?.accountId ?? null);
}

// 列表只返回打码后的 AccessKey ID，Secret 永不返回。
export async function listAccounts(db: AppDb) {
  const rows = await db.select({ id: aliyunAccounts.id, name: aliyunAccounts.name, accessKeyId: aliyunAccounts.accessKeyId, createdAt: aliyunAccounts.createdAt })
    .from(aliyunAccounts).orderBy(asc(aliyunAccounts.name));
  const fallback = await defaultAliDnsCredentials();
  return {
    defaultAccount: { configured: Boolean(fallback.accessKeyId && fallback.accessKeySecret), accessKeyId: maskAccessKeyId(fallback.accessKeyId) },
    accounts: rows.map((row) => ({ id: row.id, name: row.name, accessKeyId: maskAccessKeyId(row.accessKeyId), createdAt: row.createdAt.toISOString() })),
  };
}

export async function encryptAliyunSecret(secret: string, accountId: string) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(accountId) }, key, encoder.encode(secret));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptAliyunSecret(value: string, accountId: string) {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('阿里云账号密钥格式无效');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(parts[1]), additionalData: aad(accountId) }, await encryptionKey(), fromBase64Url(parts[2]));
  return new TextDecoder().decode(plaintext);
}

async function encryptionKey() {
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('主控缺少 PULSEDNS_TASK_ENCRYPTION_KEY，无法安全保存阿里云 AccessKey');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`PulseDNS:aliyun-accounts:v1:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(accountId: string) {
  return encoder.encode(`aliyun_account_v1\n${accountId}`);
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
