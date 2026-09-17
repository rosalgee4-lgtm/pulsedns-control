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

export const PROBE_INSTALLER_URL = 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/aecec67954c30a4ef4aa5460896a4e2eb34ea5be/public/install.sh';
export const PROBE_INSTALLER_SHA256 = '5195a7f5938df2d997c09a48b564183c150cf73d385d966077ea2de60c06ccdb';
export const MAX_CLOUD_LAUNCHER_BYTES = 15 * 1024;
export const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;

export function buildNodeConnectCommand(installUrl: string) {
  return buildVerifiedInstallerCommand(`probe ${shellArg(installUrl)}`);
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
    ...instances.flatMap((instance) => [instance.name, instance.optimize ? '1' : '0', instance.args]),
  ];
  if (fields.some((value) => value.includes('\0'))) throw new Error('Bootstrap configuration contains a NUL byte');
  return `${fields.join('\0')}\0`;
}

export function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
