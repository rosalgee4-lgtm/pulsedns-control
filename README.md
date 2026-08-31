# PulseDNS

PulseDNS 把原仓库的多份 VPS Shell 脚本合并为一个 Web 主控和一个通用安装脚本。实现范围以原脚本为基线，只加入明确要求的 Web 界面、安装操作菜单、阿里云 DNS 和多 Nyanpass 面板/实例管理。

## 原功能还原范围

| 原脚本功能 | 当前实现 |
| --- | --- |
| IPv4 / IPv6 多地址源回退 | 保留原来的 8 个 IPv4 源和 5 个 IPv6 源及访问顺序 |
| 每 10 秒检测 | 保留 |
| 首次、地址变化或每 10 分钟校准时上报 | 地址变化立即上报；未变化地址也按 TTL 周期做幂等校准，网络失败按最长 5 分钟指数退避 |
| `POST {"ip","type"}` + `X-Secret-Token` | 保留；主控收到后调用阿里云 DNS |
| `/opt/ddns-monitor/monitor.sh` + `ddns-monitor.service` | 保留 |
| `/var/log/ddns-monitor.log` | 保留，卸载时不删除 |
| locale 修复及 curl/coreutils 依赖 | 保留，支持 apt、yum、dnf、apk |
| root 密码与 SSH root/password 登录配置 | 保留；菜单模式现场输入，Web 一键安装经节点专属直链动态下发；root 密码仅以 AES-GCM 密文暂存，成功后擦除 |
| 原 23 项 BBR/sysctl 配置 | 完整安装和 Web 开机安装固定执行；动态生成的脚本显式携带 `--bbr 1`，执行前仍备份 `/etc/sysctl.conf` |
| Nyanpass `rel_nodeclient` 安装 | 保留；创建探针时预配一个或多个实例，由同一份节点专属脚本无人值守安装 |
| `--run` / `--uninstall` | 保留；卸载 DDNS 服务、安装目录、IP 缓存、节点配置及本机任务租约状态 |

原仓库部分文件末尾还拼接了一个不存在的 `vps3_all_in_one_install.sh`，会在已经完成安装或卸载后错误退出。这是失效代码而不是功能，合并版不再执行它。原仓库中的明文 root 密码、DDNS 密钥和 Nyanpass 令牌也不会复制到新程序，均改为运行时输入，且不会以明文写入数据库。

## 架构

```text
Linux VPS / ddns-monitor
  ├─ 按原顺序获取公网 IPv4 / IPv6
  ├─ 与 /tmp 中的上次成功地址比较
  └─ 变化后立即、未变化时每 10 分钟 POST { ip, type }
                 │  X-Secret-Token
                 ▼
PulseDNS Web 主控 /api/v1/report
  ├─ 按节点令牌定位 A / AAAA 记录
  ├─ 调用 AliDNS Describe/Add/UpdateDomainRecord
  └─ 在 Web 中显示节点、记录和更新结果

PulseDNS Web 主控 /api/v1/bootstrap/<node>/<download-token>
  ├─ 只保存并校验高熵下载 Token 的 SHA-256 摘要
  ├─ 绑定 node + generation 解密凭据，按当前版本动态生成脚本
  └─ 预配成功后原子擦除凭据密文和下载摘要，使直链失效

PulseDNS Web 主控 /api/v1/tasks
  ├─ 保存固定类型的 Nyanpass 同步任务
  ├─ 探针主动领取，安装过程不阻塞 DDNS 检测
  └─ 回传成功、失败或租约超时的未知状态

PulseDNS Web 主控 /api/v1/provision
  ├─ 认证开机脚本的开始、心跳和最终结果
  ├─ generation + attempt ID 拒绝旧脚本和旧回执
  └─ 启动租约超时后保守标记为“结果未知”
```

## 阿里云 DNS 配置

主控运行环境需要配置：

```text
ALIBABA_CLOUD_ACCESS_KEY_ID
ALIBABA_CLOUD_ACCESS_KEY_SECRET
ALIBABA_CLOUD_SECURITY_TOKEN   # 仅使用 STS 临时凭证时需要
```

建议使用只允许目标域名执行 `alidns:DescribeDomainRecords`、`alidns:AddDomainRecord`、`alidns:UpdateDomainRecord` 的 RAM 身份。添加节点时填写主域名与主机记录；根记录填写 `@`。同一主域名与主机记录的 A、AAAA 归属分别唯一，多个启用节点不能争用同类型记录；升级检测到历史冲突时会安全暂停较新的冲突节点并留下错误事件。临时同步失败会由探针周期性自愈，同一记录、类型和 IP 的重复失败一小时只记一次，自动事件路径把事件表控制在约 10,000 条。

## 安装与菜单

### 一键安装 Web 主控面板

准备一台使用 systemd、glibc 2.28 或更高版本的 x86_64/arm64 Linux VPS，并确保至少有 2 GiB 可用磁盘及 768 MiB 可用内存与 swap；Alpine/musl、Docker、WSL 和 chroot 不受支持。安装器会自动识别公网 IPv4、询问 HTTP 端口（默认 `3100`），并生成 32 位随机访问路径；不需要域名、证书邮箱或 GitHub Token。只需向自己的来源 IP 放行所选端口，然后以 root 执行：

```bash
( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/main/public/panel-install.sh?v=0.8.2' -o "$tmp" && test "$(sha256sum "$tmp" | awk '{print $1}')" = 'c57121482d304126ee6dc4ddb10afe16242190d1c847d076c7330b9f473d046b' && grep -Fq '# PulseDNS Web 主控一键安装与管理脚本' "$tmp" && bash -n "$tmp" && bash "$tmp" install )
```

脚本会询问端口、管理员账号和阿里云 AccessKey，随后自动安装经过校验的 Node.js、构建 PulseDNS、创建本地 SQLite 数据库、配置管理员 Basic Auth 并注册 systemd 服务。Caddy、域名和 HTTPS 证书流程已完全移除。完成后会显示类似 `http://203.0.113.10:3100/32位随机路径` 的唯一入口；直接访问 IP 与端口根路径不能进入面板。再次不带参数运行同一脚本会打开操作菜单：

1. 一键安装 Web 主控面板
2. 升级面板
3. 查看运行状态
4. 卸载面板（保留数据库）

一键升级命令：

```bash
( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/main/public/panel-install.sh?v=0.8.2' -o "$tmp" && test "$(sha256sum "$tmp" | awk '{print $1}')" = 'c57121482d304126ee6dc4ddb10afe16242190d1c847d076c7330b9f473d046b' && grep -Fq '# PulseDNS Web 主控一键安装与管理脚本' "$tmp" && bash -n "$tmp" && bash "$tmp" update )
```

面板数据保存在 `/var/lib/pulsedns-control/pulsedns.db`；管理员密码、阿里云凭据和独立生成的远程任务与开机凭据加密密钥保存在权限为 `0600` 的 `/etc/pulsedns-control.env`。密钥还会以 `0600` 权限单独保存在 `/var/lib/pulsedns-control/task-encryption.key`，以便卸载程序但保留数据库后仍能恢复待处理任务；升级旧面板时会自动补齐并校验该密钥。

无人值守预配使用的 Nyanpass 安装器与三种架构二进制仍必须通过 SHA-256 校验，但可信清单由主控动态注入。默认值对应当前官方发布；上游正常轮换后，可在 `/etc/pulsedns-control.env` 设置 `PULSEDNS_NYANPASS_INSTALLER_URL`、`PULSEDNS_NYANPASS_INSTALLER_SHA256`、`PULSEDNS_NYANPASS_BINARY_BASE_URL`、`PULSEDNS_NYANPASS_BINARY_RELEASE`、`PULSEDNS_NYANPASS_BINARY_AMD64_SHA256`、`PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256`、`PULSEDNS_NYANPASS_BINARY_ARM64_SHA256` 并重启 `pulsedns-control`。主控只接受 `https://dl.nyafw.com/download/` 官方路径、UUIDv4 发布 ID 和小写 64 位摘要；配置错误时会停止生成新节点脚本，而不是绕过校验。

### 探针安装与菜单

在 Web 控制台创建节点后会得到一条节点专属脚本下载直链；页面同时生成一个适合云厂商 user-data 的短启动器。启动器使用 POSIX `/bin/sh`，显式设置开机环境 `PATH`，首次执行即把自身原子复制到 `/var/lib/cloud/scripts/per-boot/`。如果本次开机未完成，下次开机会再次调用；已有完整脚本时优先复用 `/root/pulsedns_<节点ID>_install.sh`，不会再次消耗下载凭据。当前代次完成并成功恢复 `ddns-monitor` 后，per-boot 副本、完整脚本及 cloud-init 本地 user-data 缓存会被删除。

下载 Token 只有创建后 30 分钟的首次使用窗口；第一次成功生成响应后仅保留 2 分钟，供连接中断时重试传输。即使包含旧直链的 user-data 仍可从 AWS IMDS 读取，窗口结束后也不能再下载敏感 payload。未完成时启动器会校验或补齐 Bash、下载工具与 CA 证书，包管理器暂时被占用或网络未就绪时最多重试 24 次，并使用 `wget` 或 `curl` 最多重试下载 36 次。

```bash
#!/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
# 已有完成标记时恢复 ddns-monitor；否则补齐环境并重试下载。
# 首次运行注册 cloud-init per-boot；下载脚本经语法检查后缓存并复用。
```

下载的完整脚本会先在最小化系统中补齐 `curl`、CA 证书、`coreutils`、`util-linux` 与 `unzip`；包管理器锁或开机网络尚未就绪时会重试。随后等待主控，把过程写入 `/var/log/pulsedns-bootstrap.log`、使用固定文件描述符上的 `flock` 避免并发，并只在全部步骤成功后写入该节点专属的完成标记。直接打开交互式操作菜单时，也从固定的 GitHub HTTPS 发布通道下载安装器并校验 SHA-256（目标机需要 `sha256sum`）：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/install.sh -o "$tmp" &&
  test "$(sha256sum "$tmp" | awk '{print $1}')" = 'b2b6b0e372dce447d05da8ccce27f36b3b8b10ff1bac120d0e1d2f0506240aca' &&
  grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp" &&
  bash -n "$tmp" &&
  bash "$tmp"
)
```

自托管 HTTP 面板不会提供通用的 `/install.sh`、`/monitor.sh` 或 `/update.sh`，这些路径固定返回 404；Sites 托管模式不受此限制。唯一的公开例外是带高熵 Bearer Token 的节点专属 `/api/v1/bootstrap/...`，它只用于该节点的首次开机安装；脚本内部使用的通用安装器仍从固定 GitHub HTTPS 发布通道下载并校验摘要。

菜单只对应原脚本已有动作：

1. 完整安装：locale → DDNS → 依赖 → 一个或多个 Nyanpass → BBR → SSH
2. 仅安装或重新配置 DDNS
3. 安装一个 Nyanpass 实例，可重复执行
4. 配置 root 密码和 SSH 登录
5. 配置 BBR/sysctl
6. 卸载 DDNS
7. 升级现有探针，启用 Nyanpass 远程同步

Web 中“添加探针节点”会先要求填写一次性 root 密码，并预配一个或多个 Nyanpass 服务名、官方命令及原脚本的 `OPTIMIZE` 选项。主控把 root 密码、节点原始令牌和规范化后的预配参数绑定 `nodeId + generation`，以 AES-GCM 加密暂存；页面只返回短时节点专属下载直链，访问时才解密并按当前代码与可信 Nyanpass 清单动态生成脚本。完整脚本执行：补齐基础环境 → 主控令牌预校验 → DDNS 安装与首次上报验收 → 全部 Nyanpass → BBR → 最后事务式配置 SSH → DDNS 复检。每完成一步都会把 `ddns`、`nyanpass`、`bbr` 或 `ssh` 随心跳和最终回执上报；面板在失败或结果未知时显示最后完成阶段，若 SSH 已完成则明确提示使用新密码核查。

新节点创建后先显示“等待开机安装”，不能提前修改或下发额外实例。超过 10 分钟仍未开始时，面板会提示检查 User data、CRLF 和出站网络。开机脚本开始执行后每 20 秒向主控续租，并用节点 generation 与本次随机 attempt ID 绑定回执；旧脚本或另一台机器的回执不能覆盖当前结果。若机器断电或安装进程被强制终止，租约到期后会标记“结果未知”，per-boot 会在下次开机复用本机脚本，但 `started` 安全标记仍会阻止自动重复安装 Nyanpass。恢复时绝对不要先删除 `started`：先确认旧进程已经停止，再运行 `/root/pulsedns_<节点ID>_install.sh`，让它用旧 attempt ID 向主控收敛为失败；只有日志明确显示“主控已确认旧安装失败”后，才删除日志给出的精确 `started` 路径并再次运行本机脚本。下载窗口过期后不要依赖原直链。

每份启动器只绑定一个 `nodeId + token`，不能在 ASG 或 Launch Template 中作为多台实例共享的 User data。批量部署时必须为每台实例单独创建节点；当前版本没有节点池或 AWS Instance Identity Document 认领接口。

创建完成后可在节点、DNS 记录和 Nyanpass 列表中直接修改配置。节点修改会保留原探针令牌与上报状态，并在已有公网地址时立即同步新的阿里云 DNS 映射；单独新增 Nyanpass 实例时，保存后点击“同步到机器”，探针会领取固定类型任务、安装并回传状态。一个节点可以登记多个实例，探针会逐个串行安装。实例名就是传给官方安装器的机器服务名，创建后不可直接改名，避免旧服务仍在 VPS 运行却失去登记；需要换名时应新增实例，确认新服务正常后再移除旧登记。尚未领取的任务可以安全取消；机器开始安装后不能远程取消。只有探针任务心跳离线且节点没有其他安装在运行时，排队超过 5 分钟才会自动结束并允许重试；运行租约超时则标记为“结果未知”并继续接受原探针的晚到回执，绝不会自动重复安装。总览“最近变更”和完整事件日志均支持按节点、类型、级别及关键词筛选，完整日志还可折叠。

HTTP 面板上的“复制开机脚本”和“复制下载直链”按钮都包含兼容回退，复制前会把 CRLF/CR 统一为 LF，并明确显示成功或失败。没有成功提示时不要粘贴，避免使用剪贴板中残留的其他节点旧内容；若实例没有生成 `/var/log/pulsedns-bootstrap*.log`，优先检查粘贴内容是否又被外部编辑器转换为 CRLF。

首次开机 payload 中的 root 密码、原始探针 Token 和预配 Nyanpass 参数只以 AES-GCM 密文暂存，下载 Token 只保存 SHA-256 摘要与到期/首次使用时间。首次使用前最多有效 30 分钟，首次响应后最多重放 2 分钟；当前 generation 安装成功后，密文、摘要和窗口字段在同一状态更新中清空。`failed` 或 `uncertain` 时密文仍保留供同一 attempt 回执收敛，但旧下载 Token 不会长期恢复有效。为支持稍后点击同步，单独新增实例的 Nyanpass Token 使用同一主控密钥的独立加密域保存；成功安装、任务失效或结果未知后立即清除。

**HTTP + 随机路径不是 TLS。** 下载直链本身是 Bearer 凭据，拿到它的人在短时窗口内可以下载包含敏感凭据的完整脚本；不要把它放进聊天、截图、工单、公开日志或第三方短链。AWS IMDS 在实例生命周期内仍可能返回原始 user-data，本项目通过短时消费窗口降低重放风险，但不能替代 IMDSv2、严格 hop limit、HTTPS 或最小权限实例配置。HTTP 模式只能用于可信网络，并必须把面板端口限制到自己的来源 IP；怀疑窗口内泄漏时应删除节点登记并重新创建。一个节点令牌只能用于一台 VPS，不要复制到第二台机器。

完整安装会修改 root 密码、SSH 登录策略并覆盖 `/etc/sysctl.conf`（原文件会带时间戳备份），与原脚本行为一致。卸载 DDNS 会清除 `/var/lib/ddns-monitor/tasks` 中的本地任务租约文件，但不会回滚这些系统设置，也不会卸载 Nyanpass。

## 升级 DDNS 探针

使用当前 PulseDNS 安装器部署的节点可运行独立升级脚本：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.2/public/update.sh -o "$tmp" &&
  test "$(sha256sum "$tmp" | awk '{print $1}')" = 'cb205c5eb429d2f77d56169fb5d7afac549aa46cf6d3d7d8ab70cd4572dcec17' &&
  bash "$tmp"
)
```

升级器支持 HTTPS 地址，以及带端口和 32 位随机路径的 HTTP 主控地址。它先补齐 `curl`、`jq`、`coreutils` 与 `util-linux`，再从 GitHub HTTPS 的 `release-v0.8.2` 发布通道下载专用 `monitor.sh` 并校验代码内固定的 SHA-256；不会从 HTTP 主控执行 root 脚本，也不会下载或执行完整安装器。它只替换 DDNS 探针，不接受新的主控地址或令牌，也不改 systemd 单元、配置、SSH、BBR 或 Nyanpass。配置、IP 缓存和日志不会被清空；运行中的服务会重启并继续正常检测，若公网 IP 此时已经变化，仍会按原逻辑上报并更新 DNS。停止的服务保持停止。新版启动失败时会恢复旧探针，并在 `/opt/ddns-monitor/monitor.sh.previous` 保留上一版本。

v0.7.x 及更早的探针不会轮询任务，第一次使用远程同步前必须升级一次。Nyanpass 页面会按节点版本显示“先升级探针”，并生成保留现有 `/etc/ddns-monitor.conf` 的一次性升级命令。v0.8.0 之后，探针每轮独立检查任务；官方安装器最长运行 10 分钟，超时后再给 30 秒强制终止进程组，但在后台锁中串行执行，不会暂停原来的 IP 检测。

## Nyanpass 入口与出口

Web 中添加实例时粘贴 Nyanpass 面板生成的原始命令。程序只检查 `rel_nodeclient` 参数：

- 参数中存在独立的 `-o`：出口。
- 参数中不存在 `-o`：入口。

不会根据 Token、面板 URL、IP 或端口猜测。创建探针时可一次添加多个面板/实例，它们仍随开机脚本自动安装；这个原流程没有改动。探针运行后再追加实例时，主控只下发 `serviceName`、入口/出口、HTTPS 面板地址、Token 和 `OPTIMIZE` 这些结构化字段；探针固定校验 Nyanpass 官方安装器及 amd64、amd64v3、arm64 对应二进制包的 SHA-256，再通过官方 `NO_DOWNLOAD=1` 路径安装，不执行上游未校验的二级下载脚本，并拒绝任意命令、脚本地址或额外参数。`OPTIMIZE=0` 会保持为空传给官方脚本，不再误触发优化；再次同步同名实例时会原子刷新 `start.sh` 中的已校验参数。

## DDNS API

`POST /api/v1/report`

```http
X-Secret-Token: <节点独立令牌>
Content-Type: application/json
```

```json
{"ip":"203.0.113.42","type":"A"}
```

`type` 只能是 `A` 或 `AAAA`。成功响应保持原脚本所检查的紧凑字段：

```json
{"status":"ok"}
```

## 本地开发

```bash
pnpm install
pnpm dev
pnpm lint
pnpm build
```
