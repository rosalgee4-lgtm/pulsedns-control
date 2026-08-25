import { controlPlaneEncryptionSecret } from '@/lib/control-plane-secret';

type CredentialContext = {
  nodeId: string;
  instanceId: string;
  revision: number;
};

const encoder = new TextEncoder();

export async function encryptNyanpassCredential(token: string, context: CredentialContext) {
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('主控缺少 PULSEDNS_TASK_ENCRYPTION_KEY，无法安全保存同步凭据');
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, key, encoder.encode(token));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptNyanpassCredential(value: string, context: CredentialContext) {
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('同步凭据密钥不可用');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('同步凭据格式无效');
  const iv = fromBase64Url(parts[1]);
  const ciphertext = fromBase64Url(parts[2]);
  if (iv.length !== 12 || !ciphertext.length) throw new Error('同步凭据格式无效');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, await encryptionKey(secret), ciphertext);
  const token = new TextDecoder().decode(plaintext);
  if (!/^[A-Za-z0-9._:-]{8,512}$/.test(token)) throw new Error('同步凭据内容无效');
  return token;
}

async function encryptionKey(secret: string) {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`PulseDNS:Nyanpass:tasks:v1:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(context: CredentialContext) {
  return encoder.encode(`nyanpass_apply_v1\n${context.nodeId}\n${context.instanceId}\n${context.revision}`);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('同步凭据格式无效');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
