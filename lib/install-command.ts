import type { TrustedNyanpassRelease } from '@/lib/nyanpass-release';

export type ProvisionedNyanpassInstance = {
  name: string;
  optimize: boolean;
  args: string;
};

type NodeBootstrapConfigInput = {
  nodeId: string;
  generation: number;
  origin: string;
  token: string;
  rootPassword: string;
  instances: ProvisionedNyanpassInstance[];
  nyanpassRelease: TrustedNyanpassRelease;
};

// 整机 BBR/sysctl 配置：c6in = 10MB 缓冲（原默认），c5in = 50MB 缓冲。
export const BBR_PROFILES = ['c6in', 'c5in'] as const;
export type BbrProfile = (typeof BBR_PROFILES)[number];
export const DEFAULT_BBR_PROFILE: BbrProfile = 'c6in';

export function isBbrProfile(value: unknown): value is BbrProfile {
  return typeof value === 'string' && (BBR_PROFILES as readonly string[]).includes(value);
}

export const PROBE_INSTALLER_URL = 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/740e21c79291ff6eb0c183b0c5a6f7525a30689b/public/install.sh';
export const PROBE_INSTALLER_SHA256 = '80cd13187a6428384c529fcaba05e9606db7c3b171d44190a421c9821e687e9a';
// 上面固定的公共安装器所安装的探针版本；远程升级以探针上报这个版本作为完成标志。
export const PROBE_AGENT_VERSION = '0.9.0';
export const MAX_CLOUD_LAUNCHER_BYTES = 15 * 1024;
export const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;

// 一键安装命令：下载固定 commit 的公共安装器到 /root/<节点名>_<BBR 配置>_install.sh，
// 校验 SHA-256 通过后才 chmod 并执行；文件保留在 /root，之后可以手动再次运行。
export function nodeInstallerPath(nodeName: string, bbrProfile: BbrProfile) {
  const safeName = nodeName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'node';
  return `/root/${safeName}_${bbrProfile}_install.sh`;
}

export function buildNodeConnectCommand(installUrl: string, bbrProfile: BbrProfile, nodeName: string) {
  const path = nodeInstallerPath(nodeName, bbrProfile);
  return `wget -O ${shellArg(path)} ${shellArg(PROBE_INSTALLER_URL)} && echo ${shellArg(`${PROBE_INSTALLER_SHA256}  ${path}`)} | sha256sum -c - && chmod +x ${shellArg(path)} && bash ${shellArg(path)} probe ${shellArg(installUrl)} ${shellArg(bbrProfile)}`;
}

export function buildAgentUpgradeCommand() {
  return buildVerifiedInstallerCommand('agent-upgrade');
}

function buildVerifiedInstallerCommand(args: string) {
  return `( set -eu; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs ${shellArg(PROBE_INSTALLER_URL)} -o "$tmp"; printf '%s  %s\\n' ${shellArg(PROBE_INSTALLER_SHA256)} "$tmp" | sha256sum -c -; bash "$tmp" ${args} )`;
}

export function buildNodeBootstrapConfig({ nodeId, generation, origin, token, rootPassword, instances, nyanpassRelease }: NodeBootstrapConfigInput) {
  const fields = [
    'PULSEDNS_BOOTSTRAP_V1',
    nodeId,
    String(generation),
    origin,
    token,
    rootPassword,
    PROBE_INSTALLER_URL,
    PROBE_INSTALLER_SHA256,
    nyanpassRelease.installerUrl,
    nyanpassRelease.installerSha256,
    nyanpassRelease.binaryBaseUrl,
    nyanpassRelease.binaryRelease,
    nyanpassRelease.binaryAmd64Sha256,
    nyanpassRelease.binaryAmd64v3Sha256,
    nyanpassRelease.binaryArm64Sha256,
    String(instances.length),
    // OPTIMIZE 已移除：一律传 0（包括旧节点里保存过 OPTIMIZE=1 的实例）。
    ...instances.flatMap((instance) => [instance.name, '0', instance.args]),
  ];
  if (fields.some((value) => value.includes('\0'))) throw new Error('Bootstrap configuration contains a NUL byte');
  return `${fields.join('\0')}\0`;
}

export function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
