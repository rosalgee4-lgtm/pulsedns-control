export function validIPv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function validIPv6(value: unknown): value is string {
  if (typeof value !== 'string' || !value.includes(':') || value.length > 45) return false;
  return /^[0-9a-fA-F:]+$/.test(value) && value.split('::').length <= 2;
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
