export function buildNodeStartupLauncher(nodeId: string, installUrl: string) {
  const scriptPath = `/root/pulsedns_${nodeId}_install.sh`;
  return `#!/bin/bash
umask 077
exec >>/var/log/pulsedns-bootstrap-launcher.log 2>&1
if [[ \${EUID:-$(id -u)} -ne 0 ]]; then
  echo '[PulseDNS] 开机脚本必须以 root 运行'
  exit 1
fi
if ! command -v wget >/dev/null 2>&1; then
  echo '[PulseDNS] 正在安装开机下载所需的 wget 和 CA 证书'
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wget ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q wget ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q wget ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache wget ca-certificates
  else
    echo '[PulseDNS] 未找到支持的包管理器，无法安装 wget'
    exit 1
  fi
fi
command -v wget >/dev/null 2>&1 || { echo '[PulseDNS] wget 安装失败'; exit 1; }
wget -O ${quoteShellArg(scriptPath)} ${quoteShellArg(installUrl)} && chmod +x ${quoteShellArg(scriptPath)} && bash ${quoteShellArg(scriptPath)}`;
}

function quoteShellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
