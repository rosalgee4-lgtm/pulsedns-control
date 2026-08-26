# PulseDNS

PulseDNS 把原仓库的多份 VPS Shell 脚本合并为一个 Web 主控和一个通用安装脚本。实现范围以原脚本为基线，只加入明确要求的 Web 界面、安装操作菜单、阿里云 DNS 和多 Nyanpass 面板/实例管理。

## 原功能还原范围

| 原脚本功能 | 当前实现 |
| --- | --- |
| IPv4 / IPv6 多地址源回退 | 保留原来的 8 个 IPv4 源和 5 个 IPv6 源及访问顺序 |
| 每 10 秒检测 | 保留 |
| 首次或地址变化才上报 | 保留；仅主控返回 `{"status":"ok"}` 后更新 `/tmp` 缓存 |
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
  └─ 变化后 POST { ip, type }
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

建议使用只允许目标域名执行 `alidns:DescribeDomainRecords`、`alidns:AddDomainRecord`、`alidns:UpdateDomainRecord` 的 RAM 身份。添加节点时填写主域名与主机记录；根记录填写 `@`。

## 安装与菜单

### 一键安装 Web 主控面板

准备一台使用 systemd、glibc 2.28 或更高版本的 x86_64/arm64 Linux VPS，并确保至少有 2 GiB 可用磁盘及 768 MiB 可用内存与 swap；Alpine/musl、Docker、WSL 和 chroot 不受支持。安装器会自动识别公网 IPv4、询问 HTTP 端口（默认 `3100`），并生成 32 位随机访问路径；不需要域名、证书邮箱或 GitHub Token。只需向自己的来源 IP 放行所选端口，然后以 root 执行：

```bash
( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/main/public/panel-install.sh?v=0.8.1' -o "$tmp" && test "$(sha256sum "$tmp" | awk '{print $1}')" = '3342bdd265a8bcff56838287db24beff0c89792bb5a62febaa92a7b46a0e9104' && grep -Fq '# PulseDNS Web 主控一键安装与管理脚本' "$tmp" && bash -n "$tmp" && bash "$tmp" install )
```

脚本会询问端口、管理员账号和阿里云 AccessKey，随后自动安装经过校验的 Node.js、构建 PulseDNS、创建本地 SQLite 数据库、配置管理员 Basic Auth 并注册 systemd 服务。Caddy、域名和 HTTPS 证书流程已完全移除。完成后会显示类似 `http://203.0.113.10:3100/32位随机路径` 的唯一入口；直接访问 IP 与端口根路径不能进入面板。再次不带参数运行同一脚本会打开操作菜单：

1. 一键安装 Web 主控面板
2. 升级面板
3. 查看运行状态
4. 卸载面板（保留数据库）

一键升级命令：

```bash
( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/main/public/panel-install.sh?v=0.8.1' -o "$tmp" && test "$(sha256sum "$tmp" | awk '{print $1}')" = '3342bdd265a8bcff56838287db24beff0c89792bb5a62febaa92a7b46a0e9104' && grep -Fq '# PulseDNS Web 主控一键安装与管理脚本' "$tmp" && bash -n "$tmp" && bash "$tmp" update )
```

面板数据保存在 `/var/lib/pulsedns-control/pulsedns.db`；管理员密码、阿里云凭据和独立生成的远程任务与开机凭据加密密钥保存在权限为 `0600` 的 `/etc/pulsedns-control.env`。密钥还会以 `0600` 权限单独保存在 `/var/lib/pulsedns-control/task-encryption.key`，以便卸载程序但保留数据库后仍能恢复待处理任务；升级旧面板时会自动补齐并校验该密钥。

### 探针安装与菜单

在 Web 控制台创建节点后会得到一条节点专属脚本下载直链；页面同时按已验证的 VPS 开机脚本形式生成一个很短的启动器，把该直链用 `wget` 下载到 `/root`、赋予执行权限并交给 Bash。完整节点脚本仍由直链动态返回，不会嵌进创建接口响应，所以主控修复脚本后无需重新创建节点；平台可为启动重试重复下载，直到本次预配成功后直链自动失效。页面生成的启动器结构如下：

```bash
#!/bin/bash
umask 077
wget -O '/root/pulsedns_<节点ID>_install.sh' '<节点脚本下载直链>' && chmod +x '/root/pulsedns_<节点ID>_install.sh' && bash '/root/pulsedns_<节点ID>_install.sh'
```

下载的完整脚本会先在最小化系统中补齐 `curl`、CA 证书、`coreutils` 与 `util-linux`，再等待主控，把过程写入 `/var/log/pulsedns-bootstrap.log`、使用由内核在进程结束时自动释放的 `flock` 避免并发，并只在全部步骤成功后写入该节点专属的完成标记；后续重启只启动现有 DDNS 服务，不会覆盖令牌或重复安装 Nyanpass。直接打开交互式操作菜单时，也从固定的 GitHub HTTPS 发布通道下载安装器并校验 SHA-256（目标机需要 `sha256sum`）：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.1/public/install.sh -o "$tmp" &&
  test "$(sha256sum "$tmp" | awk '{print $1}')" = '092e281a8c3bad87ee0919be78e86efd4867932bb05ddeb6b1526d2c028b80e5' &&
  grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp" &&
  bash -n "$tmp" &&
  bash "$tmp"
)
```

自托管 HTTP 面板不会提供通用的 `/install.sh`、`/monitor.sh` 或 `/update.sh`，这些路径固定返回 404；Sites 托管模式不受此限制。唯一的公开例外是带高熵 Bearer Token 的节点专属 `/api/v1/bootstrap/...`，它只用于该节点的首次开机安装；脚本内部使用的通用安装器仍从固定 GitHub HTTPS 发布通道下载并校验摘要。

菜单只对应原脚本已有动作：

1. 完整安装：locale → SSH → DDNS → 依赖 → 一个或多个 Nyanpass → BBR
2. 仅安装或重新配置 DDNS
3. 安装一个 Nyanpass 实例，可重复执行
4. 配置 root 密码和 SSH 登录
5. 配置 BBR/sysctl
6. 卸载 DDNS
7. 升级现有探针，启用 Nyanpass 远程同步

Web 中“添加探针节点”会先要求填写一次性 root 密码，并预配一个或多个 Nyanpass 服务名、官方命令及原脚本的 `OPTIMIZE` 选项。主控把 root 密码、节点原始令牌和规范化后的预配参数绑定 `nodeId + generation`，以 AES-GCM 加密暂存；页面只返回节点专属下载直链，访问时才解密并按当前代码动态生成脚本。可复制的开机启动器会先检查并补齐 `wget` 与 CA 证书，然后严格按 `wget -O → chmod +x → bash` 执行，并把首阶段日志写入 `/var/log/pulsedns-bootstrap-launcher.log`。完整脚本执行：补齐基础环境 → 主控令牌预校验 → 事务式配置 SSH → DDNS 安装 → 首次地址上报验收 → 全部 Nyanpass → BBR → DDNS 复检。主控确认令牌有效后才会修改 SSH；只有主控认证过至少一次格式正确的公网地址上报后才会继续安装 Nyanpass。阿里云 DNS 同步失败不会把有效探针误判为未安装，但 IP 不会写入本地成功缓存，探针会继续重试 DNS。可复制启动器受 15 KiB user-data 上限约束，下载后的完整安装脚本另受 64 KiB 服务端上限保护。

新节点创建后先显示“等待开机安装”，不能提前修改或下发额外实例。开机脚本开始执行后每 20 秒向主控续租，并用节点 generation 与本次随机 attempt ID 绑定回执；在真正修改机器前重跑会恢复同一次尝试，旧脚本或另一台机器的回执不能覆盖当前结果。若机器断电或安装进程被强制终止，租约到期后会标记“结果未知”，脚本也不会自动重复安装。恢复时绝对不要先删除 `started`：先确认旧进程已经停止，再使用原直链重新下载并运行同一节点脚本，让它用旧 attempt ID 向主控收敛为失败；只有日志明确显示“主控已确认旧安装失败”后，才删除日志给出的该节点精确 `started` 路径，并再次通过原直链下载运行，开始新尝试。`failed` 或 `uncertain` 时直链会保留；若回执未送达，继续保留标记，待网络和主控恢复后重试。成功后直链失效，也可以在明确核查后删除整个节点登记。

创建完成后可在节点、DNS 记录和 Nyanpass 列表中直接修改配置。节点修改会保留原探针令牌与上报状态，并在已有公网地址时立即同步新的阿里云 DNS 映射；单独新增 Nyanpass 实例时，保存后点击“同步到机器”，探针会领取固定类型任务、安装并回传状态。一个节点可以登记多个实例，探针会逐个串行安装。实例名就是传给官方安装器的机器服务名，创建后不可直接改名，避免旧服务仍在 VPS 运行却失去登记；需要换名时应新增实例，确认新服务正常后再移除旧登记。尚未领取的任务可以安全取消；机器开始安装后不能远程取消。只有探针任务心跳离线且节点没有其他安装在运行时，排队超过 5 分钟才会自动结束并允许重试；运行租约超时则标记为“结果未知”并继续接受原探针的晚到回执，绝不会自动重复安装。总览“最近变更”和完整事件日志均支持按节点、类型、级别及关键词筛选，完整日志还可折叠。

HTTP 面板上的“复制开机脚本”和“复制下载直链”按钮都包含兼容回退，并明确显示“复制成功”或“复制失败”。没有成功提示时不要粘贴，避免使用剪贴板中残留的其他节点旧内容。

首次开机 payload 中的 root 密码、原始探针 Token 和预配 Nyanpass 参数只以 AES-GCM 密文暂存，下载 Token 只保存 SHA-256 摘要；当前 generation 的安装成功后，密文和摘要在同一状态更新中清空，`failed` 或 `uncertain` 时则保留用于恢复。为支持稍后点击同步，单独新增实例的 Nyanpass Token 使用同一主控密钥的独立加密域保存；成功安装、任务失效或结果未知后立即清除。原始凭据、摘要、密文和安装参数都不会进入列表 API、事件或错误日志。这里的“同步成功”严格表示 Nyanpass 官方安装器退出码为 0，不代表面板能远程验证该服务此后一直在线。

**HTTP + 随机路径不是 TLS。** 下载直链本身是 Bearer 凭据，拿到它的人在失效前可以下载包含敏感凭据的完整脚本；不要把它放进聊天、截图、工单、公开日志或第三方短链。AES-GCM 只保护数据库中的待用凭据，HTTP 传输时下载直链、节点令牌、任务租约和 Nyanpass Token 仍可能被监听或篡改；随机路径不能解决这个问题。HTTP 模式只能用于你明确接受该风险的可信网络，并必须把面板端口限制到自己的来源 IP；需要传输保密性和抗中间人攻击时必须在面板前配置 HTTPS。成功后直链会自动失效；怀疑泄漏时应删除节点登记并重新创建。一个节点令牌只能用于一台 VPS，不要复制到第二台机器。

完整安装会修改 root 密码、SSH 登录策略并覆盖 `/etc/sysctl.conf`（原文件会带时间戳备份），与原脚本行为一致。卸载 DDNS 会清除 `/var/lib/ddns-monitor/tasks` 中的本地任务租约文件，但不会回滚这些系统设置，也不会卸载 Nyanpass。

## 升级 DDNS 探针

使用当前 PulseDNS 安装器部署的节点可运行独立升级脚本：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/release-v0.8.1/public/update.sh -o "$tmp" &&
  test "$(sha256sum "$tmp" | awk '{print $1}')" = 'c75f56465886c7595b1df80432145a8c72f161d5aa266e7ac0030698c38a16d9' &&
  bash "$tmp"
)
```

升级器支持 HTTPS 地址，以及带端口和 32 位随机路径的 HTTP 主控地址。它先补齐 `curl`、`jq`、`coreutils` 与 `util-linux`，再从 GitHub HTTPS 的 `release-v0.8.1` 发布通道下载专用 `monitor.sh` 并校验代码内固定的 SHA-256；不会从 HTTP 主控执行 root 脚本，也不会下载或执行完整安装器。它只替换 DDNS 探针，不接受新的主控地址或令牌，也不改 systemd 单元、配置、SSH、BBR 或 Nyanpass。配置、IP 缓存和日志不会被清空；运行中的服务会重启并继续正常检测，若公网 IP 此时已经变化，仍会按原逻辑上报并更新 DNS。停止的服务保持停止。新版启动失败时会恢复旧探针，并在 `/opt/ddns-monitor/monitor.sh.previous` 保留上一版本。

v0.7.x 及更早的探针不会轮询任务，第一次使用远程同步前必须升级一次。Nyanpass 页面会按节点版本显示“先升级探针”，并生成保留现有 `/etc/ddns-monitor.conf` 的一次性升级命令。v0.8.0 之后，探针每轮独立检查任务；官方安装器最长运行 10 分钟，但在后台锁中串行执行，不会暂停原来的 IP 检测。

## Nyanpass 入口与出口

Web 中添加实例时粘贴 Nyanpass 面板生成的原始命令。程序只检查 `rel_nodeclient` 参数：

- 参数中存在独立的 `-o`：出口。
- 参数中不存在 `-o`：入口。

不会根据 Token、面板 URL、IP 或端口猜测。创建探针时可一次添加多个面板/实例，它们仍随开机脚本自动安装；这个原流程没有改动。探针运行后再追加实例时，主控只下发 `serviceName`、入口/出口、HTTPS 面板地址、Token 和 `OPTIMIZE` 这些结构化字段；探针固定下载 Nyanpass 官方安装器，拒绝任意命令、脚本地址或额外参数。

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
