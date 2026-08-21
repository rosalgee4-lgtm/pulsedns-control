import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = new Set([
  '/api/v1/report',
  '/favicon.svg',
  '/install.sh',
  '/monitor.sh',
  '/og.png',
  '/update.sh',
]);

export function proxy(request: NextRequest) {
  const localUser = process.env.PULSEDNS_ADMIN_USER;
  const localPassword = process.env.PULSEDNS_ADMIN_PASSWORD;
  if (process.env.PULSEDNS_SELF_HOSTED !== '1' || !localUser || !localPassword) {
    return NextResponse.next();
  }

  // Only the configured random base path is protected. Requests to the bare
  // IP:port must remain a plain 404 and must not reveal the login challenge.
  if (!request.nextUrl.basePath) return NextResponse.next();
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith('/_next/') || PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const credentials = decodeBasicAuthorization(request.headers.get('authorization'));
  if (credentials && secureEqual(credentials.user, localUser) && secureEqual(credentials.password, localPassword)) {
    return NextResponse.next();
  }

  return new Response('PulseDNS 管理员登录', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="PulseDNS", charset="UTF-8"',
    },
  });
}

function decodeBasicAuthorization(value: string | null): { user: string; password: string } | null {
  if (!value?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(value.slice(6));
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
