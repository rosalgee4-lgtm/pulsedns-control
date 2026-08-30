#!/usr/bin/env bash
# PulseDNS Web 主控一键安装与管理脚本
set -euo pipefail

VERSION="0.8.2"
REPOSITORY="rosalgee4-lgtm/pulsedns-control"
SOURCE_COMMIT="eb9c6eeb9780a99674e45ea0b978aef0ca269691"
SOURCE_LOCK_SHA256="5eb19c49c5aa8a469f9992be3d361e6913af2afdc49df3f30d271865f16a49f1"
SOURCE_OG_SHA256="3e0d82b4901fe73d4bc6a6209275283d39a0cf4084fea6625fba18d0e627de55"
INSTALL_ROOT="/opt/pulsedns-control"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CURRENT_LINK="${INSTALL_ROOT}/current"
RUNTIME_DIR="${INSTALL_ROOT}/runtime"
DATA_DIR="/var/lib/pulsedns-control"
TASK_KEY_FILE="${DATA_DIR}/task-encryption.key"
ENV_FILE="/etc/pulsedns-control.env"
PANEL_SERVICE="pulsedns-control"
LEGACY_CADDY_SERVICE="pulsedns-caddy"
PANEL_PORT="${PANEL_PORT:-3100}"
PANEL_PUBLIC_IP="${PANEL_PUBLIC_IP:-}"
PANEL_BASE_PATH=""
PANEL_PUBLIC_URL=""
PNPM_VERSION="10.28.2"
TEMP_DIR=""
NEW_RELEASE_DIR=""
PREVIOUS_RELEASE=""
TRANSACTION_MODE=""
TRANSACTION_ACTIVE=0
TASK_ENCRYPTION_KEY=""
TASK_KEY_TMP=""
ENV_TMP=""

blue='\033[1;34m'; green='\033[1;32m'; yellow='\033[1;33m'; red='\033[1;31m'; reset='\033[0m'
info() { printf "%b[INFO]%b %s\n" "$blue" "$reset" "$*"; }
ok() { printf "%b[ OK ]%b %s\n" "$green" "$reset" "$*"; }
warn() { printf "%b[WARN]%b %s\n" "$yellow" "$reset" "$*"; }
fail() { printf "%b[FAIL]%b %s\n" "$red" "$reset" "$*" >&2; exit 1; }

cleanup_temp_dir() {
    local candidate="${TEMP_DIR:-}"
    [[ -n "$candidate" ]] || return 0
    case "$candidate" in
        /tmp/pulsedns-panel.*|/tmp/pulsedns-panel-update.*) rm -rf -- "$candidate" ;;
        *) warn "跳过清理异常临时目录：${candidate}" ;;
    esac
    TEMP_DIR=""
}

cleanup_on_exit() {
    local status=$?
    set +e
    case "${TASK_KEY_TMP:-}" in "${DATA_DIR}/.task-encryption-key."*) rm -f -- "$TASK_KEY_TMP" ;; esac
    case "${ENV_TMP:-}" in /etc/.pulsedns-control.env.*) rm -f -- "$ENV_TMP" ;; esac
    TASK_KEY_TMP=""
    ENV_TMP=""
    cleanup_temp_dir
    if [[ "$TRANSACTION_ACTIVE" -eq 1 ]]; then
        if [[ "$TRANSACTION_MODE" == "install" ]]; then
            systemctl disable --now "$PANEL_SERVICE" >/dev/null 2>&1 || true
            rm -f "/etc/systemd/system/${PANEL_SERVICE}.service" "$ENV_FILE"
            if [[ -L "$CURRENT_LINK" ]]; then rm -f "$CURRENT_LINK"; fi
        elif [[ "$TRANSACTION_MODE" == "update" && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
            activate_release "$PREVIOUS_RELEASE" >/dev/null 2>&1 || true
            systemctl restart "$PANEL_SERVICE" >/dev/null 2>&1 || true
            warn "升级未完成，已恢复上一版本"
        fi
        if [[ -n "$NEW_RELEASE_DIR" && "$NEW_RELEASE_DIR" == "${RELEASES_DIR}/"* ]]; then
            rm -rf -- "$NEW_RELEASE_DIR"
        fi
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    return "$status"
}

need_root() {
    [[ $(id -u) -eq 0 ]] || fail "请使用 root 或 sudo 运行"
    [[ "$(uname -s)" == "Linux" ]] || fail "面板安装器仅支持 Linux"
    command -v systemctl >/dev/null 2>&1 || fail "系统必须使用 systemd"
    [[ -d /run/systemd/system ]] || fail "未检测到正在运行的 systemd；不支持 Docker、WSL 或 chroot 容器内安装"
    systemctl show-environment >/dev/null 2>&1 || fail "无法连接 systemd 服务管理器"
    command -v getconf >/dev/null 2>&1 || fail "缺少 getconf，无法检测 glibc"
    local libc_name="" libc_version="" libc_major=0 libc_minor=0
    read -r libc_name libc_version < <(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    [[ "$libc_name" == "glibc" && "$libc_version" =~ ^([0-9]+)\.([0-9]+) ]] || \
        fail "仅支持 glibc Linux；不支持 Alpine/musl"
    libc_major="${BASH_REMATCH[1]}"; libc_minor="${BASH_REMATCH[2]}"
    (( libc_major > 2 || (libc_major == 2 && libc_minor >= 28) )) || \
        fail "glibc ${libc_version} 过旧；Node.js 22 要求 glibc 2.28 或更高版本"
}

install_dependencies() {
    local packages=(curl tar xz-utils ca-certificates util-linux passwd)
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q curl tar xz ca-certificates util-linux shadow-utils
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q curl tar xz ca-certificates util-linux shadow-utils
    else
        fail "仅支持使用 apt、dnf 或 yum 的 glibc Linux"
    fi
    command -v sha256sum >/dev/null 2>&1 || fail "缺少 sha256sum"
    command -v flock >/dev/null 2>&1 || fail "缺少 flock（util-linux）"
    command -v useradd >/dev/null 2>&1 && command -v groupadd >/dev/null 2>&1 && \
        command -v getent >/dev/null 2>&1 || fail "缺少系统用户管理工具"
}

acquire_lock() {
    exec 9>"/run/lock/pulsedns-panel-installer.lock"
    flock -n 9 || fail "另一个 PulseDNS 安装或升级任务正在运行"
}

check_build_resources() {
    local disk_kb memory_kb
    disk_kb=$(df -Pk /opt | awk 'NR==2 {print $4}')
    [[ "$disk_kb" =~ ^[0-9]+$ && "$disk_kb" -ge 2097152 ]] || \
        fail "/opt 所在磁盘至少需要 2 GiB 可用空间"
    memory_kb=$(awk '/^MemAvailable:/ {m=$2} /^SwapFree:/ {s=$2} END {print m+s}' /proc/meminfo)
    [[ "$memory_kb" =~ ^[0-9]+$ && "$memory_kb" -ge 786432 ]] || \
        fail "构建至少需要 768 MiB 可用内存与交换空间；请先增加 swap"
    if [[ "$memory_kb" -lt 1572864 ]]; then
        warn "可用内存低于 1.5 GiB，构建速度可能较慢"
    fi
}

port_is_listening() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -H -ltn 2>/dev/null | awk -v suffix=":${port}" \
            '$4 ~ (suffix "$") { found=1 } END { exit !found }'
    else
        (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
    fi
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

    install -d -m 0755 "$RUNTIME_DIR"
    extracted="${RUNTIME_DIR}/${filename%.tar.xz}"
    if [[ ! -x "${extracted}/bin/node" ]]; then
        tar -xJf "$archive" -C "$RUNTIME_DIR"
    fi
    chmod -R a+rX "$extracted"
    chmod 0755 "$RUNTIME_DIR" "$extracted"
    ln -sfn "$extracted" "${RUNTIME_DIR}/node"
    "${RUNTIME_DIR}/node/bin/node" --version >/dev/null 2>&1 || \
        fail "Node.js 无法运行；请确认系统为 glibc 2.28+ 的 x86_64 或 arm64 Linux"
    PATH="${RUNTIME_DIR}/node/bin:${PATH}" \
        "${RUNTIME_DIR}/node/bin/node" "${RUNTIME_DIR}/node/bin/corepack" \
        prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null
    ok "Node.js $(${RUNTIME_DIR}/node/bin/node --version) 已就绪"
}

download_and_build_panel() {
    local temp_dir="$1" release_id release_dir source_archive corrupt_file
    [[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "面板源码提交锁格式无效"
    release_id=$(date '+%Y%m%d%H%M%S')
    release_dir="${RELEASES_DIR}/${release_id}"
    [[ ! -e "$release_dir" ]] || release_dir="${RELEASES_DIR}/${release_id}-$$"
    NEW_RELEASE_DIR="$release_dir"
    source_archive="${temp_dir}/source.tar.gz"
    curl --proto '=https' --proto-redir '=https' -fLSs \
        "https://github.com/${REPOSITORY}/archive/${SOURCE_COMMIT}.tar.gz" -o "$source_archive"
    install -d -m 0755 "$release_dir"
    tar -xzf "$source_archive" --strip-components=1 -C "$release_dir"

    [[ -s "${release_dir}/package.json" && -s "${release_dir}/pnpm-lock.yaml" && \
        -s "${release_dir}/public/og.png" && -s "${release_dir}/lib/startup-launcher.ts" && \
        -s "${release_dir}/app/api/admin/nodes/route.ts" ]] || \
        fail "下载的源码不完整：缺少必要文件"
    grep -Fq 'startupScript' "${release_dir}/app/api/admin/nodes/route.ts" || \
        fail "下载的源码不完整：缺少开机脚本返回逻辑"
    if grep -Fq 'next/font/google' "${release_dir}/app/layout.tsx"; then
        fail "下载的源码仍依赖在线 Google 字体，拒绝在自托管环境构建"
    fi
    corrupt_file=$(LC_ALL=C grep -Il -m1 -E \
        'Warning: truncated output|original token count|[0-9]+ tokens truncated' \
        "${release_dir}/pnpm-lock.yaml" "${release_dir}/public/og.png" \
        2>/dev/null | head -1 || true)
    [[ -z "$corrupt_file" ]] || fail "下载的源码已损坏：${corrupt_file#${release_dir}/}，请稍后重试"
    grep -Eq "^lockfileVersion:[[:space:]]*['\"]?9" "${release_dir}/pnpm-lock.yaml" || \
        fail "pnpm-lock.yaml 格式无效"
    [[ "$(sha256sum "${release_dir}/pnpm-lock.yaml" | awk '{print $1}')" == "$SOURCE_LOCK_SHA256" ]] || \
        fail "pnpm-lock.yaml 完整性校验失败"
    [[ "$(sha256sum "${release_dir}/public/og.png" | awk '{print $1}')" == "$SOURCE_OG_SHA256" ]] || \
        fail "静态资源完整性校验失败"
    "${RUNTIME_DIR}/node/bin/node" -e \
        'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
        "${release_dir}/package.json" || fail "package.json 格式无效"

    info "安装依赖并构建 Web 面板..."
    (
        cd "$release_dir"
        export PATH="${RUNTIME_DIR}/node/bin:${PATH}"
        export PULSEDNS_SELF_HOSTED=1
        export PULSEDNS_BASE_PATH="${PANEL_BASE_PATH}"
        export NEXT_PUBLIC_PULSEDNS_BASE_PATH="${PANEL_BASE_PATH}"
        "${RUNTIME_DIR}/node/bin/node" "${RUNTIME_DIR}/node/bin/corepack" pnpm install --frozen-lockfile
        "${RUNTIME_DIR}/node/bin/node" "${RUNTIME_DIR}/node/bin/corepack" pnpm build
    )
    chmod -R a+rX "$release_dir"
    chmod 0755 "$INSTALL_ROOT" "$RELEASES_DIR" "$release_dir"
    ok "PulseDNS 面板源码与生产构建已安装"
}

activate_release() {
    local release_dir="$1" next_link="${CURRENT_LINK}.next.$$"
    [[ -d "$release_dir" ]] || return 1
    [[ ! -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] || fail "${CURRENT_LINK} 不是符号链接，拒绝覆盖"
    rm -f "$next_link"
    ln -s "$release_dir" "$next_link"
    mv -Tf "$next_link" "$CURRENT_LINK"
}

wait_for_panel() {
    local attempt unauth_code auth_code asset_code asset assets_ok
    local healthy=0 health_user health_password
    local html_file="${TEMP_DIR}/health.html"
    local asset_file="${TEMP_DIR}/health.asset"
    local panel_url="http://127.0.0.1:${PANEL_PORT}${PANEL_BASE_PATH}"
    local -a assets=()

    health_user=$(sed -n 's/^PULSEDNS_ADMIN_USER=//p' "$ENV_FILE" | head -1)
    health_password=$(sed -n 's/^PULSEDNS_ADMIN_PASSWORD=//p' "$ENV_FILE" | head -1)
    [[ "$health_user" =~ ^[A-Za-z0-9_.-]{3,32}$ ]] || return 1
    [[ ${#health_password} -ge 12 && ${#health_password} -le 128 && \
        "$health_password" =~ ^[A-Za-z0-9._~!@#%+=,-]+$ ]] || return 1
    for attempt in {1..30}; do
        if systemctl is-active --quiet "$PANEL_SERVICE"; then
            unauth_code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 2 \
                "$panel_url" 2>/dev/null || true)
            auth_code=""
            if [[ "$unauth_code" == "401" ]]; then
                auth_code=$(printf 'user = "%s:%s"\n' "$health_user" "$health_password" | \
                    curl --config - --noproxy '*' -sS -o "$html_file" -w '%{http_code}' \
                        --max-time 4 "$panel_url" 2>/dev/null || true)
            fi
            if [[ "$auth_code" == "200" ]] && \
                grep -Fq "\\\"basePath\\\":\\\"${PANEL_BASE_PATH}\\\"" "$html_file"; then
                mapfile -t assets < <(LC_ALL=C grep -aoE \
                    "${PANEL_BASE_PATH}/_next/static/[A-Za-z0-9._~/-]+" "$html_file" | sort -u)
                assets_ok=1
                (( ${#assets[@]} >= 3 )) || assets_ok=0
                for asset in "${assets[@]}"; do
                    asset_code=$(curl --noproxy '*' -sS -o "$asset_file" -w '%{http_code}' \
                        --max-time 4 "http://127.0.0.1:${PANEL_PORT}${asset}" 2>/dev/null || true)
                    if [[ "$asset_code" != "200" ]]; then
                        assets_ok=0
                        break
                    fi
                done
                if [[ "$assets_ok" -eq 1 ]]; then
                    ((healthy += 1))
                    if (( healthy >= 3 )); then
                        rm -f "$html_file" "$asset_file"
                        health_password=""
                        return 0
                    fi
                else
                    healthy=0
                fi
            else
                healthy=0
            fi
        else
            healthy=0
        fi
        sleep 1
    done
    rm -f "$html_file" "$asset_file"
    health_password=""
    return 1
}

cleanup_old_releases() {
    local current item index=0
    local -a releases=()
    current=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
    mapfile -t releases < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d \
        -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
    for item in "${releases[@]}"; do
        ((index += 1))
        if (( index > 3 )) && [[ "$item" != "$current" && "$item" != "$PREVIOUS_RELEASE" ]]; then
            rm -rf -- "$item"
        fi
    done
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

generate_task_encryption_key() {
    TASK_ENCRYPTION_KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    [[ "$TASK_ENCRYPTION_KEY" =~ ^[a-f0-9]{64}$ ]] || fail "远程任务加密密钥生成失败"
}

persist_task_encryption_key() {
    local previous_umask=""
    [[ "$TASK_ENCRYPTION_KEY" =~ ^[a-f0-9]{64}$ ]] || fail "远程任务加密密钥格式无效"
    install -d -m 0750 "$DATA_DIR"
    previous_umask=$(umask)
    umask 077
    TASK_KEY_TMP=$(mktemp "${DATA_DIR}/.task-encryption-key.XXXXXX")
    printf '%s\n' "$TASK_ENCRYPTION_KEY" > "$TASK_KEY_TMP"
    chown root:root "$TASK_KEY_TMP"
    chmod 0600 "$TASK_KEY_TMP"
    mv -f "$TASK_KEY_TMP" "$TASK_KEY_FILE"
    TASK_KEY_TMP=""
    umask "$previous_umask"
}

rewrite_env_task_encryption_key() {
    local previous_umask=""
    previous_umask=$(umask)
    umask 077
    ENV_TMP=$(mktemp /etc/.pulsedns-control.env.XXXXXX)
    grep -v '^PULSEDNS_TASK_ENCRYPTION_KEY=' "$ENV_FILE" > "$ENV_TMP" || true
    printf 'PULSEDNS_TASK_ENCRYPTION_KEY=%s\n' "$TASK_ENCRYPTION_KEY" >> "$ENV_TMP"
    chown root:root "$ENV_TMP"
    chmod 0600 "$ENV_TMP"
    mv -f "$ENV_TMP" "$ENV_FILE"
    ENV_TMP=""
    umask "$previous_umask"
}

ensure_task_encryption_key() {
    local existing="" persisted=""
    existing=$(sed -n 's/^PULSEDNS_TASK_ENCRYPTION_KEY=//p' "$ENV_FILE" | tail -1)
    if [[ -f "$TASK_KEY_FILE" && ! -L "$TASK_KEY_FILE" ]]; then
        IFS= read -r persisted < "$TASK_KEY_FILE" || true
    fi
    if [[ "$existing" =~ ^[a-f0-9]{64}$ ]]; then
        TASK_ENCRYPTION_KEY="$existing"
    elif [[ "$persisted" =~ ^[a-f0-9]{64}$ ]]; then
        TASK_ENCRYPTION_KEY="$persisted"
    else
        generate_task_encryption_key
    fi
    persist_task_encryption_key
    rewrite_env_task_encryption_key
    TASK_ENCRYPTION_KEY=""
    info "Nyanpass 远程同步加密密钥已校验并持久保存"
}

load_existing_http_config() {
    PANEL_PUBLIC_URL=$(sed -n 's/^PULSEDNS_PUBLIC_URL=//p' "$ENV_FILE" | head -1)
    PANEL_BASE_PATH=$(sed -n 's/^PULSEDNS_BASE_PATH=//p' "$ENV_FILE" | head -1)
    PANEL_PORT=$(sed -n 's/^PULSEDNS_PANEL_PORT=//p' "$ENV_FILE" | head -1)
    [[ "$PANEL_BASE_PATH" =~ ^/[a-f0-9]{32}$ && "$PANEL_PORT" =~ ^[0-9]+$ ]] || fail "当前安装不是 HTTP 加密路径版本；请卸载后重新安装"
    [[ "$PANEL_PUBLIC_URL" == http://*"${PANEL_BASE_PATH}" ]] || fail "面板公开地址配置无效"
}

write_panel_config() {
    local previous_umask
    install -d -m 0750 /etc/pulsedns-control
    previous_umask=$(umask)
    umask 077
    if [[ -f "$TASK_KEY_FILE" && ! -L "$TASK_KEY_FILE" ]]; then
        IFS= read -r TASK_ENCRYPTION_KEY < "$TASK_KEY_FILE" || true
    fi
    [[ "$TASK_ENCRYPTION_KEY" =~ ^[a-f0-9]{64}$ ]] || generate_task_encryption_key
    persist_task_encryption_key
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
        printf 'PULSEDNS_TASK_ENCRYPTION_KEY=%s\n' "$TASK_ENCRYPTION_KEY"
    } > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    umask "$previous_umask"
    ADMIN_PASSWORD=""; ALIYUN_KEY_SECRET=""; TASK_ENCRYPTION_KEY=""
}

write_services() {
    local nologin_shell
    nologin_shell=$(command -v nologin || true)
    [[ -n "$nologin_shell" ]] || fail "系统缺少 nologin"
    getent group pulsedns >/dev/null 2>&1 || groupadd --system pulsedns
    if ! id pulsedns >/dev/null 2>&1; then
        useradd --system --gid pulsedns --home "$DATA_DIR" --shell "$nologin_shell" pulsedns
    fi
    install -d -o pulsedns -g pulsedns -m 0750 "$DATA_DIR"
    chown -R pulsedns:pulsedns "$DATA_DIR"
    chmod 0750 "$DATA_DIR"
    if [[ -f "$TASK_KEY_FILE" && ! -L "$TASK_KEY_FILE" ]]; then
        chown root:root "$TASK_KEY_FILE"
        chmod 0600 "$TASK_KEY_FILE"
    fi

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
    systemctl enable "$PANEL_SERVICE" >/dev/null
}

verify_service_access() {
    command -v runuser >/dev/null 2>&1 || fail "缺少 runuser（util-linux）"
    runuser -u pulsedns -- test -x "$INSTALL_ROOT" || fail "服务账号无法进入 ${INSTALL_ROOT}"
    runuser -u pulsedns -- test -x "$RELEASES_DIR" || fail "服务账号无法进入 ${RELEASES_DIR}"
    runuser -u pulsedns -- test -x "$CURRENT_LINK" || fail "服务账号无法进入当前版本目录"
    runuser -u pulsedns -- sh -c 'cd "$1"' sh "$CURRENT_LINK" || fail "服务账号无法切换到工作目录"
    runuser -u pulsedns -- test -r "${CURRENT_LINK}/node_modules/vinext/dist/cli.js" || \
        fail "服务账号无法读取 Vinext 启动文件"
    runuser -u pulsedns -- test -r "${CURRENT_LINK}/dist/server/index.js" || \
        fail "服务账号无法读取生产构建"
    runuser -u pulsedns -- test -x "${CURRENT_LINK}/dist/client" || \
        fail "服务账号无法进入静态资源目录"
    runuser -u pulsedns -- test -w "$DATA_DIR" || fail "服务账号无法写入 ${DATA_DIR}"
    runuser -u pulsedns -- "${RUNTIME_DIR}/node/bin/node" --version >/dev/null || \
        fail "服务账号无法执行 Node.js"
}

install_panel() {
    need_root
    [[ ! -e "$ENV_FILE" && ! -e "$CURRENT_LINK" ]] || fail "面板或未完成安装已存在；请使用 update，或先卸载后重装"
    install_dependencies
    acquire_lock
    prompt_install_config
    prepare_http_endpoint
    detect_arch
    check_build_resources
    port_is_listening "$PANEL_PORT" && fail "TCP 端口 ${PANEL_PORT} 已被占用，请选择其他端口"
    TRANSACTION_MODE="install"
    TRANSACTION_ACTIVE=1
    NEW_RELEASE_DIR=""
    PREVIOUS_RELEASE=""
    trap cleanup_on_exit EXIT
    TEMP_DIR=$(mktemp -d /tmp/pulsedns-panel.XXXXXX)
    install -d -m 0755 "$INSTALL_ROOT" "$RELEASES_DIR" "$RUNTIME_DIR"
    chmod 0755 "$INSTALL_ROOT" "$RELEASES_DIR" "$RUNTIME_DIR"
    if [[ -d "$RELEASES_DIR" ]]; then
        find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -exec rm -rf -- {} +
    fi
    download_node "$TEMP_DIR"
    download_and_build_panel "$TEMP_DIR"
    activate_release "$NEW_RELEASE_DIR"
    write_panel_config
    write_services
    verify_service_access
    systemctl restart "$PANEL_SERVICE" || fail "面板服务启动失败，请运行 journalctl -u ${PANEL_SERVICE}"
    wait_for_panel || fail "面板未能通过启动检查，请运行 journalctl -u ${PANEL_SERVICE}"
    TRANSACTION_ACTIVE=0
    cleanup_old_releases || warn "旧版本清理未完成，可稍后手动处理 ${RELEASES_DIR}"
    cleanup_temp_dir
    trap - EXIT
    ok "安装完成：${PANEL_PUBLIC_URL}"
    warn "请只向你自己的来源 IP 放行 TCP ${PANEL_PORT}；HTTP 不会加密登录、探针或 Nyanpass 任务凭据"
}

update_panel() {
    need_root
    install_dependencies
    acquire_lock
    trap cleanup_on_exit EXIT
    [[ -f "$ENV_FILE" && -L "$CURRENT_LINK" ]] || fail "未检测到已安装面板"
    PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK")
    [[ -d "$PREVIOUS_RELEASE" ]] || fail "当前版本目录不存在，无法安全升级"
    install -d -m 0755 "$INSTALL_ROOT" "$RELEASES_DIR" "$RUNTIME_DIR"
    chmod 0755 "$INSTALL_ROOT" "$RELEASES_DIR" "$RUNTIME_DIR"
    load_existing_http_config
    ensure_task_encryption_key
    detect_arch
    check_build_resources
    TRANSACTION_MODE="update"
    TRANSACTION_ACTIVE=1
    NEW_RELEASE_DIR=""
    TEMP_DIR=$(mktemp -d /tmp/pulsedns-panel-update.XXXXXX)
    download_node "$TEMP_DIR"
    download_and_build_panel "$TEMP_DIR"
    activate_release "$NEW_RELEASE_DIR"
    write_services
    verify_service_access
    if ! systemctl restart "$PANEL_SERVICE" || ! wait_for_panel; then
        fail "新版未能通过启动检查；退出时将自动恢复上一版本"
    fi
    TRANSACTION_ACTIVE=0
    cleanup_old_releases || warn "旧版本清理未完成，可稍后手动处理 ${RELEASES_DIR}"
    cleanup_temp_dir
    trap - EXIT
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
    ok "面板程序已卸载；数据库与远程任务加密密钥仍保留在 ${DATA_DIR}"
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
