import { and, eq, isNotNull } from 'drizzle-orm';
import { affectedRows, type AppDb } from '@/db';
import { events, nodes } from '@/db/schema';
import { compareVersions, supportsRemoteUpgrade } from '@/lib/agent-version';
import { PROBE_AGENT_VERSION } from '@/lib/install-command';

// 远程升级探针：面板只下发固定的 agent_upgrade_v1 任务（公共安装器的固定 commit 地址 + SHA-256），
// 探针校验后在独立的 systemd 临时单元中执行 agent-upgrade；探针以新版本重新轮询即视为完成。

export const AGENT_UPGRADE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
export const AGENT_UPGRADE_RUN_TIMEOUT_MS = 20 * 60 * 1000;

export const agentUpgradeFailureMessages: Record<string, string> = {
  validation_failed: '探针拒绝了升级任务参数',
  installer_download: '探针下载公共安装器失败',
  installer_invalid: '下载的公共安装器未通过校验',
  launch_failed: '探针无法启动独立的升级单元',
};

export { compareVersions, supportsRemoteUpgrade };

export function upgradeAvailable(version: string | null | undefined) {
  return compareVersions(version, PROBE_AGENT_VERSION) < 0;
}

// 结束已完成、超时的远程升级，并写入事件。nodeId 为空时检查全部节点。
export async function settleAgentUpgrades(db: AppDb, now: Date, nodeId?: string) {
  const rows = await db.select({
    id: nodes.id,
    agentVersion: nodes.agentVersion,
    upgradeId: nodes.agentUpgradeId,
    status: nodes.agentUpgradeStatus,
    target: nodes.agentUpgradeTargetVersion,
    requestedAt: nodes.agentUpgradeRequestedAt,
    startedAt: nodes.agentUpgradeStartedAt,
  }).from(nodes).where(and(isNotNull(nodes.agentUpgradeId), nodeId ? eq(nodes.id, nodeId) : undefined));
  for (const row of rows) {
    if (!row.upgradeId) continue;
    const target = row.target ?? PROBE_AGENT_VERSION;
    if (compareVersions(row.agentVersion, target) >= 0) {
      await finishAgentUpgrade(db, row.id, row.upgradeId, now, 'info', 'agent_upgrade_succeeded', `探针已升级到 v${row.agentVersion}`);
    } else if (row.status === 'queued' && row.requestedAt && now.getTime() - row.requestedAt.getTime() >= AGENT_UPGRADE_CLAIM_TIMEOUT_MS) {
      await finishAgentUpgrade(db, row.id, row.upgradeId, now, 'error', 'agent_upgrade_failed', '探针 5 分钟内没有领取升级任务，已取消；请确认探针在线后重试');
    } else if (row.status === 'running' && row.startedAt && now.getTime() - row.startedAt.getTime() >= AGENT_UPGRADE_RUN_TIMEOUT_MS) {
      await finishAgentUpgrade(db, row.id, row.upgradeId, now, 'error', 'agent_upgrade_failed', `探针 20 分钟内没有以 v${target} 重新上线；请到机器上查看 /var/log/ddns-monitor.log 或 journalctl -u pulsedns-agent-upgrade-*`);
    }
  }
}

export async function finishAgentUpgrade(db: AppDb, nodeId: string, upgradeId: string, now: Date, level: 'info' | 'error', kind: string, message: string) {
  const cleared = await db.update(nodes).set({
    agentUpgradeId: null,
    agentUpgradeStatus: null,
    agentUpgradeTargetVersion: null,
    agentUpgradeRequestedAt: null,
    agentUpgradeStartedAt: null,
  }).where(and(eq(nodes.id, nodeId), eq(nodes.agentUpgradeId, upgradeId)));
  if (!affectedRows(cleared)) return false;
  await db.insert(events).values({ nodeId, level, kind, message, createdAt: now }).catch(() => undefined);
  return true;
}
