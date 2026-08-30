#!/usr/bin/env bash
# PulseDNS DDNS monitor payload
# 负责检测 IPv4/IPv6，并领取固定类型的 Nyanpass 安装任务；不会执行主控下发的 Shell 命令。
set -euo pipefail

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

VERSION="0.8.2"
CHECK_INTERVAL=10
DNS_RECONCILE_INTERVAL=600
REPORT_RETRY_MAX=300
LOG_FILE="/var/log/ddns-monitor.log"
CACHE_V4="/tmp/.ddns_last_ipv4"
CACHE_V6="/tmp/.ddns_last_ipv6"
REPORT_ACCEPTED_MARK="/run/ddns-monitor-report-accepted"
CONFIG_FILE="/etc/ddns-monitor.conf"
TASK_STATE_DIR="/var/lib/ddns-monitor/tasks"
TASK_LOCK_FILE="/run/ddns-monitor-nyanpass.lock"
PROVISION_OUTCOME_DIR="/var/lib/ddns-monitor/provision-outcomes"
NYANPASS_INSTALL_URL="https://dl.nyafw.com/download/nyanpass-install.sh"
NYANPASS_INSTALL_SHA256="ece867743399c6a4c262ca31292b79d81a97b0a6efa98ef309f75fdd3e5ca624"
NYANPASS_BINARY_BASE_URL="https://dl.nyafw.com/download/zf-nc20260412"
NYANPASS_BINARY_RELEASE="0e6b2dce-7547-4b51-ab4f-36a45b92649a"
NYANPASS_BINARY_AMD64_SHA256="dcd751c7cb6efbe4c28fe35e026b312e01935a7dc81cb5a37386d67c2539da95"
NYANPASS_BINARY_AMD64V3_SHA256="46b6c894a37b606888f491c6273a6a1d0cec4a176e7760c4ffb9b3c89c921a24"
NYANPASS_BINARY_ARM64_SHA256="06a97fb08e5e3579e3b8e92e5c6d17a60edee6c6c77fb0274d35cf378898b365"
NYANPASS_BINARY_URL=""
NYANPASS_BINARY_SHA256=""
NYANPASS_TIMEOUT=600
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
    local -a missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")
    command -v timeout >/dev/null 2>&1 || missing+=("coreutils")
    command -v flock >/dev/null 2>&1 || missing+=("util-linux")
    command -v unzip >/dev/null 2>&1 || missing+=("unzip")
    [[ ${#missing[@]} -eq 0 ]] && return 0
    log WARN "安装探针依赖：${missing[*]}"
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
        fail "无法安装 curl、jq、coreutils、util-linux 和 unzip"
    fi
    command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && command -v flock >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 || fail "探针依赖安装失败"
    log INFO "探针依赖安装完成"
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

trim_space() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
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

notify_server() {
    local ip="$1" type="$2" resp=""
    resp=$(curl -s --max-time 10 -X POST "${SERVER_URL}/api/v1/report" \
        -H "Content-Type: application/json" \
        -H "X-Secret-Token: $TOKEN" \
        -d "{\"ip\":\"$ip\",\"type\":\"$type\",\"agentVersion\":\"$VERSION\"}" || true)
    if printf '%s' "$resp" | jq -e 'type == "object" and .status == "ok"' >/dev/null 2>&1; then
        : > "$REPORT_ACCEPTED_MARK"
        log INFO "[$type] 主控通知成功 -> $ip"
        return 0
    fi
    if printf '%s' "$resp" | jq -e 'type == "object" and .reportAccepted == true' >/dev/null 2>&1; then
        : > "$REPORT_ACCEPTED_MARK"
        log ERROR "[$type] 主控已保存当前 IP，但 DNS 同步失败；探针将按周期重新校准"
        return 0
    fi
    log ERROR "[$type] 主控通知失败"
    return 1
}

valid_task_uuid() {
    [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
}

valid_task_lease() {
    [[ "$1" =~ ^pd_[a-f0-9]{64}$ ]]
}

valid_ack_payload() {
    local job_id="$1" lease_token="$2" outcome="$3" error_code="${4:-}"
    valid_task_uuid "$job_id" && valid_task_lease "$lease_token" || return 1
    case "$outcome:$error_code" in
        succeeded:|failed:installer_download|failed:installer_invalid|failed:validation_failed|uncertain:install_failed|uncertain:install_timeout|uncertain:local_state) return 0 ;;
        *) return 1 ;;
    esac
}

ack_nyanpass_job() {
    local job_id="$1" lease_token="$2" outcome="$3" error_code="${4:-}" body="" response="" response_body="" http_code="" attempt=0
    valid_ack_payload "$job_id" "$lease_token" "$outcome" "$error_code" || return 2
    body=$(jq -cn --arg jobId "$job_id" --arg leaseToken "$lease_token" --arg outcome "$outcome" --arg errorCode "$error_code" \
        '{jobId:$jobId,leaseToken:$leaseToken,outcome:$outcome} + (if $errorCode == "" then {} else {errorCode:$errorCode} end)')
    for attempt in 1 2 3 4 5 6 7 8; do
        response=$(curl -sS --connect-timeout 5 --max-time 20 -X POST "${SERVER_URL}/api/v1/tasks" \
            -H "Content-Type: application/json" -H "X-Secret-Token: $TOKEN" -H "X-Agent-Version: $VERSION" -d "$body" -w $'\n%{http_code}' 2>/dev/null || true)
        http_code="${response##*$'\n'}"
        response_body="${response%$'\n'*}"
        if [[ "$http_code" == "200" ]] && printf '%s' "$response_body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
            return 0
        fi
        if [[ "$http_code" =~ ^4[0-9][0-9]$ && "$http_code" != "408" && "$http_code" != "429" ]]; then
            return 2
        fi
        sleep $((attempt * 2))
    done
    return 1
}

write_pending_ack() {
    local job_id="$1" lease_token="$2" outcome="$3" error_code="${4:-}" pending_tmp=""
    valid_ack_payload "$job_id" "$lease_token" "$outcome" "$error_code" || return 1
    pending_tmp=$(mktemp "${TASK_STATE_DIR}/.${job_id}.ack.XXXXXX")
    printf '%s\n%s\n%s\n%s\n' "$job_id" "$lease_token" "$outcome" "$error_code" > "$pending_tmp"
    chmod 0600 "$pending_tmp"
    mv -f "$pending_tmp" "${TASK_STATE_DIR}/${job_id}.ack"
}

retry_provision_outcome() {
    local outcome_file="" filename="" generation="" attempt_id="" outcome="" body="" response="" disposition=""
    [[ -d "$PROVISION_OUTCOME_DIR" && ! -L "$PROVISION_OUTCOME_DIR" ]] || return 0
    shopt -s nullglob
    for outcome_file in "$PROVISION_OUTCOME_DIR"/*.json; do
        [[ -f "$outcome_file" && ! -L "$outcome_file" ]] || continue
        filename="${outcome_file##*/}"
        if [[ ! "$filename" =~ ^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(succeeded|failed)\.json$ ]]; then
            continue
        fi
        generation="${BASH_REMATCH[1]}"; attempt_id="${BASH_REMATCH[2]}"; outcome="${BASH_REMATCH[3]}"
        body=$(<"$outcome_file")
        if ! printf '%s' "$body" | jq -e --argjson generation "$generation" --arg attemptId "$attempt_id" --arg outcome "$outcome" '
            type == "object" and (keys | sort) == (["attemptId","generation","outcome","phase","protocol"] | sort) and
            .protocol == 1 and .phase == "finish" and .generation == $generation and
            .attemptId == $attemptId and .outcome == $outcome' >/dev/null 2>&1; then
            continue
        fi
        response=$(curl -sS --connect-timeout 5 --max-time 20 -X POST "${SERVER_URL}/api/v1/provision" \
            -H "Content-Type: application/json" -H "X-Secret-Token: $TOKEN" -H "X-Agent-Version: $VERSION" -d "$body" 2>/dev/null || true)
        disposition=$(printf '%s' "$response" | jq -r 'if .status == "ok" then .disposition // "" else "" end' 2>/dev/null || true)
        if [[ "$disposition" == "accepted" || "$disposition" == "duplicate" || "$disposition" == "stale" ]]; then
            rm -f "$outcome_file"
        elif [[ "$disposition" == "conflict" ]]; then
            mv -f "$outcome_file" "${outcome_file}.rejected"
            log ERROR "开机安装回执 ${filename} 与主控终态冲突，已停止自动重试"
        fi
    done
    shopt -u nullglob
}

retry_pending_acks() {
    local ack_file="" job_id="" lease_token="" outcome="" error_code="" ack_status=0
    local -a values=()
    [[ -d "$TASK_STATE_DIR" ]] || return 0
    shopt -s nullglob
    for ack_file in "$TASK_STATE_DIR"/*.ack; do
        mapfile -t values < "$ack_file"
        [[ ${#values[@]} -ge 3 ]] || continue
        job_id="${values[0]}"; lease_token="${values[1]}"; outcome="${values[2]}"; error_code="${values[3]:-}"
        valid_ack_payload "$job_id" "$lease_token" "$outcome" "$error_code" || continue
        if ack_nyanpass_job "$job_id" "$lease_token" "$outcome" "$error_code"; then
            rm -f "$ack_file" "${TASK_STATE_DIR}/${job_id}.started" "${TASK_STATE_DIR}/${job_id}.done"
        else
            ack_status=$?
            if [[ $ack_status -eq 2 ]]; then
                mv -f "$ack_file" "${TASK_STATE_DIR}/${job_id}.rejected"
                log ERROR "任务 ${job_id} 的回执被主控终态拒绝，已停止自动重试"
            fi
        fi
    done
    shopt -u nullglob
}

recover_local_task_state() {
    local started_file="" job_id="" lease_token="" revision=""
    local -a values=()
    [[ -d "$TASK_STATE_DIR" ]] || return 0
    shopt -s nullglob
    for started_file in "$TASK_STATE_DIR"/*.started; do
        job_id="${started_file##*/}"; job_id="${job_id%.started}"
        [[ -e "${TASK_STATE_DIR}/${job_id}.ack" || -e "${TASK_STATE_DIR}/${job_id}.rejected" ]] && continue
        mapfile -t values < "$started_file"
        [[ ${#values[@]} -ge 3 ]] || continue
        lease_token="${values[1]}"; revision="${values[2]}"
        [[ "${values[0]}" == "$job_id" ]] && valid_task_uuid "$job_id" && valid_task_lease "$lease_token" && [[ "$revision" =~ ^[1-9][0-9]*$ ]] || continue
        if [[ -e "${TASK_STATE_DIR}/${job_id}.done" ]]; then
            write_pending_ack "$job_id" "$lease_token" succeeded
        else
            write_pending_ack "$job_id" "$lease_token" uncertain local_state
        fi
    done
    shopt -u nullglob
}

validate_nyanpass_payload() {
    local service_name="$1" role="$2" panel_url="$3" client_token="$4" optimize="$5" authority="" port=""
    [[ "$service_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$ ]] || return 1
    [[ "$role" == "inbound" || "$role" == "outbound" ]] || return 1
    [[ "$client_token" =~ ^[A-Za-z0-9._:-]{8,512}$ ]] || return 1
    [[ "$optimize" == "0" || "$optimize" == "1" ]] || return 1
    [[ "$panel_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/@%+=,-]*)?$ ]] || return 1
    authority="${panel_url#https://}"
    authority="${authority%%/*}"
    if [[ "$authority" == *:* ]]; then
        port="${authority##*:}"
        [[ $((10#$port)) -ge 1 && $((10#$port)) -le 65535 ]] || return 1
    fi
}

poll_nyanpass_job() {
    local response="" status="" job_id="" action="" revision="" lease_token="" instance_id=""
    local service_name="" role="" panel_url="" client_token="" optimize="" optimize_env="" args="" installer="" archive="" extract_dir="" installer_log="" error_code="" install_status=1
    retry_provision_outcome
    recover_local_task_state
    retry_pending_acks
    response=$(curl -sS --connect-timeout 5 --max-time 20 "${SERVER_URL}/api/v1/tasks" \
        -H "X-Secret-Token: $TOKEN" -H "X-Agent-Version: $VERSION" 2>/dev/null || true)
    status=$(printf '%s' "$response" | jq -r '.status // empty' 2>/dev/null || true)
    [[ "$status" == "job" ]] || return 0
    if ! printf '%s' "$response" | jq -e '
        .protocol == 1 and .job.action == "nyanpass_apply_v1" and
        (.job.id | type == "string") and (.job.revision | type == "number") and
        (.job.leaseToken | type == "string") and (.job.payload.instanceId | type == "string") and
        (.job.payload.serviceName | type == "string") and
        (.job.payload.role == "inbound" or .job.payload.role == "outbound") and
        (.job.payload.panelUrl | type == "string") and (.job.payload.clientToken | type == "string") and
        (.job.payload.optimize | type == "boolean")' >/dev/null 2>&1; then
        return 0
    fi

    job_id=$(printf '%s' "$response" | jq -r '.job.id')
    action=$(printf '%s' "$response" | jq -r '.job.action')
    revision=$(printf '%s' "$response" | jq -r '.job.revision')
    lease_token=$(printf '%s' "$response" | jq -r '.job.leaseToken')
    instance_id=$(printf '%s' "$response" | jq -r '.job.payload.instanceId')
    service_name=$(printf '%s' "$response" | jq -r '.job.payload.serviceName')
    role=$(printf '%s' "$response" | jq -r '.job.payload.role')
    panel_url=$(printf '%s' "$response" | jq -r '.job.payload.panelUrl')
    client_token=$(printf '%s' "$response" | jq -r '.job.payload.clientToken')
    optimize=$(printf '%s' "$response" | jq -r 'if .job.payload.optimize then "1" else "0" end')

    if ! valid_task_uuid "$job_id" || ! valid_task_lease "$lease_token"; then
        log ERROR "主控返回了不安全的任务标识，已拒绝且不会写入本地状态"
        return 0
    fi
    if [[ "$action" != "nyanpass_apply_v1" ]] || ! valid_task_uuid "$instance_id" || [[ ! "$revision" =~ ^[1-9][0-9]*$ ]] || \
        ! validate_nyanpass_payload "$service_name" "$role" "$panel_url" "$client_token" "$optimize"; then
        # The lease is already active. Persist the failure before attempting the
        # acknowledgement so a temporary control-plane outage cannot strand the
        # task in running state until its lease expires.
        umask 077
        mkdir -p "$TASK_STATE_DIR"
        chmod 0700 "$(dirname "$TASK_STATE_DIR")" "$TASK_STATE_DIR" 2>/dev/null || true
        write_pending_ack "$job_id" "$lease_token" failed validation_failed
        if ack_nyanpass_job "$job_id" "$lease_token" failed validation_failed; then
            rm -f "${TASK_STATE_DIR}/${job_id}.ack"
        fi
        return 0
    fi

    umask 077
    mkdir -p "$TASK_STATE_DIR"
    chmod 0700 "$(dirname "$TASK_STATE_DIR")" "$TASK_STATE_DIR" 2>/dev/null || true
    if [[ -e "${TASK_STATE_DIR}/${job_id}.done" ]]; then
        write_pending_ack "$job_id" "$lease_token" succeeded
        retry_pending_acks
        return 0
    fi
    if [[ -e "${TASK_STATE_DIR}/${job_id}.started" ]]; then
        write_pending_ack "$job_id" "$lease_token" uncertain local_state
        retry_pending_acks
        return 0
    fi
    printf '%s\n%s\n%s\n' "$job_id" "$lease_token" "$revision" > "${TASK_STATE_DIR}/${job_id}.started"
    installer=$(mktemp /tmp/nyanpass-remote.XXXXXX.sh)
    archive=$(mktemp /tmp/nyanpass-remote.XXXXXX.zip)
    extract_dir=$(mktemp -d /tmp/nyanpass-remote.XXXXXX.d)
    installer_log=$(mktemp /tmp/nyanpass-remote.XXXXXX.log)
    trap 'rm -f -- "${installer:-}" "${archive:-}" "${installer_log:-}"; case "${extract_dir:-}" in /tmp/nyanpass-remote.*.d) rm -rf -- "$extract_dir" ;; esac' EXIT
    if ! curl --proto '=https' --proto-redir '=https' -fLSs --max-time 60 "$NYANPASS_INSTALL_URL" -o "$installer"; then
        error_code="installer_download"
    elif [[ "$(sha256sum "$installer" | awk '{print $1}')" != "$NYANPASS_INSTALL_SHA256" ]] || ! bash -n "$installer"; then
        error_code="installer_invalid"
    elif ! select_nyanpass_binary; then
        error_code="installer_invalid"
    elif ! curl --proto '=https' --proto-redir '=https' -fLSs --max-time 120 "$NYANPASS_BINARY_URL" -o "$archive"; then
        error_code="installer_download"
    elif [[ "$(sha256sum "$archive" | awk '{print $1}')" != "$NYANPASS_BINARY_SHA256" ]] || ! verify_nyanpass_archive "$archive" "$extract_dir"; then
        error_code="installer_invalid"
    elif ! stage_nyanpass_binary "$service_name" "$extract_dir/rel_nodeclient"; then
        error_code="install_failed"
    else
        args="-t ${client_token} -u ${panel_url}"
        [[ "$role" == "outbound" ]] && args="-o ${args}"
        if ! write_nyanpass_start_script "$service_name" "$args"; then
            error_code="install_failed"
            install_status=1
        else
            if [[ "$optimize" == "1" ]]; then optimize_env="1"; fi
            set +e
            env "S=$service_name" "REINSTALL=1" "OPTIMIZE=$optimize_env" "NO_DOWNLOAD=1" timeout --kill-after=30s "$NYANPASS_TIMEOUT" bash "$installer" rel_nodeclient "$args" >"$installer_log" 2>&1
            install_status=$?
            set -e
        fi
        if [[ $install_status -eq 0 ]]; then
            printf '%s\n' "$revision" > "${TASK_STATE_DIR}/${job_id}.done"
            write_pending_ack "$job_id" "$lease_token" succeeded
            if ack_nyanpass_job "$job_id" "$lease_token" succeeded; then
                log INFO "Nyanpass 实例 ${service_name} 已同步安装"
                rm -f "${TASK_STATE_DIR}/${job_id}.ack" "${TASK_STATE_DIR}/${job_id}.started" "${TASK_STATE_DIR}/${job_id}.done"
            else
                log ERROR "Nyanpass 实例 ${service_name} 已安装，但主控回执失败"
            fi
            rm -f "$installer" "$archive" "$installer_log"
            rm -rf "$extract_dir"
            client_token="" args="" response=""
            return 0
        elif [[ $install_status -eq 124 || $install_status -eq 137 ]]; then
            error_code="install_timeout"
        else
            error_code="install_failed"
        fi
    fi

    local outcome="failed"
    [[ "$error_code" == "install_timeout" || "$error_code" == "install_failed" || "$error_code" == "local_state" ]] && outcome="uncertain"
    write_pending_ack "$job_id" "$lease_token" "$outcome" "$error_code"
    if ack_nyanpass_job "$job_id" "$lease_token" "$outcome" "$error_code"; then
        rm -f "${TASK_STATE_DIR}/${job_id}.ack" "${TASK_STATE_DIR}/${job_id}.started"
    fi
    log ERROR "Nyanpass 实例 ${service_name} 同步失败（${error_code}）"
    rm -f "$installer" "$archive" "$installer_log"
    rm -rf "$extract_dir"
    client_token="" args="" response=""
}

run_nyanpass_task_loop() {
    local worker_status=0
    while true; do
        # Capture the worker exit code without calling the worker from an if/||
        # test. Bash suppresses errexit inside functions used as conditions,
        # which would let a failed atomic state write continue toward an ACK.
        set +e
        (
            set -e
            flock -n 9 || exit 0
            poll_nyanpass_job
        ) 9>"$TASK_LOCK_FILE"
        worker_status=$?
        set -e
        if [[ $worker_status -ne 0 ]]; then
            log ERROR "Nyanpass 任务轮询异常，将在下个周期重试"
        fi
        sleep "$CHECK_INTERVAL"
    done
}

run_loop() {
    load_config
    install_deps
    log INFO "DDNS 监控启动，间隔 ${CHECK_INTERVAL}s，主控：$SERVER_URL，远程同步协议 v1"
    # Keep the task heartbeat independent from public-IP providers. A slow or
    # unreachable IPv4/IPv6 source must not make an otherwise healthy probe look
    # offline to the remote-sync queue.
    run_nyanpass_task_loop &
    local last_v4="" last_v6="" cur_v4="" cur_v6="" candidate_v4="" candidate_v6=""
    local now_epoch=0 last_reconcile_v4=0 last_reconcile_v6=0 retry_v4_at=0 retry_v6_at=0
    local retry_v4_delay="$CHECK_INTERVAL" retry_v6_delay="$CHECK_INTERVAL"
    while true; do
        now_epoch=$(date +%s)
        cur_v4=$(get_ipv4)
        [[ -f "$CACHE_V4" ]] && last_v4=$(<"$CACHE_V4") || last_v4=""
        if [[ "$cur_v4" != "$candidate_v4" ]]; then
            candidate_v4="$cur_v4"
            retry_v4_at=0
            retry_v4_delay="$CHECK_INTERVAL"
            [[ -z "$cur_v4" || "$cur_v4" == "$last_v4" ]] || log INFO "[A] IP 变化：${last_v4:-首次} -> $cur_v4"
        fi
        if [[ -n "$cur_v4" && $now_epoch -ge $retry_v4_at ]] \
            && { [[ "$cur_v4" != "$last_v4" ]] || ((last_reconcile_v4 == 0 || now_epoch - last_reconcile_v4 >= DNS_RECONCILE_INTERVAL)); }; then
            [[ "$cur_v4" != "$last_v4" ]] || log INFO "[A] 开始周期性 DNS 校准 -> $cur_v4"
            if notify_server "$cur_v4" "A"; then
                echo "$cur_v4" > "$CACHE_V4"
                last_reconcile_v4=$now_epoch
                retry_v4_at=0
                retry_v4_delay="$CHECK_INTERVAL"
            else
                retry_v4_at=$((now_epoch + retry_v4_delay))
                retry_v4_delay=$((retry_v4_delay * 2))
                ((retry_v4_delay <= REPORT_RETRY_MAX)) || retry_v4_delay=$REPORT_RETRY_MAX
            fi
        fi
        cur_v6=$(get_ipv6)
        [[ -f "$CACHE_V6" ]] && last_v6=$(<"$CACHE_V6") || last_v6=""
        if [[ "$cur_v6" != "$candidate_v6" ]]; then
            candidate_v6="$cur_v6"
            retry_v6_at=0
            retry_v6_delay="$CHECK_INTERVAL"
            [[ -z "$cur_v6" || "$cur_v6" == "$last_v6" ]] || log INFO "[AAAA] IP 变化：${last_v6:-首次} -> $cur_v6"
        fi
        if [[ -n "$cur_v6" && $now_epoch -ge $retry_v6_at ]] \
            && { [[ "$cur_v6" != "$last_v6" ]] || ((last_reconcile_v6 == 0 || now_epoch - last_reconcile_v6 >= DNS_RECONCILE_INTERVAL)); }; then
            [[ "$cur_v6" != "$last_v6" ]] || log INFO "[AAAA] 开始周期性 DNS 校准 -> $cur_v6"
            if notify_server "$cur_v6" "AAAA"; then
                echo "$cur_v6" > "$CACHE_V6"
                last_reconcile_v6=$now_epoch
                retry_v6_at=0
                retry_v6_delay="$CHECK_INTERVAL"
            else
                retry_v6_at=$((now_epoch + retry_v6_delay))
                retry_v6_delay=$((retry_v6_delay * 2))
                ((retry_v6_delay <= REPORT_RETRY_MAX)) || retry_v6_delay=$REPORT_RETRY_MAX
            fi
        fi
        sleep "$CHECK_INTERVAL"
    done
}

case "${1:---run}" in
    --run) run_loop ;;
    *) fail "未知参数" ;;
esac
