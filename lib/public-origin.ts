export function publicOrigin(request: Request) {
  const configured = process.env.PULSEDNS_PUBLIC_URL?.trim();
  if (!configured) return new URL(request.url).origin;
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
  return new URL(request.url).origin;
}
