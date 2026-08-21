import { eq } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes } from '@/db/schema';
import { newAgentToken, sha256 } from '@/lib/security';
import { cleanText, normalizeDnsRr, normalizeDomainName, validDnsRr, validDomainName } from '@/lib/validation';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = cleanText(body?.name, 60);
  const region = cleanText(body?.region, 40) || 'unknown';
  const domainName = normalizeDomainName(body?.domainName) || null;
  const recordV4 = normalizeDnsRr(body?.recordV4) || null;
  const recordV6 = normalizeDnsRr(body?.recordV6) || null;
  if (!name) return Response.json({ error: '节点名称不能为空' }, { status: 400 });
  if ((recordV4 || recordV6) && !domainName) return Response.json({ error: '配置 DNS 记录时必须填写阿里云主域名' }, { status: 400 });
  if (domainName && !validDomainName(domainName)) return Response.json({ error: '主域名格式无效，请填写 example.com 形式的域名' }, { status: 400 });
  if (recordV4 && !validDnsRr(recordV4)) return Response.json({ error: 'IPv4 主机记录格式无效' }, { status: 400 });
  if (recordV6 && !validDnsRr(recordV6)) return Response.json({ error: 'IPv6 主机记录格式无效' }, { status: 400 });

  await ensureSchema();
  const db = getDb();
  const token = newAgentToken();
  const now = new Date();
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(nodes).values({ id, name, region, tokenHash: await sha256(token), provider: 'alidns', domainName, recordV4, recordV6, createdAt: now, updatedAt: now }),
    db.insert(events).values({ nodeId: id, kind: 'node_created', message: `${user.email} 创建了节点`, createdAt: now }),
  ]);

  const origin = new URL(request.url).origin;
  const installCommand = `( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellArg(`${origin}/install.sh`)} -o "$tmp" && sudo bash "$tmp" ddns --server ${shellArg(origin)} --token ${shellArg(token)} )`;
  return Response.json({ node: { id, name, region }, token, installCommand }, { status: 201 });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: '缺少节点 ID' }, { status: 400 });
  await ensureSchema();
  await getDb().delete(nodes).where(eq(nodes.id, id));
  return Response.json({ status: 'ok' });
}

function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
