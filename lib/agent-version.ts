// 探针版本比较（浏览器与服务端共用，不依赖数据库）。

export const REMOTE_UPGRADE_MIN_VERSION = '0.9.0';

function versionParts(version: string | null | undefined) {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// 无法识别的版本按「更旧」处理。
export function compareVersions(a: string | null | undefined, b: string) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// 0.9.0 起的探针能领取远程升级任务。
export function supportsRemoteUpgrade(version: string | null | undefined) {
  return compareVersions(version, REMOTE_UPGRADE_MIN_VERSION) >= 0;
}
