export function publicOrigin(request: Request) {
  const configured = process.env.PULSEDNS_PUBLIC_URL?.trim();
  const requestOrigin = new URL(request.url).origin;
  if (!configured) return `${requestOrigin}${selfHostedBasePath()}`;
  try {
    const url = new URL(configured);
    const selfHostedHttp = process.env.PULSEDNS_SELF_HOSTED === '1' && url.protocol === 'http:';
    if ((url.protocol === 'https:' || selfHostedHttp) && !url.username && !url.password && !url.search && !url.hash) {
      const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
      return `${url.origin}${pathname}`;
    }
  } catch {
    // Installation validates this value; fall back safely if an operator edits it incorrectly.
  }
  return `${requestOrigin}${selfHostedBasePath()}`;
}

function selfHostedBasePath() {
  if (process.env.PULSEDNS_SELF_HOSTED !== '1') return '';
  const value = process.env.PULSEDNS_BASE_PATH?.trim() ?? '';
  return /^\/[a-f0-9]{32}$/.test(value) ? value : '';
}
