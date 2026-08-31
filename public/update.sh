#!/usr/bin/env bash
# PulseDNS DDNS probe updater
# 安装新版探针所需依赖后，原子替换 /opt/ddns-monitor/monitor.sh。
set -euo pipefail

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

CONFIG_FILE="/etc/ddns-monitor.conf"
INSTALL_DIR="/opt/ddns-monitor"
INSTALL_PATH="${INSTALL_DIR}/monitor.sh"
BACKUP_PATH="${INSTALL_DIR}/monitor.sh.previous"
SERVICE_FILE="/etc/systemd/system/ddns-monitor.service"
SERVICE_NAME="ddns-monitor"
MONITOR_DOWNLOAD_URL="https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/monitor.sh"
MONITOR_SHA256="f9f8992171e8ea37c7e99563710f698f1a94545c3598969a089fd1c86ae1f3e4"
LOCK_DIR="/run/pulsedns-ddns-upgrade.lock"
SERVER_URL=""
TOKEN=""
candidate=""
backup_tmp=""
rollback_tmp=""
lock_acquired=0
swapped=0
was_active=0

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

install_runtime_deps() {
    local -a missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")
    command -v timeout >/dev/null 2>&1 || missing+=("coreutils")
    command -v flock >/dev/null 2>&1 || missing+=("util-linux")
    [[ ${#missing[@]} -eq 0 ]] && return 0
    info "安装新版探针依赖：${missing[*]}"
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
        fail "未找到支持的包管理器，请先安装：${missing[*]}"
    fi
    command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && command -v flock >/dev/null 2>&1 || fail "新版探针依赖安装失败"
}

cleanup() {
    [[ -z "$candidate" ]] || rm -f -- "$candidate"
    [[ -z "$backup_tmp" ]] || rm -f -- "$backup_tmp"
    [[ -z "$rollback_tmp" ]] || rm -f -- "$rollback_tmp"
    if [[ $lock_acquired -eq 1 && "$LOCK_DIR" == "/run/pulsedns-ddns-upgrade.lock" ]]; then
        rm -f -- "$LOCK_DIR/pid"
        rmdir -- "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

validate_root_file() {
    local path="$1" uid="" mode="" links=""
    [[ -f "$path" && ! -L "$path" ]] || fail "文件不存在或不是普通文件：$path"
    uid=$(stat -c '%u' "$path" 2>/dev/null || true)
    mode=$(stat -c '%a' "$path" 2>/dev/null || true)
    links=$(stat -c '%h' "$path" 2>/dev/null || true)
    [[ "$uid" == "0" && "$mode" =~ ^[0-7]{3,4}$ && "$links" == "1" ]] || fail "文件所有权、权限或链接数无效：$path"
    if (( (8#$mode & 0022) != 0 )); then
        fail "文件不能由组或其他用户写入：$path"
    fi
}

validate_install_dir() {
    local uid="" gid="" mode="" resolved=""
    [[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]] || fail "DDNS 安装目录不存在或不是普通目录"
    resolved=$(realpath "$INSTALL_DIR" 2>/dev/null || true)
    uid=$(stat -c '%u' "$INSTALL_DIR" 2>/dev/null || true)
    gid=$(stat -c '%g' "$INSTALL_DIR" 2>/dev/null || true)
    mode=$(stat -c '%a' "$INSTALL_DIR" 2>/dev/null || true)
    [[ "$resolved" == "$INSTALL_DIR" && "$uid" == "0" && "$gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || fail "DDNS 安装目录所有权或权限无效"
    if (( (8#$mode & 0022) != 0 )); then
        fail "DDNS 安装目录不能由组或其他用户写入"
    fi
}

load_config() {
    local line="" seen_server=0 seen_token=0 port="" authority="" uid="" gid="" mode="" links=""
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || fail "未找到 PulseDNS 配置，请先使用当前项目安装 DDNS"
    uid=$(stat -c '%u' "$CONFIG_FILE" 2>/dev/null || true)
    gid=$(stat -c '%g' "$CONFIG_FILE" 2>/dev/null || true)
    mode=$(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || true)
    links=$(stat -c '%h' "$CONFIG_FILE" 2>/dev/null || true)
    [[ "$uid" == "0" && "$gid" == "0" && "$mode" == "600" && "$links" == "1" ]] || fail "DDNS 配置必须是 root:root、0600 且不能是链接"

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
            *) fail "DDNS 配置只能包含 SERVER_URL 和 TOKEN" ;;
        esac
    done < "$CONFIG_FILE"

    [[ $seen_server -eq 1 && $seen_token -eq 1 ]] || fail "DDNS 配置缺少 SERVER_URL 或 TOKEN"
    [[ "$SERVER_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]{1,64})?/?$ ]] || fail "主控地址必须是有效的 HTTP/HTTPS 地址"
    if [[ "$SERVER_URL" == http://* && ! "$SERVER_URL" =~ ^http://[A-Za-z0-9.-]+:[0-9]{1,5}/[a-f0-9]{32}/?$ ]]; then
        fail "HTTP 主控地址必须包含端口和 32 位随机访问路径"
    fi
    authority="${SERVER_URL#*://}"
    authority="${authority%%/*}"
    if [[ "$authority" == *:* ]]; then
        port="${authority##*:}"
        [[ $((10#$port)) -ge 1 && $((10#$port)) -le 65535 ]] || fail "主控地址端口无效"
    fi
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ && ${#TOKEN} -ge 8 && ${#TOKEN} -le 512 ]] || fail "节点令牌格式无效"
    SERVER_URL="${SERVER_URL%/}"
    export -n SERVER_URL TOKEN 2>/dev/null || true
}

restore_previous() {
    warn "新版探针未能稳定运行，正在恢复上一版本..."
    if ! rollback_tmp=$(mktemp "${INSTALL_DIR}/.monitor.rollback.XXXXXX"); then
        warn "无法创建恢复临时文件；上一版本仍在 $BACKUP_PATH"
        return 1
    fi
    if ! cp -p "$BACKUP_PATH" "$rollback_tmp" || ! chmod 0755 "$rollback_tmp" || ! mv -f "$rollback_tmp" "$INSTALL_PATH"; then
        warn "无法恢复上一版本；请从 $BACKUP_PATH 人工恢复"
        return 1
    fi
    rollback_tmp=""
    if [[ $was_active -eq 1 ]]; then
        if ! systemctl restart "$SERVICE_NAME"; then
            warn "上一版本已恢复，但服务重启失败；请人工检查 $SERVICE_NAME"
            return 1
        fi
        sleep 2
        if ! systemctl is-active --quiet "$SERVICE_NAME"; then
            warn "上一版本已恢复，但服务未保持运行；请人工检查 $SERVICE_NAME"
            return 1
        fi
    fi
    swapped=0
    return 0
}

fail_and_restore() {
    if restore_previous; then
        fail "升级失败，已恢复上一版本"
    fi
    fail "升级失败且自动恢复未完成；上一版本保留在 $BACKUP_PATH"
}

handle_signal() {
    local status="$1"
    trap - INT TERM
    if [[ $swapped -eq 1 ]]; then
        if restore_previous; then
            warn "升级被中断，已恢复上一版本"
        else
            warn "升级被中断且自动恢复未完成；上一版本保留在 $BACKUP_PATH"
        fi
    fi
    exit "$status"
}

trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

[[ $# -eq 0 ]] || fail "升级脚本不接受参数；主控地址和节点令牌始终读取现有配置"
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "请用 sudo/root 运行"
command -v systemctl >/dev/null 2>&1 || fail "当前系统不支持 systemd"
install_runtime_deps
validate_install_dir
validate_root_file "$INSTALL_PATH"
validate_root_file "$SERVICE_FILE"
grep -Fxq "ExecStart=/bin/bash ${INSTALL_PATH} --run" "$SERVICE_FILE" || fail "ddns-monitor.service 未引用当前 PulseDNS 探针，拒绝替换"
load_config

if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    lock_pid=""
    [[ -r "$LOCK_DIR/pid" ]] && IFS= read -r lock_pid < "$LOCK_DIR/pid" || true
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f -- "$LOCK_DIR/pid"
        rmdir -- "$LOCK_DIR" 2>/dev/null || true
    fi
    mkdir -- "$LOCK_DIR" 2>/dev/null || fail "另一个升级正在运行；锁目录：$LOCK_DIR"
fi
lock_acquired=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"

candidate=$(mktemp "${INSTALL_DIR}/.monitor.candidate.XXXXXX")
info "正在从 GitHub HTTPS 发布通道下载并校验 DDNS 探针..."
curl --proto '=https' --proto-redir '=https' -fLSs --retry 2 --max-time 30 \
    "$MONITOR_DOWNLOAD_URL" -o "$candidate" || fail "DDNS 探针下载失败"
[[ -s "$candidate" ]] || fail "下载的 DDNS 探针为空"
grep -Fq '# PulseDNS DDNS monitor payload' "$candidate" || fail "下载内容不是 PulseDNS DDNS 探针"
bash -n "$candidate" || fail "下载的 DDNS 探针语法校验失败"
[[ "$(sha256sum "$candidate" | awk '{print $1}')" == "$MONITOR_SHA256" ]] || fail "下载的 DDNS 探针完整性校验失败"
chmod 0755 "$candidate"

new_version=$(sed -n 's/^VERSION="\([^"]*\)"$/\1/p' "$candidate" | head -1)
old_version=$(sed -n 's/^VERSION="\([^"]*\)"$/\1/p' "$INSTALL_PATH" | head -1)
[[ -n "$new_version" ]] || fail "下载的 DDNS 探针缺少版本号"
[[ -n "$old_version" ]] || old_version="unknown"

if command -v cmp >/dev/null 2>&1 && cmp -s "$INSTALL_PATH" "$candidate"; then
    info "DDNS 探针已是当前版本 v${new_version}"
    exit 0
fi

systemctl is-active --quiet "$SERVICE_NAME" && was_active=1 || true

backup_tmp=$(mktemp "${INSTALL_DIR}/.monitor.previous.XXXXXX")
cp -p "$INSTALL_PATH" "$backup_tmp"
chmod 0755 "$backup_tmp"
mv -f "$backup_tmp" "$BACKUP_PATH"
backup_tmp=""
swapped=1
if ! mv -f "$candidate" "$INSTALL_PATH"; then
    swapped=0
    fail "无法原子替换 DDNS 探针；现有版本未变"
fi
candidate=""

if [[ $was_active -eq 1 ]]; then
    systemctl restart "$SERVICE_NAME" || fail_and_restore
    for _ in 1 2 3; do
        sleep 2
        systemctl is-active --quiet "$SERVICE_NAME" || fail_and_restore
    done
fi
swapped=0

info "DDNS 探针升级完成：v${old_version} -> v${new_version}"
info "现有配置、IP 缓存和日志均未被清空；上一版本保留在 $BACKUP_PATH"
