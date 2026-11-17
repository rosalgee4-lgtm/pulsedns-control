import { ensureSchema } from '@/db/init';
import { requireApiUser } from '@/lib/auth';
import { EVENT_PAGE_SIZE, listEvents } from '@/lib/dashboard-data';

// 事件记录页「加载更多」：返回 before（事件 id）之前更早的一页，范围与权限同控制台。
export async function GET(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const before = Number(new URL(request.url).searchParams.get('before'));
  if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: '缺少有效的 before 参数' }, { status: 400 });
  const events = await listEvents(db, user, EVENT_PAGE_SIZE + 1, before);
  return Response.json({ events: events.slice(0, EVENT_PAGE_SIZE), hasMore: events.length > EVENT_PAGE_SIZE }, { headers: { 'Cache-Control': 'no-store' } });
}
