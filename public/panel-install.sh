#!/usr/bin/env bash
# PulseDNS Web 主控一键安装与管理脚本
set -euo pipefail

VERSION="0.7.0"
REPOSITORY="rosalgee4-lgtm/pulsedns-control"
INSTALL_ROOT="/opt/pulsedns-control"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CURRENT_LINK="${INSTALL_ROOT}/current"
RUNTIME_DIR="${INSTALL_ROOT}/runtime"
DATA_DIR="/var/lib/pulsedns-control"
ENV_FILE="/etc/pulsedns-control.env"
PANEL_SERVICE="pulsedns-control"
LEGACY_CADDY_SERVICE="pulsedns-caddy"
PANEL_PORT="${PANEL_PORT:-3100}"
PANEL_PUBLIC_IP="${PANEL_PUBLIC_IP:-}"
PANEL_BASE_PATH=""
PANEL_PUBLIC_URL=""
PNPM_VERSION="10.28.2"

blue='\033[1;34m'; green='\033[1;32m'; yellow='\033[1;33m'; red='\033[1;31m'; reset='\033[0m'
info() { printf "%b[INFO]%b %s\n" "$blue" "$reset" "$*"; }
ok() { printf "%b[ OK ]%b %s\n" "$green" "$reset" "$*"; }
warn() { printf "%b[WARN]%b %s\n" "$yellow" "$reset" "$*"; }
fail() { printf "%b[FAIL]%b %s\n" "$red" "$reset" "$*" >&2; exit 1; }

need_root() {
    [[ $(id -u) -eq 0 ]] || fail "请使用 root 或 sudo 运行"
    [[ "$(uname -s)" == "Linux" ]] || fail "面板安装器仅支持 Linux"
    command -v systemctl >/dev/null 2>&1 || fail "系统必须使用 systemd"
}

install_dependencies() {
    local packages=(curl tar xz-utils ca-certificates)
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q curl tar xz ca-certificates
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q curl tar xz ca-certificates
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl tar xz ca-certificates shadow
    else
        fail "不支持当前包管理器，请先安装 curl、tar、xz 和 ca-certificates"
    fi
    command -v sha256sum >/dev/null 2>&1 || fail "缺少 sha256sum"
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64) NODE_ARCH="x64" ;;
        aarch64|arm64) NODE_ARCH="arm64" ;;
        *) fail "仅支持 x86_64 和 arm64" ;;
    esac
}

download_node() {
    local temp_dir="$1" sums filename expected archive extracted
    sums="${temp_dir}/SHASUMS256.txt"
    curl --proto '=https' --proto-redir '=https' -fLSs https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$sums"
    filename=$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v22\\..*-linux-" arch "\\.tar\\.xz$") { print $2; exit }' "$sums")
    [[ -n "$filename" ]] || fail "无法确定 Node.js 22 安装包"
    expected=$(awk -v file="$filename" '$2 == file { print $1 }' "$sums")
    archive="${temp_dir}/${filename}"
    curl --proto '=https' --proto-redir '=https' -fLSs "https://nodejs.org/dist/latest-v22.x/${filename}" -o "$archive"
    [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected" ]] || fail "Node.js 校验失败"

    mkdir -p "$RUNTIME_DIR"
    extracted="${RUNTIME_DIR}/${filename%.tar.xz}"
    if [[ ! -x "${extracted}/bin/node" ]]; then
        tar -xJf "$archive" -C "$RUNTIME_DIR"
    fi
    ln -sfn "$extracted" "${RUNTIME_DIR}/node"
    "${RUNTIME_DIR}/node/bin/corepack" prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null
    ok "Node.js $(${RUNTIME_DIR}/node/bin/node --version) 已就绪"
}

download_and_build_panel() {
    local temp_dir="$1" release_id release_dir source_archive
    release_id=$(date '+%Y%m%d%H%M%S')
    release_dir="${RELEASES_DIR}/${release_id}"
    source_archive="${temp_dir}/source.tar.gz"
    curl --proto '=https' --proto-redir '=https' -fLSs \
        "https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz" -o "$source_archive"
    mkdir -p "$release_dir"
    tar -xzf "$source_archive" --strip-components=1 -C "$release_dir"

    info "安装依赖并构建 Web 面板..."
    (
        cd "$release_dir"
        export PATH="${RUNTIME_DIR}/node/bin:${PATH}"
        export PULSEDNS_SELF_HOSTED=1
        export PULSEDNS_BASE_PATH="${PANEL_BASE_PATH}"
        export NEXT_PUBLIC_PULSEDNS_BASE_PATH="${PANEL_BASE_PATH}"
        corepack pnpm install --frozen-lockfile
        corepack pnpm build
    )
    ln -sfn "$release_dir" "$CURRENT_LINK"
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
    ok "PulseDNS 面板源码与生产构建已安装"
}

prompt_install_config() {
    local password_confirm="" requested_port=""
    read -r -p "HTTP 端口 [${PANEL_PORT}]: " requested_port
    PANEL_PORT="${requested_port:-$PANEL_PORT}"
    [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || fail "端口必须是数字"
    [[ $((10#$PANEL_PORT)) -ge 1024 && $((10#$PANEL_PORT)) -le 65535 ]] || fail "HTTP 端口必须是 1024-65535"
    read -r -p "面板管理员用户名 [admin]: " ADMIN_USER
    ADMIN_USER="${ADMIN_USER:-admin}"
    [[ "$ADMIN_USER" =~ ^[A-Za-z0-9_.-]{3,32}$ ]] || fail "管理员用户名只能包含字母、数字、点、下划线和短横线"
    read -r -s -p "面板管理员密码（12-128 位）: " ADMIN_PASSWORD; printf '\n'
    read -r -s -p "再次输入管理员密码: " password_confirm; printf '\n'
    [[ "$ADMIN_PASSWORD" == "$password_confirm" ]] || fail "两次密码不一致"
    [[ ${#ADMIN_PASSWORD} -ge 12 && ${#ADMIN_PASSWORD} -le 128 && "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9._~!@#%+=,-]+$ ]] || fail "密码需为 12-128 位安全 ASCII 字符，不能包含冒号或空格"
    read -r -p "阿里云 AccessKey ID: " ALIYUN_KEY_ID
    read -r -s -p "阿里云 AccessKey Secret: " ALIYUN_KEY_SECRET; printf '\n'
    [[ "$ALIYUN_KEY_ID" =~ ^[A-Za-z0-9._~+/=-]{8,128}$ ]] || fail "AccessKey ID 格式无效"
    [[ "$ALIYUN_KEY_SECRET" =~ ^[A-Za-z0-9._~+/=-]{8,256}$ ]] || fail "AccessKey Secret 格式无效"
}

valid_ipv4() {
    local ip="$1" octet=""
    local -a octets=()
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS='.' read -r -a octets <<< "$ip"
    for octet in "${octets[@]}"; do
        [[ $((10#$octet)) -le 255 ]] || return 1
    done
}

prepare_http_endpoint() {
    local endpoint="" candidate="" secret=""
    if [[ -z "$PANEL_PUBLIC_IP" ]]; then
        for endpoint in https://api.ipify.org https://ifconfig.me/ip https://4.ipw.cn; do
            candidate=$(curl -4 -fLSs --max-time 8 "$endpoint" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)
            if valid_ipv4 "$candidate"; then
                PANEL_PUBLIC_IP="$candidate"
                break
            fi
        done
    fi
    valid_ipv4 "$PANEL_PUBLIC_IP" || fail "无法自动识别公网 IPv4；可用 PANEL_PUBLIC_IP=你的IP 重新运行"
    [[ -r /proc/sys/kernel/random/uuid ]] || fail "系统无法生成随机访问路径"
    secret=$(tr -d '-' < /proc/sys/kernel/random/uuid)
    [[ "$secret" =~ ^[a-f0-9]{32}$ ]] || fail "随机访问路径生成失败"
    PANEL_BASE_PATH="/${secret}"
    PANEL_PUBLIC_URL="http://${PANEL_PUBLIC_IP}:${PANEL_PORT}${PANEL_BASE_PATH}"
}

load_existing_http_config() {
    PANEL_PUBLIC_URL=$(sed -n 's/^PULSEDNS_PUBLIC_URL=//p' "$ENV_FILE" | head -1)
    PANEL_BASE_PATH=$(sed -n 's/^PULSEDNS_BASE_PATH=//p' "$ENV_FILE" | head -1)
    PANEL_PORT=$(sed -n 's/^PULSEDNS_PANEL_PORT=//p' "$ENV_FILE" | head -1)
    [[ "$PANEL_BASE_PATH" =~ ^/[a-f0-9]{32}$ && "$PANEL_PORT" =~ ^[0-9]+$ ]] || fail "当前安装不是 HTTP 加密路径版本；请卸载后重新安装"
    [[ "$PANEL_PUBLIC_URL" == http://*"${PANEL_BASE_PATH}" ]] || fail "面板公开地址配置无效"
}

write_panel_config() {
    install -d -m 0750 /etc/pulsedns-control
    umask 077
    {
        printf 'PULSEDNS_SELF_HOSTED=1\n'
        printf 'PULSEDNS_DB_PATH=%s\n' "${DATA_DIR}/pulsedns.db"
        printf 'PULSEDNS_PUBLIC_URL=%s\n' "$PANEL_PUBLIC_URL"
        printf 'PULSEDNS_BASE_PATH=%s\n' "$PANEL_BASE_PATH"
        printf 'NEXT_PUBLIC_PULSEDNS_BASE_PATH=%s\n' "$PANEL_BASE_PATH"
        printf 'PULSEDNS_PANEL_PORT=%s\n' "$PANEL_PORT"
        printf 'PULSEDNS_ADMIN_USER=%s\n' "$ADMIN_USER"
        printf 'PULSEDNS_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
        printf 'ALIBABA_CLOUD_ACCESS_KEY_ID=%s\n' "$ALIYUN_KEY_ID"
        printf 'ALIBABA_CLOUD_ACCESS_KEY_SECRET=%s\n' "$ALIYUN_KEY_SECRET"
    } > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    ADMIN_PASSWORD=""; ALIYUN_KEY_SECRET=""
}

write_services() {
    id pulsedns >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin pulsedns
    install -d -o pulsedns -g pulsedns -m 0750 "$DATA_DIR"

    cat > "/etc/systemd/system/${PANEL_SERVICE}.service" <<SERVICE_EOF
[Unit]
Description=PulseDNS Web Control Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pulsedns
Group=pulsedns
WorkingDirectory=${CURRENT_LINK}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${RUNTIME_DIR}/node/bin/node ${CURRENT_LINK}/node_modules/vinext/dist/cli.js start --hostname 0.0.0.0 --port ${PANEL_PORT}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    systemctl daemon-reload
    systemctl enable --now "$PANEL_SERVICE"
}

install_panel() {
    need_root
    [[ ! -e "$ENV_FILE" ]] || fail "面板已安装；请使用 update 升级，或先卸载"
    prompt_install_config
    install_dependencies
    prepare_http_endpoint
    detect_arch
    local temp_dir
    temp_dir=$(mktemp -d /tmp/pulsedns-panel.XXXXXX)
    trap 'rm -rf "$temp_dir"' EXIT
    mkdir -p "$INSTALL_ROOT" "$RELEASES_DIR"
    download_node "$temp_dir"
    download_and_build_panel "$temp_dir"
    write_panel_config
    write_services
    systemctl is-active --quiet "$PANEL_SERVICE" || fail "面板服务启动失败，请运行 journalctl -u ${PANEL_SERVICE}"
    ok "安装完成：${PANEL_PUBLIC_URL}"
    warn "请只向你自己的来源 IP 放行 TCP ${PANEL_PORT}；HTTP 登录信息不会加密"
}

update_panel() {
    need_root
    [[ -f "$ENV_FILE" && -L "$CURRENT_LINK" ]] || fail "未检测到已安装面板"
    local previous_release
    previous_release=$(readlink -f "$CURRENT_LINK")
    load_existing_http_config
    install_dependencies
    detect_arch
    local temp_dir
    temp_dir=$(mktemp -d /tmp/pulsedns-panel-update.XXXXXX)
    trap 'rm -rf "$temp_dir"' EXIT
    download_node "$temp_dir"
    download_and_build_panel "$temp_dir"
    systemctl restart "$PANEL_SERVICE"
    if ! systemctl is-active --quiet "$PANEL_SERVICE"; then
        warn "新版启动失败，正在恢复上一版本"
        ln -sfn "$previous_release" "$CURRENT_LINK"
        systemctl restart "$PANEL_SERVICE" || true
        fail "升级失败，已恢复上一版本；请检查日志"
    fi
    ok "面板升级完成，数据库和配置未改变"
}

show_status() {
    need_root
    systemctl --no-pager --full status "$PANEL_SERVICE" || true
}

uninstall_panel() {
    need_root
    local answer=""
    read -r -p "确认卸载面板程序？数据库会保留在 ${DATA_DIR} [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]] || return 0
    systemctl disable --now "$LEGACY_CADDY_SERVICE" "$PANEL_SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/${LEGACY_CADDY_SERVICE}.service" "/etc/systemd/system/${PANEL_SERVICE}.service"
    rm -f "$ENV_FILE"
    rm -rf "$INSTALL_ROOT" /etc/pulsedns-control
    systemctl daemon-reload
    ok "面板程序已卸载；数据库仍保留在 ${DATA_DIR}"
}

menu() {
    local choice=""
    while true; do
        printf '\n%bPulseDNS 面板管理器 v%s%b\n' "$blue" "$VERSION" "$reset"
        printf '  1) 一键安装 Web 主控面板\n'
        printf '  2) 升级面板\n'
        printf '  3) 查看运行状态\n'
        printf '  4) 卸载面板（保留数据库）\n'
        printf '  0) 退出\n\n'
        read -r -p "请选择 [0-4]: " choice
        case "$choice" in
            1) install_panel ;;
            2) update_panel ;;
            3) show_status ;;
            4) uninstall_panel ;;
            0) return 0 ;;
            *) warn "无效选项" ;;
        esac
    done
}

case "${1:-menu}" in
    menu) menu ;;
    install) install_panel ;;
    update|upgrade) update_panel ;;
    status) show_status ;;
    uninstall) uninstall_panel ;;
    *) fail "未知操作：${1:-}" ;;
esac
