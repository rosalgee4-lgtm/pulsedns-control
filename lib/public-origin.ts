export function publicOrigin(request: Request) {
  const configured = process.env.PULSEDNS_PUBLIC_URL?.trim();
  if (!configured) return new URL(request.url).origin;
  try {
    const url = new URL(configured);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
      return url.origin;
    }
  } catch {
    // Installation validates this value; fall back safely if an operator edits it incorrectly.
  }
  return new URL(request.url).origin;
}
