import { eq } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { aliyunAccounts, domains } from '@/db/schema';
import { verifyAliDnsDomain, verifyAliyunKey } from '@/lib/alidns';
import { encryptAliyunSecret, listAccounts, maskAccessKeyId, validAccessKeyId, validAccessKeySecret } from '@/lib/aliyun-accounts';
import { cleanText } from '@/lib/validation';

// 阿里云账号：名称 + AccessKey。Secret 只写入、加密保存，任何接口都不会返回。

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  await ensureSchema();
  return Response.json(await listAccounts(await getDb()), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = cleanText(body?.name, 40);
  const accessKeyId = typeof body?.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
  const accessKeySecret = typeof body?.accessKeySecret === 'string' ? body.accessKeySecret.trim() : '';
  if (!name) return Response.json({ error: '请填写账号名称' }, { status: 400 });
  if (!validAccessKeyId(accessKeyId)) return Response.json({ error: 'AccessKey ID 格式无效' }, { status: 400 });
  if (!validAccessKeySecret(accessKeySecret)) return Response.json({ error: 'AccessKey Secret 格式无效' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const [existing] = await db.select({ id: aliyunAccounts.id }).from(aliyunAccounts).where(eq(aliyunAccounts.name, name)).limit(1);
  if (existing) return Response.json({ error: `账号名称 ${name} 已经存在` }, { status: 409 });
  const verified = await verifyAliyunKey({ accessKeyId, accessKeySecret, securityToken: undefined });
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  const id = crypto.randomUUID();
  const now = new Date();
  const inserted = await db.insert(aliyunAccounts).values({
    id, name, accessKeyId, secretCiphertext: await encryptAliyunSecret(accessKeySecret, id), createdAt: now, updatedAt: now,
  }).onConflictDoNothing().returning({ id: aliyunAccounts.id });
  if (!inserted.length) return Response.json({ error: `账号名称 ${name} 已经存在` }, { status: 409 });
  return Response.json({ account: { id, name, accessKeyId: maskAccessKeyId(accessKeyId), createdAt: now.toISOString() } }, { status: 201 });
}

// 更换账号的 AccessKey：新 Key 必须能管理该账号下已绑定的全部主域名。
export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  const accessKeyId = typeof body?.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
  const accessKeySecret = typeof body?.accessKeySecret === 'string' ? body.accessKeySecret.trim() : '';
  if (!id) return Response.json({ error: '缺少账号' }, { status: 400 });
  if (!validAccessKeyId(accessKeyId)) return Response.json({ error: 'AccessKey ID 格式无效' }, { status: 400 });
  if (!validAccessKeySecret(accessKeySecret)) return Response.json({ error: 'AccessKey Secret 格式无效' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const [account] = await db.select({ id: aliyunAccounts.id }).from(aliyunAccounts).where(eq(aliyunAccounts.id, id)).limit(1);
  if (!account) return Response.json({ error: '阿里云账号不存在' }, { status: 404 });
  const credentials = { accessKeyId, accessKeySecret, securityToken: undefined };
  const verified = await verifyAliyunKey(credentials);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  const bound = await db.select({ name: domains.name }).from(domains).where(eq(domains.accountId, id));
  for (const domain of bound) {
    const checked = await verifyAliDnsDomain(credentials, domain.name);
    if (!checked.ok) return Response.json({ error: `新 Key 未保存：${checked.error}` }, { status: 400 });
  }
  await db.update(aliyunAccounts).set({ accessKeyId, secretCiphertext: await encryptAliyunSecret(accessKeySecret, id), updatedAt: new Date() })
    .where(eq(aliyunAccounts.id, id));
  return Response.json({ status: 'ok', accessKeyId: maskAccessKeyId(accessKeyId) });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id) return Response.json({ error: '缺少账号' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  const [used] = await db.select({ name: domains.name }).from(domains).where(eq(domains.accountId, id)).limit(1);
  if (used) return Response.json({ error: `主域名 ${used.name} 正在使用这个账号，请先把它改到其他账号或删除` }, { status: 409 });
  const deleted = await db.delete(aliyunAccounts).where(eq(aliyunAccounts.id, id)).returning({ id: aliyunAccounts.id });
  if (!deleted.length) return Response.json({ error: '阿里云账号不存在' }, { status: 404 });
  return Response.json({ status: 'ok' });
}
