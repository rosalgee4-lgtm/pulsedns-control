export function buildNodeStartupLauncher(nodeId: string, installUrl: string, generation: number) {
  const scriptPath = `/root/pulsedns_${nodeId}_install.sh`;
  const stateDir = `/var/lib/pulsedns-bootstrap-${nodeId}`;
  return `#!/bin/sh
set -u

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

log_file=/var/log/pulsedns-bootstrap-launcher.log
script_path=${quoteShellArg(scriptPath)}
download_path="${scriptPath}.download.$$"
state_dir=${quoteShellArg(stateDir)}
complete_file="$state_dir/complete"
install_url=${quoteShellArg(installUrl)}
expected_generation=${generation}

if [ "$(id -u)" -ne 0 ]; then
  echo '[PulseDNS] 开机脚本必须以 root 运行' >&2
  exit 1
fi
if ! : >> "$log_file"; then
  echo '[PulseDNS] 无法写入开机启动日志' >&2
  exit 1
fi
chmod 0600 "$log_file" 2>/dev/null || true
exec >> "$log_file" 2>&1

cleanup_download() {
  [ -z "$download_path" ] || rm -f "$download_path"
}
trap cleanup_download 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

ca_bundle_ready() {
  [ -s /etc/ssl/certs/ca-certificates.crt ] \
    || [ -s /etc/pki/tls/certs/ca-bundle.crt ] \
    || [ -s /etc/ssl/ca-bundle.pem ] \
    || [ -s /etc/ssl/cert.pem ]
}

bash_ready() {
  [ -x /bin/bash ] || return 1
  /bin/bash -c '[ "\${BASH_VERSINFO[0]:-0}" -ge 3 ]' >/dev/null 2>&1
}

downloader_ready() {
  command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1
}

bootstrap_ready() {
  bash_ready && ca_bundle_ready && downloader_ready
}

complete_matches_generation() {
  [ -f "$complete_file" ] && [ ! -L "$complete_file" ] || return 1
  stored_generation=''
  IFS= read -r stored_generation < "$complete_file" || return 1
  [ "$stored_generation" = "$expected_generation" ]
}

install_bootstrap_packages() {
  attempt=1
  while [ "$attempt" -le 24 ]; do
    if command -v apt-get >/dev/null 2>&1; then
      if apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bash wget ca-certificates; then
        return 0
      fi
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q bash wget ca-certificates && return 0
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q bash wget ca-certificates && return 0
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache bash wget ca-certificates && return 0
    else
      echo '[PulseDNS] 未找到支持的包管理器，无法安装 Bash、下载工具和 CA 证书'
      return 1
    fi
    echo "[PulseDNS] 开机依赖暂时无法安装，等待包管理器或网络（$attempt/24）"
    attempt=$((attempt + 1))
    [ "$attempt" -gt 24 ] || sleep 5
  done
  return 1
}

download_once() {
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -t 1 -O "$download_path" "$install_url" && return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl --connect-timeout 10 --max-time 30 -fLSs "$install_url" -o "$download_path" && return 0
  fi
  return 1
}

if complete_matches_generation; then
  echo '[PulseDNS] 首次安装已经完成，恢复 DDNS 服务并跳过已失效的下载直链'
  rm -f "$script_path"
  if command -v systemctl >/dev/null 2>&1 && systemctl enable --now ddns-monitor; then
    exit 0
  fi
  echo '[PulseDNS] 已找到完成标记，但 ddns-monitor 服务恢复失败'
  exit 1
fi

if ! bootstrap_ready; then
  echo '[PulseDNS] 正在补齐 Bash、下载工具和 CA 证书'
  install_bootstrap_packages || { echo '[PulseDNS] 开机依赖安装失败'; exit 1; }
fi
bootstrap_ready || { echo '[PulseDNS] Bash、下载工具或 CA 证书仍不可用'; exit 1; }

downloaded=0
attempt=1
while [ "$attempt" -le 36 ]; do
  rm -f "$download_path"
  if download_once; then
    downloaded=1
    break
  fi
  echo "[PulseDNS] 等待网络和主控下载地址就绪（$attempt/36）"
  attempt=$((attempt + 1))
  [ "$attempt" -gt 36 ] || sleep 5
done
[ "$downloaded" -eq 1 ] || { echo '[PulseDNS] 无法下载节点安装脚本'; exit 1; }

chmod 0700 "$download_path"
/bin/bash -n "$download_path" || { echo '[PulseDNS] 下载的节点安装脚本语法无效'; exit 1; }
mv -f "$download_path" "$script_path"
download_path=''

/bin/bash "$script_path"
status=$?
if [ "$status" -eq 0 ]; then
  rm -f "$script_path"
fi
exit "$status"
`;
}

function quoteShellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
