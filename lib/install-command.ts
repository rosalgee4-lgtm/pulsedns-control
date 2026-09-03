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

export const PROBE_INSTALLER_URL = 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/install.sh';
export const PROBE_INSTALLER_SHA256 = '151f1888742f806d3aef801b98aeb89dc2b202d09c60a7f67d161f382e87e1f3';
export const MAX_CLOUD_LAUNCHER_BYTES = 15 * 1024;
export const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;

export function buildNodeConnectCommand(installUrl: string) {
  return `bash <(curl --proto '=https' --proto-redir '=https' -fLSs ${shellArg(PROBE_INSTALLER_URL)}) probe ${shellArg(installUrl)}`;
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
