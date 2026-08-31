import type { TrustedNyanpassRelease } from '@/lib/nyanpass-release';

export type ProvisionedNyanpassInstance = {
  name: string;
  optimize: boolean;
  args: string;
};

type NodeProvisionCommandInput = {
  nodeId: string;
  generation: number;
  origin: string;
  token: string;
  rootPassword: string;
  instances: ProvisionedNyanpassInstance[];
  nyanpassRelease: TrustedNyanpassRelease;
};

export const PROBE_INSTALLER_URL = 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/install.sh';
export const PROBE_INSTALLER_SHA256 = 'b2b6b0e372dce447d05da8ccce27f36b3b8b10ff1bac120d0e1d2f0506240aca';
export const MAX_CLOUD_LAUNCHER_BYTES = 15 * 1024;
export const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;

export function buildNodeStartupScript({ nodeId, generation, origin, token, rootPassword, instances, nyanpassRelease }: NodeProvisionCommandInput) {
  const instanceConfigWrites = instances
    .map((instance) => `  printf '%s\\0' ${shellArg(instance.name)} ${shellArg(instance.optimize ? '1' : '0')} ${shellArg(instance.args)}`)
    .join('\n');
  const stateDir = `/var/lib/pulsedns-bootstrap-${nodeId}`;

  return `#!/usr/bin/env bash
set -Eeuo pipefail

log_file=/var/log/pulsedns-bootstrap.log
state_dir=${shellArg(stateDir)}
attempt_file="$state_dir/attempt"
started_file="$state_dir/started"
complete_file="$state_dir/complete"
stage_file="$state_dir/stage"
outcome_dir=/var/lib/ddns-monitor/provision-outcomes
lock_file=/run/pulsedns-bootstrap.lock
server_url=${shellArg(origin)}
token=${shellArg(token)}
root_password=${shellArg(rootPassword)}
installer_url=${shellArg(PROBE_INSTALLER_URL)}
installer_sha256=${shellArg(PROBE_INSTALLER_SHA256)}
generation=${generation}
attempt_id=''
heartbeat_pid=''
provision_pid=''
provision_disposition=''
provision_config=''
tmp=''
provision_started=0
terminal_written=0
umask 077

valid_attempt_id() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
}

bootstrap_commands_ready() {
  local command_name=''
  for command_name in curl sha256sum flock setsid tee sed tr mktemp install chmod stat mv rm sleep grep awk systemctl; do
    command -v "$command_name" >/dev/null 2>&1 || return 1
  done
}

bootstrap_ca_bundle_ready() {
  [[ -s /etc/ssl/certs/ca-certificates.crt || -s /etc/pki/tls/certs/ca-bundle.crt || -s /etc/ssl/ca-bundle.pem || -s /etc/ssl/cert.pem ]]
}

install_bootstrap_packages() {
  local attempt=0
  for attempt in {1..24}; do
    if command -v apt-get >/dev/null 2>&1; then
      if apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates coreutils util-linux sed grep gawk; then
        return 0
      fi
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q curl ca-certificates coreutils util-linux sed grep gawk && return 0
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q curl ca-certificates coreutils util-linux sed grep gawk && return 0
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache curl ca-certificates coreutils util-linux sed grep gawk && return 0
    else
      echo '[PulseDNS] 未找到支持的包管理器，无法安装开机脚本环境'
      return 1
    fi
    echo "[PulseDNS] 开机环境暂时无法安装，等待包管理器或网络（$attempt/24）"
    [[ "$attempt" -eq 24 ]] || sleep 5
  done
  return 1
}

ensure_bootstrap_environment() {
  bootstrap_commands_ready && bootstrap_ca_bundle_ready && return 0
  echo '[PulseDNS] 安装开机脚本所需环境：curl、CA 证书、coreutils、util-linux'
  install_bootstrap_packages || return 1
  bootstrap_commands_ready && bootstrap_ca_bundle_ready
}

load_attempt_state() {
  local file="$1" stored_generation=''
  IFS= read -r stored_generation < "$file" || return 1
  IFS= read -r attempt_id < <(sed -n '2p' "$file") || return 1
  [[ "$stored_generation" == "$generation" ]] && valid_attempt_id "$attempt_id"
}

write_attempt_state() {
  local target="$1" state_tmp=''
  state_tmp=$(mktemp "$state_dir/.attempt.XXXXXX")
  printf '%s\n%s\n' "$generation" "$attempt_id" > "$state_tmp"
  chmod 0600 "$state_tmp"
  mv -f "$state_tmp" "$target"
}

current_provision_step() {
  local step=''
  [[ -f "$stage_file" && ! -L "$stage_file" ]] || return 0
  IFS= read -r step < "$stage_file" || return 0
  case "$step" in ddns|nyanpass|bbr|ssh) printf '%s' "$step" ;; esac
}

report_provision_message() {
  local phase="$1" outcome="\${2:-}" body='' response='' last_completed_step=''
  provision_disposition=''
  command -v curl >/dev/null 2>&1 || return 1
  last_completed_step=$(current_provision_step)
  if [[ "$phase" == 'finish' ]]; then
    if [[ -n "$last_completed_step" ]]; then
      body=$(printf '{"protocol":1,"phase":"finish","generation":%s,"attemptId":"%s","outcome":"%s","lastCompletedStep":"%s"}' "$generation" "$attempt_id" "$outcome" "$last_completed_step")
    else
      body=$(printf '{"protocol":1,"phase":"finish","generation":%s,"attemptId":"%s","outcome":"%s"}' "$generation" "$attempt_id" "$outcome")
    fi
  elif [[ -n "$last_completed_step" ]]; then
    body=$(printf '{"protocol":1,"phase":"%s","generation":%s,"attemptId":"%s","lastCompletedStep":"%s"}' "$phase" "$generation" "$attempt_id" "$last_completed_step")
  else
    body=$(printf '{"protocol":1,"phase":"%s","generation":%s,"attemptId":"%s"}' "$phase" "$generation" "$attempt_id")
  fi
  response=$(curl -sS --connect-timeout 5 --max-time 20 -X POST \
    "$server_url/api/v1/provision" \
    -H 'Content-Type: application/json' \
    -H 'X-Agent-Version: 0.8.2' \
    -H "X-Secret-Token: $token" \
    -d "$body" 2>/dev/null || true)
  printf '%s' "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || return 1
  if [[ "$phase" == 'finish' ]]; then
    for disposition in accepted duplicate stale; do
      if printf '%s' "$response" | grep -Eq "\\\"disposition\\\"[[:space:]]*:[[:space:]]*\\\"$disposition\\\""; then
        provision_disposition="$disposition"
        return 0
      fi
    done
    return 1
  else
    for disposition in accepted duplicate; do
      if printf '%s' "$response" | grep -Eq "\\\"disposition\\\"[[:space:]]*:[[:space:]]*\\\"$disposition\\\""; then
        provision_disposition="$disposition"
        return 0
      fi
    done
    return 1
  fi
}

persist_finish_outcome() {
  local outcome="$1" outcome_tmp='' outcome_file='' last_completed_step=''
  install -d -m 0700 "$outcome_dir" || return 1
  outcome_file="$outcome_dir/$generation.$attempt_id.$outcome.json"
  outcome_tmp=$(mktemp "$outcome_dir/.provision.XXXXXX") || return 1
  last_completed_step=$(current_provision_step)
  if [[ -n "$last_completed_step" ]]; then
    if ! printf '{"protocol":1,"phase":"finish","generation":%s,"attemptId":"%s","outcome":"%s","lastCompletedStep":"%s"}\n' "$generation" "$attempt_id" "$outcome" "$last_completed_step" > "$outcome_tmp"; then
      rm -f "$outcome_tmp"
      return 1
    fi
  else
    if ! printf '{"protocol":1,"phase":"finish","generation":%s,"attemptId":"%s","outcome":"%s"}\n' "$generation" "$attempt_id" "$outcome" > "$outcome_tmp"; then
      rm -f "$outcome_tmp"
      return 1
    fi
  fi
  if [[ ! -s "$outcome_tmp" ]] \
    || ! chmod 0600 "$outcome_tmp" \
    || ! mv -f "$outcome_tmp" "$outcome_file"; then
    rm -f "$outcome_tmp"
    return 1
  fi
  printf '%s' "$outcome_file"
}

deliver_finish_outcome() {
  local outcome="$1" outcome_file="$2"
  if report_provision_message finish "$outcome"; then
    rm -f "$outcome_file"
    return 0
  fi
  return 1
}

heartbeat_loop() {
  local parent_pid="$1"
  while kill -0 "$parent_pid" 2>/dev/null; do
    sleep 20
    kill -0 "$parent_pid" 2>/dev/null || return 0
    report_provision_message heartbeat || true
  done
}

stop_heartbeat() {
  [[ -n "$heartbeat_pid" ]] || return 0
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  heartbeat_pid=''
}

stop_provision_process_group() {
  local signal="\${1:-TERM}" attempt=0
  [[ -n "$provision_pid" ]] || return 0
  kill -s "$signal" -- "-$provision_pid" 2>/dev/null || kill -s "$signal" "$provision_pid" 2>/dev/null || true
  for attempt in {1..50}; do
    kill -0 -- "-$provision_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 -- "-$provision_pid" 2>/dev/null; then
    kill -KILL -- "-$provision_pid" 2>/dev/null || true
  fi
  wait "$provision_pid" 2>/dev/null || true
  provision_pid=''
}

on_signal() {
  local signal="$1" exit_code="$2" background_pid="\${!:-}"
  trap - INT TERM HUP
  set +e
  if [[ -z "$provision_pid" && -n "$background_pid" && "$background_pid" != "$heartbeat_pid" ]]; then
    provision_pid="$background_pid"
  fi
  echo "[PulseDNS] 收到 $signal，正在停止当前安装进程组"
  stop_provision_process_group "$signal"
  exit "$exit_code"
}

cleanup() {
  [[ -z "$tmp" ]] || rm -f "$tmp"
  case "$provision_config" in "$state_dir"/.provision-config.*) rm -f "$provision_config" ;; esac
  provision_config=''
  exec 9>&-
}

on_exit() {
  local status="$?" outcome_file='' terminal_outcome='failed'
  trap - EXIT INT TERM HUP
  set +e
  stop_provision_process_group TERM
  stop_heartbeat
  if [[ "$provision_started" -eq 1 && "$terminal_written" -eq 0 ]]; then
    if [[ -f "$complete_file" ]] && load_attempt_state "$complete_file"; then
      terminal_outcome='succeeded'
    fi
    if outcome_file=$(persist_finish_outcome "$terminal_outcome"); then
      terminal_written=1
      deliver_finish_outcome "$terminal_outcome" "$outcome_file" || echo '[PulseDNS] 最终回执已落盘；若 DDNS 探针尚未安装，请在网络恢复后原样重跑同一脚本发送'
    else
      echo '[PulseDNS] 无法持久化最终回执；本地状态标记仍保留，下次运行会重试'
    fi
  fi
  cleanup
  exit "$status"
}

if [[ $EUID -ne 0 ]]; then
  echo '[PulseDNS] 开机安装脚本必须以 root 运行'
  exit 1
fi
ensure_bootstrap_environment
exec > >(tee -a "$log_file") 2>&1
exec 9>"$lock_file"
if ! flock -n 9; then
  echo '[PulseDNS] 另一个安装进程正在运行，本次退出'
  exit 1
fi
trap on_exit EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP
install -d -m 0700 "$state_dir" "$outcome_dir"
shopt -s nullglob
for stale_config in "$state_dir"/.provision-config.*; do
  [[ -f "$stale_config" && ! -L "$stale_config" ]] && rm -f "$stale_config"
done
shopt -u nullglob

if [[ -f "$complete_file" ]]; then
  load_attempt_state "$complete_file" || { echo '[PulseDNS] 完成标记损坏或不属于当前脚本'; exit 1; }
  echo '[PulseDNS] 首次安装已经完成，跳过重复安装'
  if outcome_file=$(persist_finish_outcome succeeded); then
    terminal_written=1
    deliver_finish_outcome succeeded "$outcome_file" || echo '[PulseDNS] 完成回执暂未送达，DDNS 探针将在后台重试'
  else
    echo '[PulseDNS] 无法持久化完成回执；请再次运行同一脚本重试'
    exit 1
  fi
  systemctl enable --now ddns-monitor
  exit $?
fi

if [[ -f "$started_file" ]]; then
  failed_acknowledged=0
  load_attempt_state "$started_file" || { echo '[PulseDNS] 中断标记损坏或不属于当前脚本'; exit 1; }
  provision_started=1
  echo '[PulseDNS] 上次安装在中途停止；为避免重复安装 Nyanpass，本次不会自动重跑'
  if outcome_file=$(persist_finish_outcome failed); then
    terminal_written=1
    if deliver_finish_outcome failed "$outcome_file" && [[ "$provision_disposition" == 'accepted' || "$provision_disposition" == 'duplicate' ]]; then
      failed_acknowledged=1
    else
      echo '[PulseDNS] 主控尚未确认旧安装已结束；不要删除 started 标记，网络和主控恢复后原样重跑同一脚本'
    fi
  else
    echo '[PulseDNS] 无法持久化失败回执；started 标记仍保留，下次运行会重试'
  fi
  if [[ "$failed_acknowledged" -eq 1 ]]; then
    echo "[PulseDNS] 主控已确认旧安装失败。确认旧进程已停止后，删除 $started_file，再原样运行同一脚本开始新尝试"
  fi
  exit 1
fi

if [[ -f "$attempt_file" ]]; then
  load_attempt_state "$attempt_file" || { echo '[PulseDNS] 尝试标记损坏或不属于当前脚本'; exit 1; }
else
  [[ -r /proc/sys/kernel/random/uuid ]] || { echo '[PulseDNS] 无法生成本次安装 ID'; exit 1; }
  attempt_id=$(tr 'A-F' 'a-f' < /proc/sys/kernel/random/uuid)
  valid_attempt_id "$attempt_id" || { echo '[PulseDNS] 本次安装 ID 无效'; exit 1; }
  rm -f "$stage_file"
  write_attempt_state "$attempt_file"
fi

start_accepted=0
for attempt in {1..36}; do
  if report_provision_message start; then
    start_accepted=1
    break
  fi
  echo "[PulseDNS] 等待主控接受开机安装（$attempt/36）"
  sleep 5
done
[[ "$start_accepted" -eq 1 ]] || { echo '[PulseDNS] 主控未接受本次开机安装，未修改机器'; exit 1; }
mv -f "$attempt_file" "$started_file"
provision_started=1
heartbeat_loop "$$" &
heartbeat_pid=$!

tmp="$(mktemp)"
downloaded=0
for attempt in {1..36}; do
  if curl --proto '=https' --proto-redir '=https' --connect-timeout 5 --max-time 20 -fLSs "$installer_url" -o "$tmp"; then
    downloaded=1
    break
  fi
  echo "[PulseDNS] 等待 GitHub 发布通道就绪（$attempt/36）"
  sleep 5
done
[[ "$downloaded" -eq 1 ]] || { echo '[PulseDNS] 无法下载安装器'; exit 1; }
grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp"
bash -n "$tmp"
[[ "$(sha256sum "$tmp" | awk '{print $1}')" == "$installer_sha256" ]] || { echo '[PulseDNS] 安装器完整性校验失败'; exit 1; }

set +e
set +m
provision_config=$(mktemp "$state_dir/.provision-config.XXXXXX")
chmod 0600 "$provision_config"
{
  printf '%s\\0' 'PULSEDNS_PROVISION_V2' "$server_url" "$token" "$root_password" ${shellArg(nyanpassRelease.installerUrl)} ${shellArg(nyanpassRelease.installerSha256)} ${shellArg(nyanpassRelease.binaryBaseUrl)} ${shellArg(nyanpassRelease.binaryRelease)} ${shellArg(nyanpassRelease.binaryAmd64Sha256)} ${shellArg(nyanpassRelease.binaryAmd64v3Sha256)} ${shellArg(nyanpassRelease.binaryArm64Sha256)} '${instances.length}'
${instanceConfigWrites}
} > "$provision_config"
PULSEDNS_PROVISION_STAGE_FILE="$stage_file" setsid bash "$tmp" provision --provision-config "$provision_config" --bbr '1' &
provision_pid=$!
wait "$provision_pid"
provision_status=$?
provision_pid=''
rm -f "$provision_config"
provision_config=''
set -e
[[ "$provision_status" -eq 0 ]] || exit "$provision_status"

mv -f "$started_file" "$complete_file"
stop_heartbeat
if outcome_file=$(persist_finish_outcome succeeded); then
  terminal_written=1
  deliver_finish_outcome succeeded "$outcome_file" || echo '[PulseDNS] 安装已完成，但回执暂未送达；DDNS 探针将在后台重试'
else
  echo '[PulseDNS] 安装已完成但无法持久化回执；完成标记仍保留，下次运行会重试'
  exit 1
fi
token=''
root_password=''
echo '[PulseDNS] 首次开机安装全部完成'
`;
}

export function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
