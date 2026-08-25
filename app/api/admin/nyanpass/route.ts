import { and, eq, ne } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { ensureSchema } from '@/db/init';
import { events, nodes, nyanpassInstances } from '@/db/schema';
import { parseOfficialNyanpassCommand } from '@/lib/nyanpass-command';
import { publicOrigin } from '@/lib/public-origin';
import { cleanText } from '@/lib/validation';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const nodeId = cleanText(body?.nodeId, 64);
  const name = cleanText(body?.name, 48);
  const optimize = body?.optimize === true || body?.optimize === 'on';
  const parsedCommand = parseOfficialNyanpassCommand(body?.command);
  if (!nodeId) return Response.json({ error: '请选择所属探针节点' }, { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name)) {
    return Response.json({ error: '实例名只能包含字母、数字、点、下划线和短横线' }, { status: 400 });
  }
  if (!parsedCommand.ok) return Response.json({ error: parsedCommand.error }, { status: 400 });

  const { args, panelUrl, role } = parsedCommand;

  await ensureSchema();
  const db = await getDb();
  const [node] = await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  const duplicate = await db.select({ id: nyanpassInstances.id }).from(nyanpassInstances)
    .where(and(eq(nyanpassInstances.nodeId, nodeId), eq(nyanpassInstances.name, name))).limit(1);
  if (duplicate.length) return Response.json({ error: '该节点已经登记了同名实例' }, { status: 409 });

  const id = crypto.randomUUID();
  const now = new Date();
  const roleLabel = role === 'outbound' ? '出口' : '入口';
  await db.batch([
    db.insert(nyanpassInstances).values({ id, nodeId, name, role, panelUrl, createdAt: now, updatedAt: now }),
    db.insert(events).values({ nodeId, kind: 'nyanpass_created', message: `${user.email} 从原命令识别并添加了${roleLabel}实例 ${name}`, createdAt: now }),
  ]);

  const origin = publicOrigin(request);
  const installCommand = `( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellArg(`${origin}/install.sh`)} -o "$tmp" && bash "$tmp" nyanpass --nyanpass-name ${shellArg(name)} --nyanpass-optimize ${shellArg(optimize ? '1' : '0')} --nyanpass-args ${shellArg(args)} --nyanpass-unattended )`;

  return Response.json({
    instance: { id, nodeId, nodeName: node.name, name, role, panelUrl },
    installCommand,
  }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = cleanText(body?.id, 64);
  const name = cleanText(body?.name, 48);
  const hasCommand = typeof body?.command === 'string' && body.command.trim().length > 0;
  const optimize = body?.optimize === true || body?.optimize === 'on';
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name)) {
    return Response.json({ error: '实例名只能包含字母、数字、点、下划线和短横线' }, { status: 400 });
  }

  await ensureSchema();
  const db = await getDb();
  const [current] = await db.select().from(nyanpassInstances).where(eq(nyanpassInstances.id, id)).limit(1);
  if (!current) return Response.json({ error: '实例不存在' }, { status: 404 });
  const [node] = await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, current.nodeId)).limit(1);
  if (!node) return Response.json({ error: '所属节点不存在' }, { status: 404 });
  const duplicate = await db.select({ id: nyanpassInstances.id }).from(nyanpassInstances)
    .where(and(eq(nyanpassInstances.nodeId, current.nodeId), eq(nyanpassInstances.name, name), ne(nyanpassInstances.id, id))).limit(1);
  if (duplicate.length) return Response.json({ error: '该节点已经登记了同名实例' }, { status: 409 });

  let args = '';
  let role = current.role;
  let panelUrl = current.panelUrl;
  if (hasCommand) {
    const parsed = parseOfficialNyanpassCommand(body?.command);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    args = parsed.args;
    role = parsed.role;
    panelUrl = parsed.panelUrl;
  }

  const now = new Date();
  await db.update(nyanpassInstances).set({ name, role, panelUrl, updatedAt: now }).where(eq(nyanpassInstances.id, id));
  const roleLabel = role === 'outbound' ? '出口' : '入口';
  const [updatedEvent] = await db.insert(events).values({
    nodeId: current.nodeId,
    kind: 'nyanpass_updated',
    message: hasCommand
      ? `${user.email} 重新识别并修改了${roleLabel}实例 ${name}`
      : `${user.email} 修改了实例登记名称为 ${name}`,
    createdAt: now,
  }).returning({ id: events.id, nodeId: events.nodeId, level: events.level, kind: events.kind, message: events.message, createdAt: events.createdAt });

  const installCommand = hasCommand
    ? `( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellArg(`${publicOrigin(request)}/install.sh`)} -o "$tmp" && bash "$tmp" nyanpass --nyanpass-name ${shellArg(name)} --nyanpass-optimize ${shellArg(optimize ? '1' : '0')} --nyanpass-args ${shellArg(args)} --nyanpass-unattended )`
    : null;

  return Response.json({
    instance: { id, nodeId: current.nodeId, nodeName: node.name, name, role, panelUrl },
    installCommand,
    event: { ...updatedEvent, nodeName: node.name },
  });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '需要管理员登录' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: '缺少实例 ID' }, { status: 400 });
  await ensureSchema();
  const db = await getDb();
  await db.delete(nyanpassInstances).where(eq(nyanpassInstances.id, id));
  return Response.json({ status: 'ok' });
}

function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
