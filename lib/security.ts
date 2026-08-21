export async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newAgentToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `pd_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function bearerToken(header: string | null) {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 32 ? token : null;
}
