import { and, eq } from 'drizzle-orm';
import type { getDb } from '@/db';
import { nodes, nyanpassInstances } from '@/db/schema';
import { decryptBootstrapPayload, encryptBootstrapPayload } from '@/lib/bootstrap-payload';

type AppDb = Awaited<ReturnType<typeof getDb>>;

const MAX_REINSTALL_INSTANCES = 16;

// 节点的加密开机配置同时是「换机重装计划」：Spot 实例被替换后，新机器按这份
// 列表无人值守安装全部 Nyanpass 实例。后来通过「同步到机器」追加或修改并安装
// 成功的实例会写入这里；移除登记的实例会从这里删除。调用方需持有节点操作锁。

export function reinstallArgs(role: 'inbound' | 'outbound', clientToken: string, panelUrl: string) {
  // 与探针远程同步写入 start.sh 的参数保持一致。
  return `${role === 'outbound' ? '-o ' : ''}-t ${clientToken} -u ${panelUrl}`;
}

export async function upsertReinstallInstance(db: AppDb, nodeId: string, instanceId: string, name: string, args: string) {
  return updatePlan(db, nodeId, instanceId, (instances) => {
    const index = instances.findIndex((instance) => instance.name === name);
    if (index >= 0) {
      instances[index] = { name, optimize: false, args };
      return instances;
    }
    if (instances.length >= MAX_REINSTALL_INSTANCES) return null;
    return [...instances, { name, optimize: false, args }];
  });
}

export async function removeReinstallInstance(db: AppDb, nodeId: string, name: string) {
  return updatePlan(db, nodeId, null, (instances) => {
    const remaining = instances.filter((instance) => instance.name !== name);
    // 开机配置至少保留一个实例；只剩这一个时保留原计划，避免新机器无法安装。
    if (remaining.length === instances.length || !remaining.length) return null;
    return remaining;
  });
}

async function updatePlan(
  db: AppDb,
  nodeId: string,
  instanceId: string | null,
  change: (instances: Array<{ name: string; optimize: boolean; args: string }>) => Array<{ name: string; optimize: boolean; args: string }> | null,
) {
  const [node] = await db.select({
    ciphertext: nodes.bootstrapPayloadCiphertext,
    generation: nodes.provisionGeneration,
  }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  // 旧版本已擦除开机凭据的节点没有重装计划，保持原样。
  if (!node?.ciphertext) return false;
  const context = { nodeId, generation: node.generation };
  const payload = await decryptBootstrapPayload(node.ciphertext, context);
  const instances = change(payload.instances.map((instance) => ({ ...instance })));
  if (!instances) return false;
  const ciphertext = await encryptBootstrapPayload({ ...payload, instances }, context);
  const updated = await db.update(nodes).set({ bootstrapPayloadCiphertext: ciphertext })
    .where(and(eq(nodes.id, nodeId), eq(nodes.bootstrapPayloadCiphertext, node.ciphertext)))
    .returning({ id: nodes.id });
  if (!updated.length) return false;
  if (instanceId) {
    await db.update(nyanpassInstances).set({ bootstrapGeneration: node.generation })
      .where(and(eq(nyanpassInstances.id, instanceId), eq(nyanpassInstances.nodeId, nodeId)));
  }
  return true;
}
