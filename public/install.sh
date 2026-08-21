#!/usr/bin/env bash
# PulseDNS / 原 DDNS 脚本兼容安装器
#
# 保留原仓库的 DDNS、SSH、Nyanpass、BBR 行为；主控地址和令牌改为运行时配置，
# 不包含原仓库里写死的密码或令牌。
set -euo pipefail

# 避免尚未生成 en_US.UTF-8 时 bash/工具链反复输出 setlocale 警告。
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

VERSION="0.7.2"
SERVER_URL="${SERVER_URL:-}"
TOKEN="${TOKEN:-}"
ROOT_PASSWORD="${ROOT_PASSWORD:-}"
CHECK_INTERVAL=10
LOG_FILE="/var/log/ddns-monitor.log"
CACHE_V4="/tmp/.ddns_last_ipv4"
CACHE_V6="/tmp/.ddns_last_ipv6"
INSTALL_DIR="/opt/ddns-monitor"
INSTALL_PATH="${INSTALL_DIR}/monitor.sh"
CONFIG_FILE="/etc/ddns-monitor.conf"
SERVICE_NAME="ddns-monitor"

NYANPASS_INSTALL_URL="https://dl.nyafw.com/download/nyanpass-install.sh"
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

install_deps() {
    local missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v timeout >/dev/null 2>&1 || missing+=("coreutils")

    [[ ${#missing[@]} -eq 0 ]] && return 0

    log INFO "安装依赖：${missing[*]}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q "${missing[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q "${missing[@]}"
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache "${missing[@]}"
    else
        log ERROR "未找到支持的包管理器，请手动安装：${missing[*]}"
        exit 1
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
    local root_password="$ROOT_PASSWORD" root_password_confirm="" sshd_config="/etc/ssh/sshd_config"

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
        fi
    done

    if printf 'root:%s\n' "$root_password" | chpasswd 2>/dev/null; then
        log INFO "root 密码设置完成"
    else
        fail "root 密码设置失败"
    fi
    root_password=""
    root_password_confirm=""
    ROOT_PASSWORD=""

    if [[ ! -f "$sshd_config" ]]; then
        log WARN "未找到 $sshd_config，跳过 SSH 配置"
        return 0
    fi

    cp "$sshd_config" "${sshd_config}.bak.$(date +%s)" 2>/dev/null || true
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/g' "$sshd_config" 2>/dev/null || true
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/g' "$sshd_config" 2>/dev/null || true
    rm -rf /etc/ssh/sshd_config.d 2>/dev/null || true

    if systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null; then
        log INFO "SSH 服务重启完成"
    else
        log WARN "SSH 服务重启可能失败"
    fi
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
    local installer="" digest="" answer="" install_ok=false
    need_root
    install_deps

    if ! parse_nyanpass_input "$input"; then
        fail "Nyanpass 命令无效。只接受官方安装命令，或 -t TOKEN -u HTTPS_URL；出口仅多一个独立的 -o 参数"
    fi
    if [[ -n "$service_name" && ! "$service_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$ ]]; then
        fail "Nyanpass 服务名称只能包含字母、数字、点、下划线和短横线"
    fi
    [[ "$optimize" == "0" || "$optimize" == "1" ]] || fail "Nyanpass OPTIMIZE 只能为 0 或 1"
    [[ "$unattended" == "0" || "$unattended" == "1" ]] || fail "Nyanpass 无人值守标记无效"

    installer=$(mktemp /tmp/nyanpass-install.XXXXXX.sh)
    if ! curl -fLSs "$NYANPASS_INSTALL_URL" -o "$installer"; then
        rm -f "$installer"
        fail "Nyanpass 官方安装器下载失败"
    fi

    digest=$(sha256sum "$installer" | awk '{print $1}')
    warn "识别为 Nyanpass ${PARSED_NYANPASS_ROLE}；即将执行官方安装器${service_name:+（${service_name}）}"
    warn "安装器 SHA-256：$digest"
    if [[ "$unattended" == "1" ]]; then
        log INFO "无人值守安装 Nyanpass：${service_name:-未命名} (OPTIMIZE=${optimize})"
    else
        read -r -p "确认继续？[y/N]: " answer
        if [[ ! "$answer" =~ ^[Yy]$ ]]; then
            rm -f "$installer"
            warn "已取消"
            return 0
        fi
    fi

    if [[ -n "$service_name" ]]; then
        if S="$service_name" OPTIMIZE="$optimize" timeout "$NYANPASS_TIMEOUT" bash "$installer" rel_nodeclient "$PARSED_NYANPASS_ARGS" 2>&1 | tee -a "$LOG_FILE"; then
            install_ok=true
        fi
    else
        if timeout "$NYANPASS_TIMEOUT" bash "$installer" rel_nodeclient "$PARSED_NYANPASS_ARGS" 2>&1 | tee -a "$LOG_FILE"; then
            install_ok=true
        fi
    fi
    if [[ "$install_ok" == true ]]; then
        log INFO "Nyanpass ${PARSED_NYANPASS_ROLE}安装完成"
    else
        rm -f "$installer"
        fail "Nyanpass 安装失败或超时"
    fi
    rm -f "$installer"
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

get_ipv4() {
    local ip="" url=""
    for url in "${IPV4_SERVICES[@]}"; do
        ip=$(curl -4 -s --max-time 5 --retry 2 "$url" 2>/dev/null \
            | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)
        [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && echo "$ip" && return 0
    done
    echo ""
}

get_ipv6() {
    local ip="" url=""
    for url in "${IPV6_SERVICES[@]}"; do
        ip=$(curl -6 -s --max-time 5 --retry 2 "$url" 2>/dev/null \
            | grep -oE '([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}' | head -1 || true)
        [[ -n "$ip" ]] && echo "$ip" && return 0
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

write_ddns_config() {
    local config_tmp
    config_tmp=$(mktemp /etc/ddns-monitor.conf.XXXXXX)
    {
        printf 'SERVER_URL=%s\n' "$SERVER_URL"
        printf 'TOKEN=%s\n' "$TOKEN"
    } > "$config_tmp"
    chown root:root "$config_tmp"
    chmod 0600 "$config_tmp"
    mv -f "$config_tmp" "$CONFIG_FILE"
}

write_ddns_service_unit() {
    local target="$1"
    cat > "$target" <<SERVICE_EOF
[Unit]
Description=DDNS IP Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash ${INSTALL_PATH} --run
Restart=always
RestartSec=10
StartLimitIntervalSec=120
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF
    chmod 0644 "$target"
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
        -d "{\"ip\":\"$ip\",\"type\":\"$type\"}" || true)

    if echo "$resp" | grep -q '"status":"ok"'; then
        log INFO "[$type] 主控通知成功 -> $ip"
        return 0
    fi

    log ERROR "[$type] 主控通知失败，响应：$resp"
    return 1
}

install_ddns_service() {
    need_root
    prompt_ddns_config
    fix_locale
    install_deps
    log INFO "安装 DDNS 监控 systemd 服务..."

    if [[ -L "$INSTALL_DIR" || ( -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ) ]]; then
        fail "DDNS 安装目录不是安全的普通目录：$INSTALL_DIR"
    fi
    mkdir -p "$INSTALL_DIR"
    chown root:root "$INSTALL_DIR"
    chmod 0755 "$INSTALL_DIR"
    local install_tmp=""
    install_tmp=$(mktemp "${INSTALL_DIR}/.monitor.sh.XXXXXX")
    info "正在从主控下载专用 DDNS 探针..."
    if ! curl --proto '=http,https' --proto-redir '=http,https' -fLSs --max-time 30 "${SERVER_URL%/}/monitor.sh" -o "$install_tmp"; then
        rm -f "$install_tmp"
        fail "从主控下载 DDNS 监控脚本失败"
    fi
    if ! grep -Fq '# PulseDNS DDNS monitor payload' "$install_tmp"; then
        rm -f "$install_tmp"
        fail "下载内容不是 PulseDNS DDNS 探针"
    fi
    if ! bash -n "$install_tmp"; then
        rm -f "$install_tmp"
        fail "DDNS 监控脚本语法校验失败"
    fi
    chown root:root "$install_tmp"
    chmod 0755 "$install_tmp"
    mv -f "$install_tmp" "$INSTALL_PATH"
    write_ddns_config

    write_ddns_service_unit "/etc/systemd/system/${SERVICE_NAME}.service"

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
    log INFO "DDNS 服务安装完成：systemctl status $SERVICE_NAME"
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
    rm -f "$CACHE_V4" "$CACHE_V6" "$CONFIG_FILE"
    systemctl daemon-reload
    log INFO "卸载完成；日志、BBR、SSH、Nyanpass 配置不会自动回滚"
}

confirm_uninstall_ddns() {
    local answer=""
    read -r -p "确认只卸载 DDNS 监控服务？[y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]] && uninstall_ddns
}

install_all() {
    need_root
    log INFO "开始完整安装..."
    fix_locale
    configure_ssh
    install_ddns_service
    install_deps
    if [[ ${#NYANPASS_BATCH_NAMES[@]} -gt 0 ]]; then
        install_nyanpass_batch
    else
        install_nyanpass_many
    fi
    configure_bbr
    log INFO "全部安装完成"
    log INFO "查看 DDNS 日志：tail -f $LOG_FILE"
}

menu() {
    local choice=""
    while true; do
        printf '\n%bPulseDNS 安装管理器 v%s%b\n' "$blue" "$VERSION" "$reset"
        printf '  1) 完整安装（SSH + DDNS + Nyanpass + BBR）\n'
        printf '  2) 仅安装 / 重新配置 DDNS\n'
        printf '  3) 安装 Nyanpass（可连续添加多个实例）\n'
        printf '  4) 配置 root 密码和 SSH\n'
        printf '  5) 配置 BBR + fq\n'
        printf '  6) 仅卸载 DDNS\n'
        printf '  0) 退出\n\n'
        read -r -p "请选择 [0-6]: " choice
        case "$choice" in
            1) install_all ;;
            2) install_ddns_service ;;
            3) install_nyanpass_many ;;
            4) configure_ssh ;;
            5) configure_bbr ;;
            6) confirm_uninstall_ddns ;;
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
    ddns) install_ddns_service ;;
    nyanpass) install_nyanpass_many ;;
    ssh) configure_ssh ;;
    bbr) configure_bbr ;;
    uninstall|--uninstall) uninstall_ddns ;;
    --run) run_loop ;;
    *) fail "未知操作：$ACTION" ;;
esac
