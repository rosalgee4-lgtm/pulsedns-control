import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

// 密码只保存 scrypt 加盐哈希：scrypt$N$r$p$盐$哈希（base64url）。无法还原，只能重置。
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n > 1 << 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, Buffer.from(parts[4], 'base64url'), n, r, p);
  return timingSafeEqual(actual, expected);
}

// 与登录时比对用的假哈希：用户名不存在时也做一次同等耗时的计算，避免按耗时探测用户名。
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export function validUsername(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(value);
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && !/[\r\n]/.test(value);
}
