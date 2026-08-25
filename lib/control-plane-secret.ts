import { isSelfHosted } from '@/db';

export async function controlPlaneEncryptionSecret() {
  if (isSelfHosted()) return process.env.PULSEDNS_TASK_ENCRYPTION_KEY?.trim() ?? '';
  const { env } = await import('cloudflare:workers');
  return env.PULSEDNS_TASK_ENCRYPTION_KEY?.trim() ?? '';
}
