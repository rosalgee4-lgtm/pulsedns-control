export type ProvisionedNyanpassInstance = {
  name: string;
  optimize: boolean;
  args: string;
};

type NodeProvisionCommandInput = {
  nodeId: string;
  origin: string;
  token: string;
  rootPassword: string;
  instances: ProvisionedNyanpassInstance[];
};

export function buildNodeStartupScript({ nodeId, origin, token, rootPassword, instances }: NodeProvisionCommandInput) {
  const instanceArguments = instances
    .map((instance) => ` --nyanpass-instance ${shellArg(instance.name)} ${shellArg(instance.optimize ? '1' : '0')} ${shellArg(instance.args)}`)
    .join('');
  const installerUrl = `${origin.replace(/\/$/, '')}/install.sh`;
  const stateDir = `/var/lib/pulsedns-bootstrap-${nodeId}`;

  return `#!/usr/bin/env bash
set -Eeuo pipefail

log_file=/var/log/pulsedns-bootstrap.log
state_dir=${shellArg(stateDir)}
started_file="$state_dir/started"
complete_file="$state_dir/complete"
lock_dir=/run/pulsedns-bootstrap.lock
server_url=${shellArg(origin)}
token=${shellArg(token)}
root_password=${shellArg(rootPassword)}
installer_url=${shellArg(installerUrl)}
umask 077
exec > >(tee -a "$log_file") 2>&1

if [[ $EUID -ne 0 ]]; then
  echo '[PulseDNS] 开机安装脚本必须以 root 运行'
  exit 1
fi
if [[ -f "$complete_file" ]]; then
  echo '[PulseDNS] 首次安装已经完成，跳过重复安装'
  systemctl enable --now ddns-monitor
  exit $?
fi
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo '[PulseDNS] 另一个安装进程正在运行，本次退出'
  exit 0
fi
tmp=''
cleanup() {
  [[ -z "$tmp" ]] || rm -f "$tmp"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT

install -d -m 0700 "$state_dir"
if [[ -f "$started_file" ]]; then
  echo '[PulseDNS] 上次安装在中途失败；为避免重复安装 Nyanpass，本次不会自动重跑'
  echo '[PulseDNS] 请检查 /var/log/pulsedns-bootstrap.log，处理后删除本节点的 started 标记再重试'
  exit 1
fi

tmp="$(mktemp)"
downloaded=0
for attempt in {1..36}; do
  if curl --proto '=http,https' --proto-redir '=http,https' --connect-timeout 5 --max-time 20 -fLSs "$installer_url" -o "$tmp"; then
    downloaded=1
    break
  fi
  echo "[PulseDNS] 等待网络和主控就绪（$attempt/36）"
  sleep 5
done
if [[ $downloaded -ne 1 ]]; then
  echo '[PulseDNS] 无法下载安装器，请查看网络和主控端口'
  exit 1
fi

grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp"
bash -n "$tmp"

auth_response=$(curl -sS --connect-timeout 5 --max-time 20 \
  -H "X-Secret-Token: $token" \
  -H "Authorization: Bearer $token" \
  "$server_url/api/v1/report" 2>/dev/null || true)
if ! printf '%s' "$auth_response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo '[PulseDNS] 主控未接受探针令牌；请确认节点未被删除，并且脚本来自同一个面板'
  exit 1
fi

umask 077
: > "$started_file"
bash "$tmp" provision --server "$server_url" --token "$token" --root-password "$root_password"${instanceArguments}

mv -f "$started_file" "$complete_file"
token=''
root_password=''
echo '[PulseDNS] 首次开机安装全部完成'
`;
}

export function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
