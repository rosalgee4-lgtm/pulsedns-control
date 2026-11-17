// 主控加密密钥：加密开机配置、Nyanpass Token 与阿里云 AccessKey。
export async function controlPlaneEncryptionSecret() {
  return process.env.PULSEDNS_TASK_ENCRYPTION_KEY?.trim() ?? '';
}
