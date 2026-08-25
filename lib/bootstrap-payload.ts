import { controlPlaneEncryptionSecret } from '@/lib/control-plane-secret';
import { parseNyanpassArgs } from '@/lib/nyanpass-command';
import type { ProvisionedNyanpassInstance } from '@/lib/install-command';

export type BootstrapPayload = {
  protocol: 1;
  agentToken: string;
  rootPassword: string;
  instances: ProvisionedNyanpassInstance[];
};

type BootstrapContext = {
  nodeId: string;
  generation: number;
};

const encoder = new TextEncoder();

export async function encryptBootstrapPayload(payload: BootstrapPayload, context: BootstrapContext) {
  validatePayload(payload);
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('主控缺少 PULSEDNS_TASK_ENCRYPTION_KEY，无法安全保存开机脚本凭据');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(context) },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(payload)),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptBootstrapPayload(value: string, context: BootstrapContext): Promise<BootstrapPayload> {
  const secret = await controlPlaneEncryptionSecret();
  if (!secret) throw new Error('开机脚本凭据密钥不可用');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('开机脚本凭据格式无效');
  const iv = fromBase64Url(parts[1]);
  const ciphertext = fromBase64Url(parts[2]);
  if (iv.length !== 12 || !ciphertext.length) throw new Error('开机脚本凭据格式无效');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad(context) },
    await encryptionKey(secret),
    ciphertext,
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  validatePayload(payload);
  return payload;
}

function validatePayload(value: unknown): asserts value is BootstrapPayload {
  if (!value || typeof value !== 'object') throw new Error('开机脚本凭据内容无效');
  const payload = value as Partial<BootstrapPayload>;
  if (payload.protocol !== 1 || typeof payload.agentToken !== 'string' || !/^pd_[a-f0-9]{64}$/.test(payload.agentToken)) {
    throw new Error('开机脚本凭据内容无效');
  }
  if (typeof payload.rootPassword !== 'string' || payload.rootPassword.length < 8 || payload.rootPassword.length > 128
    || /[\x00-\x1f\x7f]/.test(payload.rootPassword)) {
    throw new Error('开机脚本凭据内容无效');
  }
  if (!Array.isArray(payload.instances) || payload.instances.length < 1 || payload.instances.length > 16) {
    throw new Error('开机脚本凭据内容无效');
  }
  const names = new Set<string>();
  for (const instance of payload.instances) {
    if (!instance || typeof instance !== 'object' || typeof instance.name !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(instance.name) || names.has(instance.name)
      || typeof instance.optimize !== 'boolean' || typeof instance.args !== 'string') {
      throw new Error('开机脚本凭据内容无效');
    }
    const parsed = parseNyanpassArgs(instance.args);
    if (!parsed.ok || parsed.args !== instance.args) throw new Error('开机脚本凭据内容无效');
    names.add(instance.name);
  }
}

async function encryptionKey(secret: string) {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`PulseDNS:bootstrap-links:v1:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(context: BootstrapContext) {
  return encoder.encode(`pulsedns_bootstrap_v1\n${context.nodeId}\n${context.generation}`);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('开机脚本凭据格式无效');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
