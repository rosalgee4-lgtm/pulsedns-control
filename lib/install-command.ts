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

export const PROBE_INSTALLER_URL = 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/661ef2da011e57ccf6d91518738a7fb07cfd8853/public/install.sh';
export const PROBE_INSTALLER_SHA256 = 'c39616fbeec961dfa259bfc5503faa3f4b8025a0d94d0d3d0127ec2c0d63a87d';
export const MAX_CLOUD_LAUNCHER_BYTES = 15 * 1024;
export const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;

export function buildNodeConnectCommand(installUrl: string, bbrProfile: BbrProfile) {
  return buildVerifiedInstallerCommand(`probe ${shellArg(installUrl)} ${shellArg(bbrProfile)}`);
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
