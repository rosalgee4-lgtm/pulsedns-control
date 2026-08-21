#!/usr/bin/env bash
# PulseDNS DDNS monitor payload
# 仅负责按原脚本逻辑检测 IPv4/IPv6，并在地址变化时通知主控。
set -euo pipefail

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

VERSION="0.7.5"
CHECK_INTERVAL=10
LOG_FILE="/var/log/ddns-monitor.log"
CACHE_V4="/tmp/.ddns_last_ipv4"
CACHE_V6="/tmp/.ddns_last_ipv6"
CONFIG_FILE="/etc/ddns-monitor.conf"
SERVER_URL=""
TOKEN=""

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

log() {
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" | tee -a "$LOG_FILE"
}

fail() {
    printf '[FAIL] %s\n' "$*" >&2
    exit 1
}

install_deps() {
    command -v curl >/dev/null 2>&1 && return 0
    log WARN "curl 未安装，自动安装..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q curl
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q curl
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl
    fi
    command -v curl >/dev/null 2>&1 || fail "curl 安装失败"
    log INFO "依赖安装完成"
}

load_config() {
    local line="" seen_server=0 seen_token=0 port="" authority=""
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" && -r "$CONFIG_FILE" ]] || fail "DDNS 配置文件不存在或不可读"
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
    [[ "$SERVER_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]{1,64})?/?$ ]] || fail "SERVER_URL 必须是 HTTP/HTTPS 主控地址"
    if [[ "$SERVER_URL" == http://* && ! "$SERVER_URL" =~ ^http://[A-Za-z0-9.-]+:[0-9]{1,5}/[a-f0-9]{32}/?$ ]]; then
        fail "HTTP 主控地址必须包含端口和 32 位随机访问路径"
    fi
    authority="${SERVER_URL#*://}"
    authority="${authority%%/*}"
    if [[ "$authority" == *:* ]]; then
        port="${authority##*:}"
        [[ $((10#$port)) -ge 1 && $((10#$port)) -le 65535 ]] || fail "SERVER_URL 端口无效"
    fi
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ && ${#TOKEN} -ge 8 && ${#TOKEN} -le 512 ]] || fail "TOKEN 格式无效"
    SERVER_URL="${SERVER_URL%/}"
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

notify_server() {
    local ip="$1" type="$2" resp=""
    resp=$(curl -s --max-time 10 \
        -X POST "${SERVER_URL}/api/v1/report" \
        -H "Content-Type: application/json" \
        -H "X-Secret-Token: $TOKEN" \
        -d "{\"ip\":\"$ip\",\"type\":\"$type\"}" || true)

    if echo "$resp" | grep -q '"status":"ok"'; then
        log INFO "[$type] 主控通知成功 -> $ip"
        return 0
    fi
    log ERROR "[$type] 主控通知失败，响应：$resp"
    return 1
}

run_loop() {
    load_config
    install_deps
    log INFO "DDNS 监控启动，间隔 ${CHECK_INTERVAL}s，主控：$SERVER_URL"

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

case "${1:---run}" in
    --run) run_loop ;;
    *) fail "DDNS 探针只支持 --run" ;;
esac
