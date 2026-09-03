import { PROBE_INSTALLER_SHA256, PROBE_INSTALLER_URL } from '@/lib/install-command';

export function buildNodeStartupLauncher(nodeId: string, installUrl: string, generation: number) {
  const scriptPath = `/root/pulsedns_${nodeId}_installer.sh`;
  const configPath = `/root/pulsedns_${nodeId}_bootstrap.config`;
  const stateDir = `/var/lib/pulsedns-bootstrap-${nodeId}`;
  const perBootPath = `/var/lib/cloud/scripts/per-boot/pulsedns-bootstrap-${nodeId}.sh`;
  const launcher = `#!/bin/sh
set -u

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

log_file=/var/log/pulsedns-bootstrap-launcher.log
script_path=${quoteShellArg(scriptPath)}
config_path=${quoteShellArg(configPath)}
download_path="${scriptPath}.download.$$"
state_dir=${quoteShellArg(stateDir)}
complete_file="$state_dir/complete"
installer_url=${quoteShellArg(PROBE_INSTALLER_URL)}
installer_sha256=${quoteShellArg(PROBE_INSTALLER_SHA256)}
node_parameter=${quoteShellArg(installUrl)}
expected_generation=${generation}
per_boot_dir=/var/lib/cloud/scripts/per-boot
per_boot_path=${quoteShellArg(perBootPath)}
per_boot_tmp="${perBootPath}.tmp.$$"

if [ "$(id -u)" -ne 0 ]; then
  echo '[PulseDNS] 开机脚本必须以 root 运行' >&2
  exit 1
fi
if ! printf '' 2>/dev/null >> "$log_file"; then
  echo '[PulseDNS] 无法写入开机启动日志' >&2
  exit 1
fi
chmod 0600 "$log_file" 2>/dev/null || true
exec >> "$log_file" 2>&1

cleanup_temps() {
  [ -z "$download_path" ] || rm -f "$download_path"
  [ -z "$per_boot_tmp" ] || rm -f "$per_boot_tmp"
}
trap cleanup_temps 0
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

installer_tools_ready() {
  command -v curl >/dev/null 2>&1 \
    && command -v sha256sum >/dev/null 2>&1 \
    && command -v grep >/dev/null 2>&1 \
    && command -v wc >/dev/null 2>&1 \
    && command -v tr >/dev/null 2>&1
}

bootstrap_ready() {
  bash_ready && ca_bundle_ready && installer_tools_ready
}

complete_matches_generation() {
  [ -f "$complete_file" ] && [ ! -L "$complete_file" ] || return 1
  stored_generation=''
  IFS= read -r stored_generation < "$complete_file" || return 1
  [ "$stored_generation" = "$expected_generation" ]
}

persist_per_boot() {
  source_header=''
  [ "$0" = "$per_boot_path" ] && return 0
  if [ ! -r "$0" ] || ! IFS= read -r source_header < "$0" || [ "$source_header" != '#!/bin/sh' ]; then
    echo '[PulseDNS] 无法读取当前 user-data 脚本，不能注册下次开机重试'
    return 0
  fi
  if ! mkdir -p "$per_boot_dir" \
    || ! cp "$0" "$per_boot_tmp" \
    || ! chmod 0700 "$per_boot_tmp" \
    || ! mv -f "$per_boot_tmp" "$per_boot_path"; then
    echo '[PulseDNS] 无法注册 cloud-init per-boot 重试，本次仍继续安装'
    rm -f "$per_boot_tmp"
    return 0
  fi
  per_boot_tmp=''
  echo '[PulseDNS] 已注册 cloud-init per-boot 重试，失败后将在下次开机继续'
}

scrub_completed_bootstrap() {
  cached_userdata=''
  rm -f "$per_boot_path"
  for cached_userdata in /var/lib/cloud/instances/*/user-data.txt*; do
    [ -f "$cached_userdata" ] && [ ! -L "$cached_userdata" ] || continue
    if ! printf '' 2>/dev/null > "$cached_userdata"; then
      echo "[PulseDNS] 无法清空 cloud-init 本地缓存：$cached_userdata"
      continue
    fi
    chmod 0600 "$cached_userdata" 2>/dev/null || true
  done
  case "$0" in
    /var/lib/cloud/instances/*/scripts/*|/var/lib/cloud/instance/scripts/*) rm -f "$0" ;;
  esac
}

install_bootstrap_packages() {
  attempt=1
  while [ "$attempt" -le 24 ]; do
    if command -v apt-get >/dev/null 2>&1; then
      if apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bash curl ca-certificates coreutils grep; then
        return 0
      fi
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q bash curl ca-certificates coreutils grep && return 0
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q bash curl ca-certificates coreutils grep && return 0
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache bash curl ca-certificates coreutils grep && return 0
    else
      echo '[PulseDNS] 未找到支持的包管理器，无法安装 Bash、curl、校验工具和 CA 证书'
      return 1
    fi
    echo "[PulseDNS] 开机依赖暂时无法安装，等待包管理器或网络（$attempt/24）"
    attempt=$((attempt + 1))
    [ "$attempt" -gt 24 ] || sleep 5
  done
  return 1
}

download_once() {
  curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 30 -fLSs "$installer_url" -o "$download_path"
}

valid_installer() {
  [ -f "$script_path" ] && [ ! -L "$script_path" ] || return 1
  size=$(wc -c < "$script_path")
  size=$(printf '%s' "$size" | tr -d '[:space:]')
  [ -n "$size" ] && [ "$size" -ge 1 ] 2>/dev/null && [ "$size" -le 262144 ] 2>/dev/null || return 1
  grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$script_path" || return 1
  /bin/bash -n "$script_path" || return 1
  actual_sha256=$(sha256sum "$script_path")
  actual_sha256=\${actual_sha256%% *}
  [ "$actual_sha256" = "$installer_sha256" ]
}

run_cached_installer() {
  [ -f "$script_path" ] && [ ! -L "$script_path" ] || return 1
  if ! valid_installer; then
    echo '[PulseDNS] 本机缓存的固定探针安装器无效，删除后重新下载'
    rm -f "$script_path"
    return 1
  fi
  chmod 0700 "$script_path"
  echo '[PulseDNS] 使用本机已校验的固定探针安装器'
  /bin/bash "$script_path" probe "$node_parameter"
  status=$?
  if [ "$status" -eq 0 ]; then
    rm -f "$script_path" "$config_path"
    scrub_completed_bootstrap
  fi
  exit "$status"
}

if complete_matches_generation; then
  echo '[PulseDNS] 首次安装已经完成，恢复 DDNS 服务并跳过已失效的下载直链'
  if command -v systemctl >/dev/null 2>&1 && systemctl enable --now ddns-monitor; then
    rm -f "$script_path" "$config_path"
    scrub_completed_bootstrap
    exit 0
  fi
  echo '[PulseDNS] 已找到完成标记，但 ddns-monitor 服务恢复失败'
  exit 1
fi

persist_per_boot

if ! bootstrap_ready; then
  echo '[PulseDNS] 正在补齐 Bash、curl、校验工具和 CA 证书'
  install_bootstrap_packages || { echo '[PulseDNS] 开机依赖安装失败'; exit 1; }
fi
bootstrap_ready || { echo '[PulseDNS] Bash、curl、校验工具或 CA 证书仍不可用'; exit 1; }

run_cached_installer || true

downloaded=0
attempt=1
while [ "$attempt" -le 36 ]; do
  rm -f "$download_path"
  if download_once; then
    downloaded=1
    break
  fi
  echo "[PulseDNS] 等待网络和 GitHub 固定安装器就绪（$attempt/36）"
  attempt=$((attempt + 1))
  [ "$attempt" -gt 36 ] || sleep 5
done
[ "$downloaded" -eq 1 ] || { echo '[PulseDNS] 无法下载固定探针安装器'; exit 1; }

chmod 0700 "$download_path"
mv -f "$download_path" "$script_path"
download_path=''
valid_installer || { rm -f "$script_path"; echo '[PulseDNS] 固定探针安装器完整性校验失败'; exit 1; }

run_cached_installer
echo '[PulseDNS] 无法执行固定探针安装器'
exit 1
`;
  return launcher.replace(/\r\n?/g, '\n');
}

function quoteShellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
