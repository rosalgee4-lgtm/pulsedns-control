import { isSelfHosted } from '@/db';

export type TrustedNyanpassRelease = {
  installerUrl: string;
  installerSha256: string;
  binaryBaseUrl: string;
  binaryRelease: string;
  binaryAmd64Sha256: string;
  binaryAmd64v3Sha256: string;
  binaryArm64Sha256: string;
};

export const DEFAULT_NYANPASS_RELEASE: TrustedNyanpassRelease = {
  installerUrl: 'https://dl.nyafw.com/download/nyanpass-install.sh',
  installerSha256: 'ece867743399c6a4c262ca31292b79d81a97b0a6efa98ef309f75fdd3e5ca624',
  binaryBaseUrl: 'https://dl.nyafw.com/download/zf-nc20260412',
  binaryRelease: '0e6b2dce-7547-4b51-ab4f-36a45b92649a',
  binaryAmd64Sha256: 'dcd751c7cb6efbe4c28fe35e026b312e01935a7dc81cb5a37386d67c2539da95',
  binaryAmd64v3Sha256: '46b6c894a37b606888f491c6273a6a1d0cec4a176e7760c4ffb9b3c89c921a24',
  binaryArm64Sha256: '06a97fb08e5e3579e3b8e92e5c6d17a60edee6c6c77fb0274d35cf378898b365',
};

export async function trustedNyanpassRelease(): Promise<TrustedNyanpassRelease> {
  const environment = isSelfHosted()
    ? process.env
    : (await import('cloudflare:workers')).env;
  const manifest = {
    installerUrl: environment.PULSEDNS_NYANPASS_INSTALLER_URL?.trim() || DEFAULT_NYANPASS_RELEASE.installerUrl,
    installerSha256: environment.PULSEDNS_NYANPASS_INSTALLER_SHA256?.trim() || DEFAULT_NYANPASS_RELEASE.installerSha256,
    binaryBaseUrl: environment.PULSEDNS_NYANPASS_BINARY_BASE_URL?.trim() || DEFAULT_NYANPASS_RELEASE.binaryBaseUrl,
    binaryRelease: environment.PULSEDNS_NYANPASS_BINARY_RELEASE?.trim() || DEFAULT_NYANPASS_RELEASE.binaryRelease,
    binaryAmd64Sha256: environment.PULSEDNS_NYANPASS_BINARY_AMD64_SHA256?.trim() || DEFAULT_NYANPASS_RELEASE.binaryAmd64Sha256,
    binaryAmd64v3Sha256: environment.PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256?.trim() || DEFAULT_NYANPASS_RELEASE.binaryAmd64v3Sha256,
    binaryArm64Sha256: environment.PULSEDNS_NYANPASS_BINARY_ARM64_SHA256?.trim() || DEFAULT_NYANPASS_RELEASE.binaryArm64Sha256,
  };
  validateTrustedNyanpassRelease(manifest);
  return manifest;
}

export function validateTrustedNyanpassRelease(manifest: TrustedNyanpassRelease) {
  validateOfficialUrl(manifest.installerUrl, '/download/nyanpass-install.sh', true);
  validateOfficialUrl(manifest.binaryBaseUrl, '/download/', false);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(manifest.binaryRelease)) {
    throw new Error('PULSEDNS_NYANPASS_BINARY_RELEASE must be a lowercase UUIDv4');
  }
  for (const [name, hash] of Object.entries({
    PULSEDNS_NYANPASS_INSTALLER_SHA256: manifest.installerSha256,
    PULSEDNS_NYANPASS_BINARY_AMD64_SHA256: manifest.binaryAmd64Sha256,
    PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256: manifest.binaryAmd64v3Sha256,
    PULSEDNS_NYANPASS_BINARY_ARM64_SHA256: manifest.binaryArm64Sha256,
  })) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function validateOfficialUrl(value: string, pathname: string, exactPath: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Nyanpass release URLs must be valid HTTPS URLs');
  }
  const pathMatches = exactPath ? url.pathname === pathname : url.pathname.startsWith(pathname) && url.pathname.length > pathname.length;
  if (url.protocol !== 'https:' || url.hostname !== 'dl.nyafw.com' || url.port || url.username || url.password || url.search || url.hash || !pathMatches) {
    throw new Error('Nyanpass release URLs must use the trusted dl.nyafw.com download path');
  }
}
