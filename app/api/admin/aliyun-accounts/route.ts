import { and, eq } from 'drizzle-orm';
import { ensureSchema } from '@/db/init';
import { affectedRows, isDuplicateKeyError, type AppDb } from '@/db';
import { aliyunAccounts, domains } from '@/db/schema';
import { verifyAliDnsDomain, verifyAliyunKey } from '@/lib/alidns';
import { encryptAliyunKey, listAccounts, maskKey, validAccessKeyId, validAccessKeySecret } from '@/lib/aliyun-accounts';
import { requireApiUser, type CurrentUser } from '@/lib/auth';
import { cleanText } from '@/lib/validation';

// 阿里云账号：AccessKey ID 与 Secret 一起加密保存；接口只返回打码后的头尾几位。

export async function GET(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  return Response.json({ accounts: await listAccounts(auth.db, auth.user) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = cleanText(body?.name, 40);
  const accessKeyId = typeof body?.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
  const accessKeySecret = typeof body?.accessKeySecret === 'string' ? body.accessKeySecret.trim() : '';
  if (!name) return Response.json({ error: '请填写账号名称' }, { status: 400 });
  if (!validAccessKeyId(accessKeyId)) return Response.json({ error: 'AccessKey ID 格式无效' }, { status: 400 });
  if (!validAccessKeySecret(accessKeySecret)) return Response.json({ error: 'AccessKey Secret 格式无效' }, { status: 400 });
  const [existing] = await db.select({ id: aliyunAccounts.id }).from(aliyunAccounts)
    .where(and(eq(aliyunAccounts.ownerId, user.id), eq(aliyunAccounts.name, name))).limit(1);
  if (existing) return Response.json({ error: `账号名称 ${name} 已经存在` }, { status: 409 });
  const credentials = { accessKeyId, accessKeySecret };
  const verified = await verifyAliyunKey(credentials);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(aliyunAccounts).values({
      id, ownerId: user.id, name,
      keyCiphertext: await encryptAliyunKey(credentials, id),
      accessKeyIdHint: maskKey(accessKeyId),
      accessKeySecretHint: maskKey(accessKeySecret),
      createdAt: now, updatedAt: now,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return Response.json({ error: `账号名称 ${name} 已经存在` }, { status: 409 });
    throw error;
  }
  return Response.json({ account: {
    id, ownerId: user.id, ownerName: user.username, name,
    accessKeyId: maskKey(accessKeyId), accessKeySecret: maskKey(accessKeySecret), createdAt: now.toISOString(),
  } }, { status: 201 });
}

// 更换账号的 AccessKey：新 Key 必须能管理该账号下已绑定的全部主域名。
export async function PATCH(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  const accessKeyId = typeof body?.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
  const accessKeySecret = typeof body?.accessKeySecret === 'string' ? body.accessKeySecret.trim() : '';
  if (!id) return Response.json({ error: '缺少账号' }, { status: 400 });
  if (!validAccessKeyId(accessKeyId)) return Response.json({ error: 'AccessKey ID 格式无效' }, { status: 400 });
  if (!validAccessKeySecret(accessKeySecret)) return Response.json({ error: 'AccessKey Secret 格式无效' }, { status: 400 });
  const account = await visibleAccount(db, user, id);
  if (!account) return Response.json({ error: '阿里云账号不存在' }, { status: 404 });
  const credentials = { accessKeyId, accessKeySecret };
  const verified = await verifyAliyunKey(credentials);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: 400 });
  const bound = await db.select({ name: domains.name }).from(domains).where(eq(domains.accountId, id));
  for (const domain of bound) {
    const checked = await verifyAliDnsDomain(credentials, domain.name);
    if (!checked.ok) return Response.json({ error: `新 Key 未保存：${checked.error}` }, { status: 400 });
  }
  await db.update(aliyunAccounts).set({
    keyCiphertext: await encryptAliyunKey(credentials, id),
    accessKeyIdHint: maskKey(accessKeyId),
    accessKeySecretHint: maskKey(accessKeySecret),
    updatedAt: new Date(),
  }).where(eq(aliyunAccounts.id, id));
  return Response.json({ status: 'ok', accessKeyId: maskKey(accessKeyId), accessKeySecret: maskKey(accessKeySecret) });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const auth = await requireApiUser(request);
  if ('response' in auth) return auth.response;
  const { db, user } = auth;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id) return Response.json({ error: '缺少账号' }, { status: 400 });
  if (!await visibleAccount(db, user, id)) return Response.json({ error: '阿里云账号不存在' }, { status: 404 });
  const [used] = await db.select({ name: domains.name }).from(domains).where(eq(domains.accountId, id)).limit(1);
  if (used) return Response.json({ error: `主域名 ${used.name} 正在使用这个账号，请先把它改到其他账号或删除` }, { status: 409 });
  const deleted = await db.delete(aliyunAccounts).where(eq(aliyunAccounts.id, id));
  if (!affectedRows(deleted)) return Response.json({ error: '阿里云账号不存在' }, { status: 404 });
  return Response.json({ status: 'ok' });
}

async function visibleAccount(db: AppDb, user: CurrentUser, id: string) {
  const [account] = await db.select({ id: aliyunAccounts.id, ownerId: aliyunAccounts.ownerId }).from(aliyunAccounts).where(eq(aliyunAccounts.id, id)).limit(1);
  if (!account || (user.role !== 'admin' && account.ownerId !== user.id)) return null;
  return account;
}
