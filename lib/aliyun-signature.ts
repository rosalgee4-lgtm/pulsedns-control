const encoder = new TextEncoder();

export const ACS3_ALGORITHM = 'ACS3-HMAC-SHA256';

export function rfc3986Encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalizeQuery(parameters: Record<string, string>) {
  return Object.entries(parameters)
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export async function sha256Hex(value: string) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function signAliyunRpcRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  action: string;
  version: string;
  host: string;
  date: string;
  nonce: string;
  parameters: Record<string, string>;
  securityToken?: string;
}) {
  const bodyHash = await sha256Hex('');
  const canonicalQuery = canonicalizeQuery(input.parameters);
  const signedHeaderValues: Record<string, string> = {
    host: input.host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': bodyHash,
    'x-acs-date': input.date,
    'x-acs-signature-nonce': input.nonce,
    'x-acs-version': input.version,
  };
  if (input.securityToken) signedHeaderValues['x-acs-security-token'] = input.securityToken;

  const headerNames = Object.keys(signedHeaderValues).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${signedHeaderValues[name].trim()}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');
  const stringToSign = `${ACS3_ALGORITHM}\n${await sha256Hex(canonicalRequest)}`;
  const signature = await hmacSha256Hex(input.accessKeySecret, stringToSign);

  return {
    authorization: `${ACS3_ALGORITHM} Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    bodyHash,
    canonicalQuery,
    signedHeaders,
  };
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
