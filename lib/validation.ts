export function validIPv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) =>
    /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
  );
}

export function validIPv6(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 45 || !value.includes(':')) return false;
  if (value.includes('%') || /\s/.test(value)) return false;

  let address = value;
  const lastColon = address.lastIndexOf(':');
  const ipv4Tail = address.slice(lastColon + 1);
  if (ipv4Tail.includes('.')) {
    if (!validIPv4(ipv4Tail)) return false;
    address = `${address.slice(0, lastColon)}:0:0`;
  } else if (address.includes('.')) {
    return false;
  }

  const compressed = address.includes('::');
  if (compressed && address.indexOf('::') !== address.lastIndexOf('::')) return false;
  if (!compressed && (address.startsWith(':') || address.endsWith(':'))) return false;

  const [left = '', right = ''] = compressed ? address.split('::') : [address, ''];
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const validHextet = (part: string) => /^[0-9a-fA-F]{1,4}$/.test(part);
  if (!leftParts.every(validHextet) || !rightParts.every(validHextet)) return false;

  const hextetCount = leftParts.length + rightParts.length;
  return compressed ? hextetCount < 8 : hextetCount === 8;
}

export function cleanText(value: unknown, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function normalizeDomainName(value: unknown) {
  return cleanText(value, 253).toLowerCase().replace(/\.$/, '');
}

export function validDomainName(value: string) {
  if (!value || value.length > 253 || !value.includes('.')) return false;
  return value.split('.').every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export function normalizeDnsRr(value: unknown) {
  return cleanText(value, 253).toLowerCase().replace(/\.$/, '');
}

export function validDnsRr(value: string) {
  if (value === '@') return true;
  if (!value || value.length > 253) return false;
  return value.split('.').every((label) =>
    label === '*'
    || (label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
  );
}
