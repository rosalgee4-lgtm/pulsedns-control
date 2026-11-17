import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { sessions } from '@/db/schema';
import { requestIsHttps, sameOriginRequest, sessionCookie, sessionTokenFromRequest } from '@/lib/auth';
import { sha256 } from '@/lib/security';

export async function POST(request: Request) {
  if (!sameOriginRequest(request.headers)) return Response.json({ error: '拒绝跨站请求' }, { status: 403 });
  const token = sessionTokenFromRequest(request);
  if (token && /^ps_[a-f0-9]{64}$/.test(token)) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
  }
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', requestIsHttps(request.headers, request.url), 0) } });
}
