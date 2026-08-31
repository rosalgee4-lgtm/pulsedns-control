#!/usr/bin/env bash
# PulseDNS / 原 DDNS 脚本兼容安装器
#
# 保留原仓库的 DDNS、SSH、Nyanpass、BBR 行为；主控地址和令牌改为运行时配置，
# 不包含原仓库里写死的密码或令牌。
set -euo pipefail

# 避免尚未生成 en_US.UTF-8 时 bash/工具链反复输出 setlocale 警告。
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

VERSION="0.8.2"
SERVER_URL="${SERVER_URL:-}"
TOKEN="${TOKEN:-}"
ROOT_PASSWORD="${ROOT_PASSWORD:-}"
APPLY_BBR=""
CHECK_INTERVAL=10
LOG_FILE="/var/log/ddns-monitor.log"
CACHE_V4="/tmp/.ddns_last_ipv4"
CACHE_V6="/tmp/.ddns_last_ipv6"
REPORT_ACCEPTED_MARK="/run/ddns-monitor-report-accepted"
INSTALL_DIR="/opt/ddns-monitor"
INSTALL_PATH="${INSTALL_DIR}/monitor.sh"
CONFIG_FILE="/etc/ddns-monitor.conf"
SERVICE_NAME="ddns-monitor"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
TASK_STATE_DIR="/var/lib/ddns-monitor/tasks"
PROVISION_OUTCOME_DIR="/var/lib/ddns-monitor/provision-outcomes"
DDNS_CREDENTIALS_VERIFIED=0
CONFIG_TMP=""
NYANPASS_TMP=""
NYANPASS_ARCHIVE_TMP=""
NYANPASS_EXTRACT_TMP=""
MONITOR_DOWNLOAD_URL="https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/monitor.sh"
MONITOR_SHA256="9cd34bc6185b4ab7e77605dc7473584b31334cbb878880d01e141d1b9b8882bb"

NYANPASS_INSTALL_URL="${PULSEDNS_NYANPASS_INSTALLER_URL:-https://dl.nyafw.com/download/nyanpass-install.sh}"
NYANPASS_INSTALL_SHA256="${PULSEDNS_NYANPASS_INSTALLER_SHA256:-ece867743399c6a4c262ca31292b79d81a97b0a6efa98ef309f75fdd3e5ca624}"
NYANPASS_BINARY_BASE_URL="${PULSEDNS_NYANPASS_BINARY_BASE_URL:-https://dl.nyafw.com/download/zf-nc20260412}"
NYANPASS_BINARY_RELEASE="${PULSEDNS_NYANPASS_BINARY_RELEASE:-0e6b2dce-7547-4b51-ab4f-36a45b92649a}"
NYANPASS_BINARY_AMD64_SHA256="${PULSEDNS_NYANPASS_BINARY_AMD64_SHA256:-dcd751c7cb6efbe4c28fe35e026b312e01935a7dc81cb5a37386d67c2539da95}"
NYANPASS_BINARY_AMD64V3_SHA256="${PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256:-46b6c894a37b606888f491c6273a6a1d0cec4a176e7760c4ffb9b3c89c921a24}"
NYANPASS_BINARY_ARM64_SHA256="${PULSEDNS_NYANPASS_BINARY_ARM64_SHA256:-06a97fb08e5e3579e3b8e92e5c6d17a60edee6c6c77fb0274d35cf378898b365}"
NYANPASS_BINARY_URL=""
NYANPASS_BINARY_SHA256=""
TASK_LOCK_FILE="/run/ddns-monitor-nyanpass.lock"
NYANPASS_TIMEOUT=600
NYANPASS_INPUT=""
NYANPASS_NAME=""
NYANPASS_OPTIMIZE="0"
NYANPASS_UNATTENDED="0"
PARSED_NYANPASS_ARGS=""
PARSED_NYANPASS_ROLE=""
NYANPASS_BATCH_NAMES=()
NYANPASS_BATCH_OPTIMIZES=()
NYANPASS_BATCH_INPUTS=()
PROVISION_STAGE_FILE="${PULSEDNS_PROVISION_STAGE_FILE:-}"

IPV4_SERVICES=(
    "https://api.ipify.org"
    "https://ifconfig.me/ip"
    "https://myip.ipip.net"
    "https://ddns.oray.com/checkip"
    "https://ip.3322.net"
    "https://4.ipw.cn"
    "https://v4.yinghualuo.cn/bejson"
    "https://myexternalip.com/raw"
)

IPV6_SERVICES=(
    "https://api6.ipify.org"
    "https://speed.neu6.edu.cn/getIP.php"
    "https://v6.ident.me"
    "https://6.ipw.cn"
    "https://v6.yinghualuo.cn/bejson"
)

blue='\033[1;34m'
green='\033[1;32m'
yellow='\033[1;33m'
red='\033[1;31m'
reset='\033[0m'

log() {
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" | tee -a "$LOG_FILE"
}

info() { printf "%b[INFO]%b %s\n" "$blue" "$reset" "$*"; }
ok() { printf "%b[ OK ]%b %s\n" "$green" "$reset" "$*"; }
warn() { printf "%b[WARN]%b %s\n" "$yellow" "$reset" "$*"; }
fail() { printf "%b[FAIL]%b %s\n" "$red" "$reset" "$*" >&2; exit 1; }

cleanup_sensitive_temps() {
    case "${CONFIG_TMP:-}" in /etc/ddns-monitor.conf.*) rm -f -- "$CONFIG_TMP" ;; esac
    case "${NYANPASS_TMP:-}" in /tmp/nyanpass-install.*.sh) rm -f -- "$NYANPASS_TMP" ;; esac
    case "${NYANPASS_ARCHIVE_TMP:-}" in /tmp/nyanpass-binary.*.zip) rm -f -- "$NYANPASS_ARCHIVE_TMP" ;; esac
    case "${NYANPASS_EXTRACT_TMP:-}" in /tmp/nyanpass-extract.*) rm -rf -- "$NYANPASS_EXTRACT_TMP" ;; esac
}
trap cleanup_sensitive_temps EXIT

need_root() {
    if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
        fail "请用 sudo/root 运行"
    fi
}

fix_locale() {
    if locale -a 2>/dev/null | grep -qi '^en_US\.utf8$'; then
        return 0
    fi

    if command -v locale-gen >/dev/null 2>&1; then
        log INFO "生成 en_US.UTF-8 locale..."
        sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
        locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
        update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 >/dev/null 2>&1 || true
    fi
}

install_packages_with_retry() {
    local attempt=0
    for attempt in {1..24}; do
        if command -v apt-get >/dev/null 2>&1; then
            if apt-get update -qq \
                && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; then
                return 0
            fi
        elif command -v dnf >/dev/null 2>&1; then
            dnf install -y -q "$@" && return 0
        elif command -v yum >/dev/null 2>&1; then
            yum install -y -q "$@" && return 0
        elif command -v apk >/dev/null 2>&1; then
            apk add --no-cache "$@" && return 0
        else
            log ERROR "未找到支持的包管理器，请手动安装：$*"
            return 1
        fi
        log WARN "依赖暂时无法安装，等待包管理器或网络（${attempt}/24）"
        [[ $attempt -eq 24 ]] || sleep 5
    done
    return 1
}

install_deps() {
    local missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")
    command -v timeout >/dev/null 2>&1 || missing+=("coreutils")
    command -v flock >/dev/null 2>&1 || missing+=("util-linux")
    command -v unzip >/dev/null 2>&1 || missing+=("unzip")

    [[ ${#missing[@]} -eq 0 ]] && return 0

    log INFO "安装依赖：${missing[*]}"
    install_packages_with_retry "${missing[@]}" || fail "连续 24 次无法安装运行依赖"
    command -v curl >/dev/null 2>&1 \
        && command -v jq >/dev/null 2>&1 \
        && command -v timeout >/dev/null 2>&1 \
        && command -v flock >/dev/null 2>&1 \
        && command -v unzip >/dev/null 2>&1 \
        || fail "运行依赖安装后仍不完整"
}

select_nyanpass_binary() {
    local arch=""
    case "$(uname -m)" in
        aarch64|arm64) arch="arm64" ;;
        x86_64|amd64)
            if grep -Fq "Intel Core Processor (Broadwell)" /proc/cpuinfo 2>/dev/null; then
                arch="amd64"
            elif awk -F ':' '/flags/{print $2; exit}' /proc/cpuinfo | grep -qw avx2; then
                arch="amd64v3"
            else
                arch="amd64"
            fi
            ;;
        *) return 1 ;;
    esac
    NYANPASS_BINARY_URL="${NYANPASS_BINARY_BASE_URL}/rel_nodeclient_linux_${arch}-${NYANPASS_BINARY_RELEASE}.zip"
    case "$arch" in
        amd64) NYANPASS_BINARY_SHA256="$NYANPASS_BINARY_AMD64_SHA256" ;;
        amd64v3) NYANPASS_BINARY_SHA256="$NYANPASS_BINARY_AMD64V3_SHA256" ;;
        arm64) NYANPASS_BINARY_SHA256="$NYANPASS_BINARY_ARM64_SHA256" ;;
    esac
}

verify_nyanpass_archive() {
    local archive="$1" extract_dir="$2" members=""
    members=$(unzip -Z1 "$archive" 2>/dev/null) || return 1
    [[ "$members" == "rel_nodeclient" ]] || return 1
    mkdir -p "$extract_dir"
    unzip -qq "$archive" -d "$extract_dir" || return 1
    [[ -f "$extract_dir/rel_nodeclient" && ! -L "$extract_dir/rel_nodeclient" ]]
}

stage_nyanpass_binary() {
    local service_name="$1" binary="$2" target_dir="" candidate=""
    target_dir="/opt/$service_name"
    [[ ! -L "$target_dir" ]] || return 1
    install -d -m 0755 "$target_dir"
    candidate=$(mktemp "$target_dir/.rel_nodeclient.pulsedns.XXXXXX") || return 1
    if ! install -m 0755 "$binary" "$candidate" || ! mv -f "$candidate" "$target_dir/rel_nodeclient"; then
        rm -f "$candidate"
        return 1
    fi
}

write_nyanpass_start_script() {
    local service_name="$1" arguments="$2" target_dir="" candidate="" word=""
    local -a argument_words=()
    target_dir="/opt/$service_name"
    [[ ! -L "$target_dir" ]] || return 1
    install -d -m 0755 "$target_dir"
    candidate=$(mktemp "$target_dir/.start.pulsedns.XXXXXX") || return 1
    read -r -a argument_words <<< "$arguments"
    if ! {
        printf 'source ./env.sh || true\n./rel_nodeclient'
        for word in "${argument_words[@]}"; do printf ' %q' "$word"; done
        printf '\n'
    } > "$candidate" \
        || ! chmod 0700 "$candidate" \
        || ! mv -f "$candidate" "$target_dir/start.sh"; then
        rm -f "$candidate"
        return 1
    fi
}

configure_bbr() {
    need_root
    log INFO "配置 BBR + fq..."

    if [[ -f /etc/sysctl.conf ]]; then
        cp /etc/sysctl.conf "/etc/sysctl.conf.bak.$(date +%s)" 2>/dev/null || true
    fi

    modprobe tcp_bbr 2>/dev/null || true

    cat > /etc/sysctl.conf <<'SYSCTL_EOF'
fs.file-max = 6815744
net.ipv4.tcp_no_metrics_save=1
net.ipv4.tcp_ecn=0
net.ipv4.tcp_frto=0
net.ipv4.tcp_mtu_probing=0
net.ipv4.tcp_rfc1337=0
net.ipv4.tcp_sack=1
net.ipv4.tcp_fack=1
net.ipv4.tcp_window_scaling=1
net.ipv4.tcp_adv_win_scale=1
net.ipv4.tcp_moderate_rcvbuf=1
net.core.rmem_max=10000000
net.core.wmem_max=10000000
net.ipv4.tcp_rmem=4096 131072 10000000
net.ipv4.tcp_wmem=4096 131072 10000000
net.ipv4.udp_rmem_min=8192
net.ipv4.udp_wmem_min=8192
net.ipv4.ip_forward=1
net.ipv4.conf.all.route_localnet=1
net.ipv4.conf.all.forwarding=1
net.ipv4.conf.default.forwarding=1
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
SYSCTL_EOF

    sysctl -p >/dev/null 2>&1 || log WARN "sysctl -p 应用可能未完全成功"
    sysctl --system >/dev/null 2>&1 || true

    local cc qdisc
    cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo "unknown")
    qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo "unknown")
    log INFO "当前拥塞控制算法：$cc"
    log INFO "当前队列算法：$qdisc"
}

configure_ssh() {
    need_root
    local root_password="$ROOT_PASSWORD" root_password_confirm=""
    local sshd_config="/etc/ssh/sshd_config"
    local managed_begin="# BEGIN PulseDNS managed SSH options"
    local managed_end="# END PulseDNS managed SSH options"
    local sshd_bin="" ssh_service="" service_candidate=""
    local candidate_config="" backup_config="" rollback_config="" effective_config=""
    local begin_count=0 end_count=0

    log INFO "配置 SSH root 登录和密码登录..."
    if [[ -n "$root_password" ]]; then
        [[ ${#root_password} -ge 8 && ${#root_password} -le 128 ]] || fail "root 密码长度必须为 8-128 个字符"
        [[ "$root_password" != *$'\n'* && "$root_password" != *$'\r'* ]] || fail "root 密码不能包含换行"
    fi
    while [[ -z "$root_password" ]]; do
        read -r -s -p "请输入新的 root 密码: " root_password
        printf '\n'
        read -r -s -p "请再次输入 root 密码: " root_password_confirm
        printf '\n'
        if [[ -z "$root_password" ]]; then
            warn "root 密码不能为空"
        elif [[ "$root_password" != "$root_password_confirm" ]]; then
            warn "两次输入的密码不一致，请重试"
            root_password=""
        elif [[ ${#root_password} -lt 8 || ${#root_password} -gt 128 ]]; then
            warn "root 密码长度必须为 8-128 个字符"
            root_password=""
        elif [[ "$root_password" == *$'\n'* || "$root_password" == *$'\r'* ]]; then
            warn "root 密码不能包含换行"
            root_password=""
        fi
    done

    [[ -f "$sshd_config" && ! -L "$sshd_config" ]] || fail "未找到安全的 $sshd_config，拒绝只修改 root 密码"
    sshd_bin=$(command -v sshd 2>/dev/null || true)
    if [[ -z "$sshd_bin" || ! -x "$sshd_bin" ]]; then
        if [[ -x /usr/sbin/sshd ]]; then
            sshd_bin=/usr/sbin/sshd
        else
            fail "未找到 sshd，无法安全验证 SSH 配置"
        fi
    fi
    for service_candidate in sshd.service ssh.service; do
        if systemctl cat "$service_candidate" >/dev/null 2>&1; then
            ssh_service="$service_candidate"
            break
        fi
    done
    [[ -n "$ssh_service" ]] || fail "未找到 sshd.service 或 ssh.service"

    begin_count=$(grep -Fxc -- "$managed_begin" "$sshd_config" || true)
    end_count=$(grep -Fxc -- "$managed_end" "$sshd_config" || true)
    [[ "$begin_count" -eq "$end_count" && "$begin_count" -le 1 ]] || fail "检测到损坏或重复的 PulseDNS SSH 受管块，请先人工检查"

    candidate_config=$(mktemp "${sshd_config}.pulsedns.XXXXXX") || fail "无法创建 SSH 候选配置"
    backup_config=$(mktemp "${sshd_config}.pulsedns.bak.XXXXXX") || {
        rm -f -- "$candidate_config"
        fail "无法创建 SSH 配置备份"
    }
    if ! cp -a -- "$sshd_config" "$backup_config" || ! cp -a -- "$sshd_config" "$candidate_config"; then
        rm -f -- "$candidate_config" "$backup_config"
        fail "无法备份 SSH 配置"
    fi
    if ! {
        printf '%s\nPermitRootLogin yes\nPasswordAuthentication yes\n%s\n\n' "$managed_begin" "$managed_end"
        awk -v begin="$managed_begin" -v end="$managed_end" '
            $0 == begin { managed=1; next }
            $0 == end { managed=0; next }
            !managed { print }
        ' "$sshd_config"
    } > "$candidate_config"; then
        rm -f -- "$candidate_config"
        fail "生成 SSH 候选配置失败；原配置未变（备份：$backup_config）"
    fi

    if ! "$sshd_bin" -t -f "$candidate_config"; then
        rm -f -- "$candidate_config"
        fail "SSH 候选配置语法检查失败；原配置未变（备份：$backup_config）"
    fi
    if ! effective_config=$("$sshd_bin" -T -f "$candidate_config" -C user=root,host=localhost,addr=127.0.0.1 2>&1); then
        rm -f -- "$candidate_config"
        fail "SSH 候选配置有效值检查失败：$effective_config（备份：$backup_config）"
    fi
    if ! printf '%s\n' "$effective_config" | grep -Eq '^permitrootlogin[[:space:]]+yes$'; then
        rm -f -- "$candidate_config"
        fail "PermitRootLogin 有效值不是 yes（备份：$backup_config）"
    fi
    if ! printf '%s\n' "$effective_config" | grep -Eq '^passwordauthentication[[:space:]]+yes$'; then
        rm -f -- "$candidate_config"
        fail "PasswordAuthentication 有效值不是 yes（备份：$backup_config）"
    fi
    effective_config=""

    if ! mv -f -- "$candidate_config" "$sshd_config"; then
        rm -f -- "$candidate_config"
        fail "原子写入 SSH 配置失败；原配置未变（备份：$backup_config）"
    fi
    candidate_config=""
    command -v restorecon >/dev/null 2>&1 && restorecon -F "$sshd_config" >/dev/null 2>&1 || true

    if ! systemctl reload "$ssh_service" >/dev/null 2>&1 && ! systemctl restart "$ssh_service" >/dev/null 2>&1; then
        rollback_config=$(mktemp "${sshd_config}.rollback.XXXXXX") || fail "SSH 加载失败且无法创建回滚文件；备份：$backup_config"
        if cp -a -- "$backup_config" "$rollback_config" && mv -f -- "$rollback_config" "$sshd_config"; then
            rollback_config=""
            command -v restorecon >/dev/null 2>&1 && restorecon -F "$sshd_config" >/dev/null 2>&1 || true
            systemctl reload "$ssh_service" >/dev/null 2>&1 || systemctl restart "$ssh_service" >/dev/null 2>&1 || log ERROR "原 SSH 配置已恢复，但服务恢复加载失败"
        fi
        rm -f -- "$rollback_config"
        fail "SSH 新配置加载失败，已尝试恢复原配置（备份：$backup_config）"
    fi

    if ! printf 'root:%s\n' "$root_password" | chpasswd 2>/dev/null; then
        rollback_config=$(mktemp "${sshd_config}.rollback.XXXXXX") || fail "root 密码设置失败且无法创建回滚文件；备份：$backup_config"
        if cp -a -- "$backup_config" "$rollback_config" && mv -f -- "$rollback_config" "$sshd_config"; then
            rollback_config=""
            command -v restorecon >/dev/null 2>&1 && restorecon -F "$sshd_config" >/dev/null 2>&1 || true
            systemctl reload "$ssh_service" >/dev/null 2>&1 || systemctl restart "$ssh_service" >/dev/null 2>&1 || log ERROR "原 SSH 配置已恢复，但服务恢复加载失败"
        fi
        rm -f -- "$rollback_config"
        fail "root 密码设置失败，已尝试恢复原 SSH 配置（备份：$backup_config）"
    fi

    root_password=""
    root_password_confirm=""
    ROOT_PASSWORD=""
    log INFO "SSH 配置和 root 密码设置完成（原配置备份：$backup_config）"
}

trim_space() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

parse_nyanpass_input() {
    local input raw_args token="" panel_url="" full_double_re full_single_re token_re url_re
    local seen_o=0 seen_t=0 seen_u=0 index=0 part="" next="" port=""
    local -a parts=()
    input=$(trim_space "$1")
    full_double_re='^bash[[:space:]]+<\(curl[[:space:]]+-fLSs[[:space:]]+https://dl\.nyafw\.com/download/nyanpass-install\.sh\)[[:space:]]+rel_nodeclient[[:space:]]+"([^"]+)"[[:space:]]*$'
    full_single_re="^bash[[:space:]]+<\\(curl[[:space:]]+-fLSs[[:space:]]+https://dl\\.nyafw\\.com/download/nyanpass-install\\.sh\\)[[:space:]]+rel_nodeclient[[:space:]]+'([^']+)'[[:space:]]*$"
    token_re='^[A-Za-z0-9._~:+/=-]+$'
    url_re='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/@%+=,-]*)?$'

    if [[ "$input" =~ $full_double_re ]]; then
        raw_args="${BASH_REMATCH[1]}"
    elif [[ "$input" =~ $full_single_re ]]; then
        raw_args="${BASH_REMATCH[1]}"
    else
        raw_args="$input"
        if [[ ${#raw_args} -ge 2 && "${raw_args:0:1}" == '"' && "${raw_args: -1}" == '"' ]]; then
            raw_args="${raw_args:1:${#raw_args}-2}"
        elif [[ ${#raw_args} -ge 2 && "${raw_args:0:1}" == "'" && "${raw_args: -1}" == "'" ]]; then
            raw_args="${raw_args:1:${#raw_args}-2}"
        fi
        raw_args=$(trim_space "$raw_args")
    fi

    [[ -n "$raw_args" && "$raw_args" != *$'\n'* && "$raw_args" != *$'\r'* ]] || return 1
    read -r -a parts <<< "$raw_args"
    [[ ${#parts[@]} -ge 4 && ${#parts[@]} -le 5 ]] || return 1

    while [[ $index -lt ${#parts[@]} ]]; do
        part="${parts[$index]}"
        case "$part" in
            -o)
                [[ $seen_o -eq 0 ]] || return 1
                seen_o=1
                index=$((index + 1))
                ;;
            -t|-u)
                [[ $((index + 1)) -lt ${#parts[@]} ]] || return 1
                next="${parts[$((index + 1))]}"
                [[ "$next" != -o && "$next" != -t && "$next" != -u ]] || return 1
                if [[ "$part" == -t ]]; then
                    [[ $seen_t -eq 0 ]] || return 1
                    seen_t=1
                    token="$next"
                else
                    [[ $seen_u -eq 0 ]] || return 1
                    seen_u=1
                    panel_url="$next"
                fi
                index=$((index + 2))
                ;;
            *)
                return 1
                ;;
        esac
    done

    [[ $seen_t -eq 1 && $seen_u -eq 1 ]] || return 1
    [[ "$token" =~ $token_re && ${#token} -ge 8 && ${#token} -le 512 ]] || return 1
    [[ "$panel_url" =~ $url_re ]] || return 1
    if [[ "${BASH_REMATCH[1]:-}" == :* ]]; then
        port="${BASH_REMATCH[1]#:}"
        [[ $((10#$port)) -ge 1 && $((10#$port)) -le 65535 ]] || return 1
    fi

    if [[ $seen_o -eq 1 ]]; then
        PARSED_NYANPASS_ROLE="出口"
        PARSED_NYANPASS_ARGS="-o -t ${token} -u ${panel_url}"
    else
        PARSED_NYANPASS_ROLE="入口"
        PARSED_NYANPASS_ARGS="-t ${token} -u ${panel_url}"
    fi
}

install_nyanpass_once() {
    local input="$1"
    local service_name="${2:-$NYANPASS_NAME}"
    local optimize="${3:-$NYANPASS_OPTIMIZE}"
    local unattended="${4:-$NYANPASS_UNATTENDED}"
    local installer="" archive="" extract_dir="" digest="" archive_digest="" answer="" optimize_answer="" optimize_env="" install_ok=false
    need_root
    install_deps
    validate_nyanpass_release_manifest

    if ! parse_nyanpass_input "$input"; then
        fail "Nyanpass 命令无效。只接受官方安装命令，或 -t TOKEN -u HTTPS_URL；出口仅多一个独立的 -o 参数"
    fi
    if [[ -z "$service_name" ]]; then
        [[ "$unattended" == "0" ]] || fail "无人值守安装必须提供 Nyanpass 服务名称"
        read -r -p "请输入服务名 [默认 nyanpass] : " service_name
        service_name="${service_name:-nyanpass}"
        read -r -p "是否优化系统参数 [输入 y 优化] : " optimize_answer
        [[ "$optimize_answer" =~ ^[Yy]$ ]] && optimize="1" || optimize="0"
    fi
    if [[ ! "$service_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$ ]]; then
        fail "Nyanpass 服务名称只能包含字母、数字、点、下划线和短横线"
    fi
    [[ "$optimize" == "0" || "$optimize" == "1" ]] || fail "Nyanpass OPTIMIZE 只能为 0 或 1"
    [[ "$unattended" == "0" || "$unattended" == "1" ]] || fail "Nyanpass 无人值守标记无效"

    installer=$(mktemp /tmp/nyanpass-install.XXXXXX.sh)
    NYANPASS_TMP="$installer"
    archive=$(mktemp /tmp/nyanpass-binary.XXXXXX.zip)
    NYANPASS_ARCHIVE_TMP="$archive"
    extract_dir=$(mktemp -d /tmp/nyanpass-extract.XXXXXX)
    NYANPASS_EXTRACT_TMP="$extract_dir"
    select_nyanpass_binary || fail "当前 CPU 架构不受固定 Nyanpass 二进制支持"
    curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs "$NYANPASS_INSTALL_URL" -o "$installer" \
        || fail "Nyanpass 官方安装器下载失败"
    digest=$(sha256sum "$installer" | awk '{print $1}')
    [[ "$digest" == "$NYANPASS_INSTALL_SHA256" ]] || fail "Nyanpass 官方安装器完整性校验失败；上游文件可能已更新，已拒绝执行"
    bash -n "$installer" || fail "Nyanpass 官方安装器语法校验失败"
    curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs "$NYANPASS_BINARY_URL" -o "$archive" \
        || fail "Nyanpass 固定二进制下载失败"
    archive_digest=$(sha256sum "$archive" | awk '{print $1}')
    [[ "$archive_digest" == "$NYANPASS_BINARY_SHA256" ]] || fail "Nyanpass 固定二进制完整性校验失败"
    verify_nyanpass_archive "$archive" "$extract_dir" || fail "Nyanpass 固定二进制压缩包结构无效"
    warn "识别为 Nyanpass ${PARSED_NYANPASS_ROLE}；即将执行官方安装器${service_name:+（${service_name}）}"
    warn "安装器与 ${NYANPASS_BINARY_URL##*/} 均已通过固定 SHA-256 校验"
    if [[ "$unattended" == "1" ]]; then
        log INFO "无人值守安装 Nyanpass：${service_name:-未命名} (OPTIMIZE=${optimize})"
    else
        read -r -p "确认继续？[y/N]: " answer
        if [[ ! "$answer" =~ ^[Yy]$ ]]; then
            rm -f "$installer" "$archive"
            rm -rf "$extract_dir"
            NYANPASS_TMP=""; NYANPASS_ARCHIVE_TMP=""; NYANPASS_EXTRACT_TMP=""
            warn "已取消"
            return 0
        fi
    fi

    stage_nyanpass_binary "$service_name" "$extract_dir/rel_nodeclient" || fail "无法安全写入固定 Nyanpass 二进制"
    write_nyanpass_start_script "$service_name" "$PARSED_NYANPASS_ARGS" || fail "无法安全写入 Nyanpass 启动参数"
    if [[ "$optimize" == "1" ]]; then optimize_env="1"; fi
    if S="$service_name" REINSTALL=1 OPTIMIZE="$optimize_env" NO_DOWNLOAD=1 timeout --kill-after=30s "$NYANPASS_TIMEOUT" bash "$installer" rel_nodeclient "$PARSED_NYANPASS_ARGS" 2>&1 | tee -a "$LOG_FILE"; then
        install_ok=true
    fi
    if [[ "$install_ok" == true ]]; then
        log INFO "Nyanpass ${PARSED_NYANPASS_ROLE}安装完成"
    else
        fail "Nyanpass 安装失败或超时"
    fi
    rm -f "$installer" "$archive"
    rm -rf "$extract_dir"
    NYANPASS_TMP=""; NYANPASS_ARCHIVE_TMP=""; NYANPASS_EXTRACT_TMP=""
    PARSED_NYANPASS_ARGS=""
    PARSED_NYANPASS_ROLE=""
    NYANPASS_NAME=""
    NYANPASS_OPTIMIZE="0"
    NYANPASS_UNATTENDED="0"
}

install_nyanpass_many() {
    local input="" another=""
    need_root

    if [[ -n "$NYANPASS_INPUT" ]]; then
        install_nyanpass_once "$NYANPASS_INPUT" "$NYANPASS_NAME" "$NYANPASS_OPTIMIZE" "$NYANPASS_UNATTENDED"
        NYANPASS_INPUT=""
        return 0
    fi

    while true; do
        printf '\n请粘贴以下任一种内容：\n'
        printf '  1. Nyanpass 官方完整命令\n'
        printf '  2. 原始 rel_nodeclient 参数（入口无 -o，出口有独立 -o）\n'
        read -r -s -p "命令或参数（留空返回）: " input
        printf '\n'
        [[ -n "$input" ]] || return 0
        install_nyanpass_once "$input"

        read -r -p "继续添加另一个 Nyanpass 实例？[y/N]: " another
        [[ "$another" =~ ^[Yy]$ ]] || return 0
    done
}

install_nyanpass_batch() {
    local index=0
    need_root
    [[ ${#NYANPASS_BATCH_NAMES[@]} -gt 0 ]] || fail "无人值守安装缺少 Nyanpass 实例"
    [[ ${#NYANPASS_BATCH_NAMES[@]} -eq ${#NYANPASS_BATCH_OPTIMIZES[@]} && ${#NYANPASS_BATCH_NAMES[@]} -eq ${#NYANPASS_BATCH_INPUTS[@]} ]] || fail "Nyanpass 批量参数不完整"

    for ((index = 0; index < ${#NYANPASS_BATCH_NAMES[@]}; index++)); do
        install_nyanpass_once \
            "${NYANPASS_BATCH_INPUTS[$index]}" \
            "${NYANPASS_BATCH_NAMES[$index]}" \
            "${NYANPASS_BATCH_OPTIMIZES[$index]}" \
            "1"
    done
}

valid_ipv4() {
    local ip="$1" part=""
    local -a parts=()
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    IFS='.' read -r -a parts <<< "$ip"
    [[ ${#parts[@]} -eq 4 ]] || return 1
    for part in "${parts[@]}"; do
        [[ "$part" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
        ((10#$part <= 255)) || return 1
    done
}

valid_ipv6() {
    local ip="$1" left="" right="" ipv4_tail="" part="" count=0
    local -a parts=()
    [[ ${#ip} -ge 2 && ${#ip} -le 45 && "$ip" == *:* && "$ip" != *%* ]] || return 1
    [[ "$ip" =~ ^[0-9A-Fa-f:.]+$ ]] || return 1
    if [[ "$ip" == *.* ]]; then
        ipv4_tail="${ip##*:}"
        valid_ipv4 "$ipv4_tail" || return 1
        ip="${ip%:*}:0:0"
    fi
    [[ "$ip" != *:::* ]] || return 1
    if [[ "$ip" == *::* ]]; then
        left="${ip%%::*}"
        right="${ip#*::}"
        [[ "$right" != *::* ]] || return 1
        if [[ -n "$left" ]]; then
            IFS=':' read -r -a parts <<< "$left"
            for part in "${parts[@]}"; do
                [[ "$part" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
                count=$((count + 1))
            done
        fi
        if [[ -n "$right" ]]; then
            IFS=':' read -r -a parts <<< "$right"
            for part in "${parts[@]}"; do
                [[ "$part" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
                count=$((count + 1))
            done
        fi
        ((count < 8))
        return
    fi
    [[ "$ip" != :* && "$ip" != *: ]] || return 1
    IFS=':' read -r -a parts <<< "$ip"
    [[ ${#parts[@]} -eq 8 ]] || return 1
    for part in "${parts[@]}"; do
        [[ "$part" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
    done
}

get_ipv4() {
    local ip="" url=""
    for url in "${IPV4_SERVICES[@]}"; do
        ip=$(curl -4 -s --max-time 5 --retry 2 "$url" 2>/dev/null || true)
        ip=$(trim_space "$ip")
        valid_ipv4 "$ip" && echo "$ip" && return 0
    done
    echo ""
}

get_ipv6() {
    local ip="" url=""
    for url in "${IPV6_SERVICES[@]}"; do
        ip=$(curl -6 -s --max-time 5 --retry 2 "$url" 2>/dev/null || true)
        ip=$(trim_space "$ip")
        valid_ipv6 "$ip" && echo "$ip" && return 0
    done
    echo ""
}

validate_ddns_config() {
    local server_re='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]{1,64})?/?$' port="" authority=""
    [[ "$SERVER_URL" =~ $server_re ]] || fail "SERVER_URL 必须是有效的 HTTP/HTTPS 主控地址"
    if [[ "$SERVER_URL" == http://* && ! "$SERVER_URL" =~ ^http://[A-Za-z0-9.-]+:[0-9]{1,5}/[a-f0-9]{32}/?$ ]]; then
        fail "HTTP 主控地址必须包含端口和 32 位随机访问路径"
    fi
    authority="${SERVER_URL#*://}"
    authority="${authority%%/*}"
    if [[ "$authority" == *:* ]]; then
        port="${authority##*:}"
        [[ $((10#$port)) -ge 1 && $((10#$port)) -le 65535 ]] || fail "SERVER_URL 端口必须是 1-65535"
    fi
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ && ${#TOKEN} -ge 8 && ${#TOKEN} -le 512 ]] || fail "TOKEN 格式无效"
    SERVER_URL="${SERVER_URL%/}"
}

prompt_ddns_config() {
    if [[ -z "$SERVER_URL" ]]; then
        read -r -p "主控地址: " SERVER_URL
    fi
    if [[ -z "$TOKEN" ]]; then
        read -r -s -p "探针令牌: " TOKEN
        printf '\n'
    fi
    validate_ddns_config
}

validate_ddns_credentials_remote() {
    local response=""
    [[ "$DDNS_CREDENTIALS_VERIFIED" -eq 0 ]] || return 0
    response=$(curl -sS --connect-timeout 5 --max-time 20 \
        -H "X-Secret-Token: $TOKEN" \
        -H "Authorization: Bearer $TOKEN" \
        "${SERVER_URL%/}/api/v1/report" 2>/dev/null || true)
    if printf '%s' "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
        DDNS_CREDENTIALS_VERIFIED=1
        log INFO "主控已确认探针令牌有效"
        return 0
    fi
    fail "主控未接受探针令牌；请确认节点未被删除，并且命令来自同一个主控面板"
}

write_ddns_config() {
    CONFIG_TMP=$(mktemp /etc/ddns-monitor.conf.XXXXXX)
    {
        printf 'SERVER_URL=%s\n' "$SERVER_URL"
        printf 'TOKEN=%s\n' "$TOKEN"
    } > "$CONFIG_TMP"
    chown root:root "$CONFIG_TMP"
    chmod 0600 "$CONFIG_TMP"
    mv -f "$CONFIG_TMP" "$CONFIG_FILE"
    CONFIG_TMP=""
}

write_ddns_service_unit() {
    local target="$1"
    cat > "$target" <<SERVICE_EOF
[Unit]
Description=DDNS IP Monitor
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/bin/bash ${INSTALL_PATH} --run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE_EOF
    chmod 0644 "$target"
}

ddns_verification_failed() {
    local reason="$1"
    warn "DDNS 探针验收失败：$reason"
    systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null || true
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager 2>/dev/null || true
    fail "DDNS 探针未正常运行，已停止后续 Nyanpass 安装"
}

verify_ddns_service() {
    local attempt=0
    [[ -f "$INSTALL_PATH" && ! -L "$INSTALL_PATH" && -x "$INSTALL_PATH" ]] || ddns_verification_failed "监控脚本不存在或不可执行"
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" && -r "$CONFIG_FILE" ]] || ddns_verification_failed "配置文件不存在或不可读"
    [[ -f "$SERVICE_FILE" && ! -L "$SERVICE_FILE" ]] || ddns_verification_failed "systemd 单元不存在"
    grep -Fqx "ExecStart=/bin/bash ${INSTALL_PATH} --run" "$SERVICE_FILE" || ddns_verification_failed "systemd 启动命令不正确"
    systemctl is-enabled --quiet "$SERVICE_NAME" || ddns_verification_failed "systemd 服务未启用"

    for attempt in 1 2 3; do
        sleep 2
        systemctl is-active --quiet "$SERVICE_NAME" || ddns_verification_failed "systemd 服务未保持运行"
    done

    for attempt in {1..90}; do
        sleep 2
        systemctl is-active --quiet "$SERVICE_NAME" || ddns_verification_failed "等待首次上报时服务已停止"
        if [[ -s "$CACHE_V4" || -s "$CACHE_V6" ]]; then
            log INFO "DDNS 探针验收通过：主控已接受首次地址上报"
            return 0
        fi
        if [[ -f "$REPORT_ACCEPTED_MARK" && ! -L "$REPORT_ACCEPTED_MARK" ]]; then
            log WARN "DDNS 探针验收通过：主控已认证首次地址上报，但 DNS 同步失败；探针会继续重试"
            return 0
        fi
    done
    ddns_verification_failed "180 秒内未完成首次地址上报；请检查主控、令牌和公网连通性"
}

load_ddns_config() {
    local line="" seen_server=0 seen_token=0
    [[ -r "$CONFIG_FILE" ]] || return 0
    SERVER_URL=""
    TOKEN=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
            SERVER_URL=*)
                [[ $seen_server -eq 0 ]] || fail "DDNS 配置包含重复的 SERVER_URL"
                SERVER_URL="${line#SERVER_URL=}"
                seen_server=1
                ;;
            TOKEN=*)
                [[ $seen_token -eq 0 ]] || fail "DDNS 配置包含重复的 TOKEN"
                TOKEN="${line#TOKEN=}"
                seen_token=1
                ;;
            *) fail "DDNS 配置格式无效" ;;
        esac
    done < "$CONFIG_FILE"
    [[ $seen_server -eq 1 && $seen_token -eq 1 ]] || fail "DDNS 配置缺少 SERVER_URL 或 TOKEN"
}

notify_server() {
    local ip="$1" type="$2" resp=""

    resp=$(curl -s --max-time 10 \
        -X POST "${SERVER_URL%/}/api/v1/report" \
        -H "Content-Type: application/json" \
        -H "X-Secret-Token: $TOKEN" \
        -H "Authorization: Bearer $TOKEN" \
        -d "{\"ip\":\"$ip\",\"type\":\"$type\",\"agentVersion\":\"$VERSION\"}" || true)

    if printf '%s' "$resp" | jq -e 'type == "object" and .status == "ok"' >/dev/null 2>&1; then
        : > "$REPORT_ACCEPTED_MARK"
        log INFO "[$type] 主控通知成功 -> $ip"
        return 0
    fi

    if printf '%s' "$resp" | jq -e 'type == "object" and .reportAccepted == true' >/dev/null 2>&1; then
        : > "$REPORT_ACCEPTED_MARK"
        log ERROR "[$type] 主控已认证本次上报，但 DNS 同步失败，稍后将重试：$resp"
        return 1
    fi

    log ERROR "[$type] 主控通知失败，响应：$resp"
    return 1
}

install_ddns_service() {
    need_root
    prompt_ddns_config
    install_deps
    validate_ddns_credentials_remote
    fix_locale
    log INFO "安装 DDNS 监控 systemd 服务..."

    if [[ -L "$INSTALL_DIR" || ( -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ) ]]; then
        fail "DDNS 安装目录不是安全的普通目录：$INSTALL_DIR"
    fi
    mkdir -p "$INSTALL_DIR"
    chown root:root "$INSTALL_DIR"
    chmod 0755 "$INSTALL_DIR"
    local install_tmp="" download_attempt=0 downloaded=0
    install_tmp=$(mktemp "${INSTALL_DIR}/.monitor.sh.XXXXXX")
    info "正在从 GitHub HTTPS 发布通道下载并校验 DDNS 探针..."
    for download_attempt in 1 2 3 4 5; do
        if curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 -fLSs "$MONITOR_DOWNLOAD_URL" -o "$install_tmp"; then
            downloaded=1
            break
        fi
        warn "DDNS 探针下载失败（${download_attempt}/5），稍后重试"
        [[ $download_attempt -eq 5 ]] || sleep 5
    done
    if [[ $downloaded -ne 1 ]]; then
        rm -f "$install_tmp"
        fail "连续 5 次下载 DDNS 监控脚本失败"
    fi
    if ! grep -Fq '# PulseDNS DDNS monitor payload' "$install_tmp"; then
        rm -f "$install_tmp"
        fail "下载内容不是 PulseDNS DDNS 探针"
    fi
    if ! bash -n "$install_tmp"; then
        rm -f "$install_tmp"
        fail "DDNS 监控脚本语法校验失败"
    fi
    if [[ "$(sha256sum "$install_tmp" | awk '{print $1}')" != "$MONITOR_SHA256" ]]; then
        rm -f "$install_tmp"
        fail "DDNS 监控脚本完整性校验失败"
    fi
    chown root:root "$install_tmp"
    chmod 0755 "$install_tmp"
    mv -f "$install_tmp" "$INSTALL_PATH"
    write_ddns_config

    write_ddns_service_unit "$SERVICE_FILE"

    # 必须先停止旧探针再清缓存，防止旧进程在 restart 前写回旧节点的成功结果。
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$CACHE_V4" "$CACHE_V6" "$REPORT_ACCEPTED_MARK"

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
    verify_ddns_service
    log INFO "DDNS 服务安装完成：systemctl status $SERVICE_NAME"
}

upgrade_ddns_agent() {
    need_root
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || fail "未找到现有 DDNS 探针配置"
    load_ddns_config
    install_ddns_service
    log INFO "探针已升级到 v${VERSION}，现在可以领取 Nyanpass 同步任务"
}

run_loop() {
    load_ddns_config
    validate_ddns_config
    log INFO "DDNS 监控启动，间隔 ${CHECK_INTERVAL}s，主控：$SERVER_URL"
    install_deps

    local last_v4="" last_v6="" cur_v4="" cur_v6=""
    while true; do
        cur_v4=$(get_ipv4)
        [[ -f "$CACHE_V4" ]] && last_v4=$(<"$CACHE_V4") || last_v4=""
        if [[ -n "$cur_v4" && "$cur_v4" != "$last_v4" ]]; then
            log INFO "[A] IP 变化：${last_v4:-首次} -> $cur_v4"
            notify_server "$cur_v4" "A" && echo "$cur_v4" > "$CACHE_V4"
        fi

        cur_v6=$(get_ipv6)
        [[ -f "$CACHE_V6" ]] && last_v6=$(<"$CACHE_V6") || last_v6=""
        if [[ -n "$cur_v6" && "$cur_v6" != "$last_v6" ]]; then
            log INFO "[AAAA] IP 变化：${last_v6:-首次} -> $cur_v6"
            notify_server "$cur_v6" "AAAA" && echo "$cur_v6" > "$CACHE_V6"
        fi

        sleep "$CHECK_INTERVAL"
    done
}

uninstall_ddns() {
    need_root
    log INFO "卸载 DDNS 监控服务..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    rm -rf "$INSTALL_DIR"
    rm -f "$CACHE_V4" "$CACHE_V6" "$REPORT_ACCEPTED_MARK" "$CONFIG_FILE"
    rm -rf "$TASK_STATE_DIR"
    rm -rf "$PROVISION_OUTCOME_DIR"
    rmdir "$(dirname "$PROVISION_OUTCOME_DIR")" 2>/dev/null || true
    systemctl daemon-reload
    log INFO "卸载完成；本地任务租约状态已清除，日志、BBR、SSH、Nyanpass 配置不会自动回滚"
}

confirm_uninstall_ddns() {
    local answer=""
    read -r -p "确认只卸载 DDNS 监控服务？[y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]] && uninstall_ddns
}

validate_provision_request() {
    local index=0 name="" optimize="" input=""
    [[ -n "$SERVER_URL" && -n "$TOKEN" ]] || fail "Web 一键安装缺少主控地址或探针令牌"
    [[ "$APPLY_BBR" == "1" ]] || fail "Web 一键安装必须显式传入原脚本 BBR 参数：--bbr 1"
    [[ ${#ROOT_PASSWORD} -ge 8 && ${#ROOT_PASSWORD} -le 128 ]] || fail "Web 一键安装的 root 密码长度必须为 8-128 个字符"
    [[ "$ROOT_PASSWORD" != *$'\n'* && "$ROOT_PASSWORD" != *$'\r'* ]] || fail "Web 一键安装的 root 密码不能包含换行"
    [[ ${#NYANPASS_BATCH_NAMES[@]} -ge 1 && ${#NYANPASS_BATCH_NAMES[@]} -le 16 ]] || fail "Web 一键安装需要 1-16 个 Nyanpass 实例"
    [[ ${#NYANPASS_BATCH_NAMES[@]} -eq ${#NYANPASS_BATCH_OPTIMIZES[@]} && ${#NYANPASS_BATCH_NAMES[@]} -eq ${#NYANPASS_BATCH_INPUTS[@]} ]] || fail "Web 一键安装的 Nyanpass 批量参数不完整"
    validate_ddns_config
    validate_nyanpass_release_manifest

    for ((index = 0; index < ${#NYANPASS_BATCH_NAMES[@]}; index++)); do
        name="${NYANPASS_BATCH_NAMES[$index]}"
        optimize="${NYANPASS_BATCH_OPTIMIZES[$index]}"
        input="${NYANPASS_BATCH_INPUTS[$index]}"
        [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$ ]] || fail "Nyanpass 服务名称无效：$name"
        [[ "$optimize" == "0" || "$optimize" == "1" ]] || fail "Nyanpass OPTIMIZE 只能为 0 或 1"
        parse_nyanpass_input "$input" || fail "Nyanpass 命令无效：$name"
    done
    PARSED_NYANPASS_ARGS=""
    PARSED_NYANPASS_ROLE=""
}

validate_nyanpass_release_manifest() {
    [[ "$NYANPASS_INSTALL_URL" == "https://dl.nyafw.com/download/nyanpass-install.sh" ]] || fail "Nyanpass 安装器 URL 不属于可信官方路径"
    [[ "$NYANPASS_BINARY_BASE_URL" =~ ^https://dl\.nyafw\.com/download/[A-Za-z0-9._/-]+$ ]] || fail "Nyanpass 二进制 URL 不属于可信官方路径"
    [[ "$NYANPASS_BINARY_RELEASE" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "Nyanpass 二进制发布 ID 无效"
    local digest=""
    for digest in "$NYANPASS_INSTALL_SHA256" "$NYANPASS_BINARY_AMD64_SHA256" "$NYANPASS_BINARY_AMD64V3_SHA256" "$NYANPASS_BINARY_ARM64_SHA256"; do
        [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "Nyanpass 可信发布 SHA-256 无效"
    done
}

record_provision_stage() {
    local step="$1" stage_tmp=""
    [[ -n "$PROVISION_STAGE_FILE" ]] || return 0
    case "$PROVISION_STAGE_FILE" in /var/lib/pulsedns-bootstrap-*/stage) ;; *) return 1 ;; esac
    [[ -d "${PROVISION_STAGE_FILE%/*}" && ! -L "${PROVISION_STAGE_FILE%/*}" ]] || return 1
    stage_tmp=$(mktemp "${PROVISION_STAGE_FILE}.XXXXXX") || return 1
    if ! printf '%s\n' "$step" > "$stage_tmp" \
        || ! chmod 0600 "$stage_tmp" \
        || ! mv -f "$stage_tmp" "$PROVISION_STAGE_FILE"; then
        rm -f "$stage_tmp"
        return 1
    fi
}

load_provision_config() {
    local config_path="$1" metadata="" count="" expected="" index=0 offset=0 value=""
    local -a values=()
    [[ "$ACTION" == "provision" ]] || fail "--provision-config 只能用于 Web 一键安装"
    [[ -f "$config_path" && ! -L "$config_path" ]] || fail "Web 一键安装配置文件无效"
    metadata=$(stat -c '%a:%u' "$config_path" 2>/dev/null || true)
    [[ "$metadata" == "600:0" ]] || fail "Web 一键安装配置文件必须由 root 持有且权限为 0600"
    while IFS= read -r -d '' value; do
        values[${#values[@]}]="$value"
    done < "$config_path"
    rm -f -- "$config_path"
    [[ ${#values[@]} -ge 12 && "${values[0]}" == "PULSEDNS_PROVISION_V2" ]] || fail "Web 一键安装配置文件格式无效"
    NYANPASS_INSTALL_URL="${values[4]}"
    NYANPASS_INSTALL_SHA256="${values[5]}"
    NYANPASS_BINARY_BASE_URL="${values[6]}"
    NYANPASS_BINARY_RELEASE="${values[7]}"
    NYANPASS_BINARY_AMD64_SHA256="${values[8]}"
    NYANPASS_BINARY_AMD64V3_SHA256="${values[9]}"
    NYANPASS_BINARY_ARM64_SHA256="${values[10]}"
    count="${values[11]}"
    [[ "$count" =~ ^[1-9][0-9]*$ && "$count" -le 16 ]] || fail "Web 一键安装配置中的实例数量无效"
    expected=$((12 + count * 3))
    [[ ${#values[@]} -eq $expected ]] || fail "Web 一键安装配置文件字段不完整"
    SERVER_URL="${values[1]}"
    TOKEN="${values[2]}"
    ROOT_PASSWORD="${values[3]}"
    NYANPASS_BATCH_NAMES=()
    NYANPASS_BATCH_OPTIMIZES=()
    NYANPASS_BATCH_INPUTS=()
    for ((index = 0; index < count; index++)); do
        offset=$((12 + index * 3))
        NYANPASS_BATCH_NAMES+=("${values[$offset]}")
        NYANPASS_BATCH_OPTIMIZES+=("${values[$((offset + 1))]}")
        NYANPASS_BATCH_INPUTS+=("${values[$((offset + 2))]}")
    done
    values=()
}

provision_node() {
    need_root
    validate_provision_request
    install_deps
    validate_ddns_credentials_remote
    # The DDNS service starts its remote-task worker before the bootstrap
    # Nyanpass batch runs. Hold the same machine-wide lock as that worker so a
    # queued Web task cannot overlap either the first bootstrap or a manual
    # retry after a partial failure.
    exec 8>"$TASK_LOCK_FILE"
    flock 8
    log INFO "开始 Web 一键安装；外部依赖完成后才会修改 SSH 登录凭据..."
    fix_locale
    install_ddns_service
    record_provision_stage ddns || log WARN "无法记录 DDNS 完成阶段"
    install_nyanpass_batch
    record_provision_stage nyanpass || log WARN "无法记录 Nyanpass 完成阶段"
    [[ "$APPLY_BBR" == "1" ]] && configure_bbr
    record_provision_stage bbr || log WARN "无法记录 BBR 完成阶段"
    configure_ssh
    record_provision_stage ssh || log WARN "无法记录 SSH 完成阶段"
    verify_ddns_service
    exec 8>&-
    log INFO "Web 一键安装全部完成"
}

install_all() {
    need_root
    log INFO "开始完整安装..."
    fix_locale
    install_ddns_service
    install_deps
    if [[ ${#NYANPASS_BATCH_NAMES[@]} -gt 0 ]]; then
        install_nyanpass_batch
    else
        install_nyanpass_many
    fi
    configure_bbr
    configure_ssh
    log INFO "全部安装完成"
    log INFO "查看 DDNS 日志：tail -f $LOG_FILE"
}

menu() {
    local choice=""
    while true; do
        printf '\n%bPulseDNS 安装管理器 v%s%b\n' "$blue" "$VERSION" "$reset"
        printf '  1) 完整安装（DDNS + Nyanpass + BBR + SSH）\n'
        printf '  2) 仅安装 / 重新配置 DDNS\n'
        printf '  3) 安装 Nyanpass（可连续添加多个实例）\n'
        printf '  4) 配置 root 密码和 SSH\n'
        printf '  5) 配置 BBR + fq\n'
        printf '  6) 仅卸载 DDNS\n'
        printf '  7) 升级现有探针（启用远程同步）\n'
        printf '  0) 退出\n\n'
        read -r -p "请选择 [0-7]: " choice
        case "$choice" in
            1) install_all ;;
            2) install_ddns_service ;;
            3) install_nyanpass_many ;;
            4) configure_ssh ;;
            5) configure_bbr ;;
            6) confirm_uninstall_ddns ;;
            7) upgrade_ddns_agent ;;
            0) return 0 ;;
            *) warn "无效选项" ;;
        esac
    done
}

ACTION="${1:-menu}"
if [[ $# -gt 0 ]]; then
    shift
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)
            [[ $# -ge 2 ]] || fail "--server 缺少参数"
            SERVER_URL="$2"
            shift 2
            ;;
        --token)
            [[ $# -ge 2 ]] || fail "--token 缺少参数"
            TOKEN="$2"
            shift 2
            ;;
        --root-password)
            [[ $# -ge 2 ]] || fail "--root-password 缺少参数"
            ROOT_PASSWORD="$2"
            shift 2
            ;;
        --bbr)
            [[ $# -ge 2 ]] || fail "--bbr 缺少参数"
            [[ "$2" == "1" ]] || fail "原脚本 Web 一键安装的 --bbr 只能为 1"
            APPLY_BBR="$2"
            shift 2
            ;;
        --provision-config)
            [[ $# -ge 2 ]] || fail "--provision-config 缺少参数"
            load_provision_config "$2"
            shift 2
            ;;
        --nyanpass-command|--nyanpass-args)
            [[ $# -ge 2 ]] || fail "$1 缺少参数"
            NYANPASS_INPUT="$2"
            shift 2
            ;;
        --nyanpass-name)
            [[ $# -ge 2 ]] || fail "--nyanpass-name 缺少参数"
            NYANPASS_NAME="$2"
            shift 2
            ;;
        --nyanpass-optimize)
            [[ $# -ge 2 ]] || fail "--nyanpass-optimize 缺少参数"
            NYANPASS_OPTIMIZE="$2"
            shift 2
            ;;
        --nyanpass-unattended)
            NYANPASS_UNATTENDED="1"
            shift
            ;;
        --nyanpass-instance)
            [[ $# -ge 4 ]] || fail "--nyanpass-instance 需要 NAME OPTIMIZE ARGS"
            NYANPASS_BATCH_NAMES+=("$2")
            NYANPASS_BATCH_OPTIMIZES+=("$3")
            NYANPASS_BATCH_INPUTS+=("$4")
            shift 4
            ;;
        *)
            fail "未知参数：$1"
            ;;
    esac
done

case "$ACTION" in
    menu) menu ;;
    all|install) install_all ;;
    provision) provision_node ;;
    ddns) install_ddns_service ;;
    nyanpass) install_nyanpass_many ;;
    agent-upgrade) upgrade_ddns_agent ;;
    ssh) configure_ssh ;;
    bbr) configure_bbr ;;
    uninstall|--uninstall) uninstall_ddns ;;
    --run) run_loop ;;
    *) fail "未知操作：$ACTION" ;;
esac
