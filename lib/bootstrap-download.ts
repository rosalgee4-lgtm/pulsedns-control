export const BOOTSTRAP_INITIAL_DOWNLOAD_TTL_MS = 30 * 60 * 1000;
export const BOOTSTRAP_DOWNLOAD_RETRY_GRACE_MS = 2 * 60 * 1000;

export function bootstrapDownloadExpiry(now: Date) {
  return new Date(now.getTime() + BOOTSTRAP_INITIAL_DOWNLOAD_TTL_MS);
}

export function bootstrapDownloadWindow(
  expiresAt: Date | null,
  consumedAt: Date | null,
  now: Date,
) {
  if (consumedAt) {
    const allowed = consumedAt.getTime() + BOOTSTRAP_DOWNLOAD_RETRY_GRACE_MS > now.getTime();
    return { allowed, shouldConsume: false } as const;
  }
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, shouldConsume: false } as const;
  }
  return { allowed: true, shouldConsume: true } as const;
}
