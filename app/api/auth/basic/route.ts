import { getChatGPTUser } from '@/app/chatgpt-auth';

export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('return_to'));
  const user = await getChatGPTUser();
  if (user) return Response.redirect(new URL(returnTo, request.url));

  return new Response('PulseDNS 管理员登录', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="PulseDNS", charset="UTF-8"',
    },
  });
}

function safeReturnTo(value: string | null) {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://panel.local');
    return url.origin === 'https://panel.local' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}
