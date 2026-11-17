# PulseDNS

PulseDNS 把原仓库的多份 VPS Shell 脚本合并为一个 Web 主控（Docker + 外置 MySQL / MariaDB）和一个通用安装脚本。实现范围以原脚本为基线，只加入明确要求的 Web 界面、安装操作菜单、阿里云 DNS 和多 Nyanpass 面板/实例管理。

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
| root 密码与 SSH root/password 登录配置 | 保留；菜单模式现场输入，Web 一键安装经节点专属配置数据下发；root 密码仅以 AES-GCM 密文保存，供 Spot 换机重装 |
| 原 23 项 BBR/sysctl 配置 | 完整安装和 Web 开机安装固定执行；添加节点时用下拉框选择 c6in（10MB 缓冲，默认）或 c5in（50MB 缓冲），选择写入生成的安装命令，安装时无人值守执行；菜单模式使用 c6in。执行前仍备份 `/etc/sysctl.conf` |
| Nyanpass `rel_nodeclient` 安装 | 保留；创建探针时预配一个或多个实例，由固定公共安装器读取节点配置后无人值守安装 |
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
  ├─ 绑定 node + generation 解密凭据，输出有界的节点配置数据
  ├─ 不生成也不返回可执行 Shell；全部安装逻辑位于固定公共安装器
  └─ 链接长期有效：Spot 换机后新机器用同一份 User data 重新安装；删除节点即撤销

PulseDNS Web 主控 /api/v1/tasks
  ├─ 保存固定类型的 Nyanpass 同步任务
  ├─ 探针主动领取，安装过程不阻塞 DDNS 检测
  └─ 回传成功、失败或租约超时的未知状态

PulseDNS Web 主控 /api/v1/provision
  ├─ 认证固定安装器的开始、心跳和最终结果
  ├─ generation + attempt ID 拒绝旧脚本和旧回执
  └─ 启动租约超时后保守标记为“结果未知”
```

## 阿里云 DNS 配置

阿里云 AccessKey 只在面板的「阿里云主域名」页面添加，不再写入环境变量：

1. 先添加阿里云账号（名称 + AccessKey ID + AccessKey Secret）。保存时调用一次 `DescribeDomains` 校验 Key 是否有效；只授权了部分域名的 RAM 用户被拒绝列出域名时，仍视为 Key 有效。
2. 再添加主域名并选择它属于哪个账号。保存主域名、把主域名改到其他账号、更换账号 Key 时，都会用对应 Key 调用一次 `DescribeDomainRecords` 读取该域名，读不到就不保存。
3. 添加节点时从下拉框选择主域名并填写主机记录，根记录填 `@`。

AccessKey ID 与 Secret 用 `PULSEDNS_TASK_ENCRYPTION_KEY` 派生的 AES-GCM 密钥一起加密后存入数据库，只在输入时可见；之后页面和接口只显示头尾各 4 位，例如 `LTAI****x9Qk`。正在被主域名使用的账号不能删除，正在被节点使用的主域名不能删除。

同一主域名与主机记录的 A、AAAA 归属分别唯一，多个启用节点不能争用同类型记录（数据库用生成列 + 唯一索引保证）。临时同步失败会由探针周期性自愈，同一记录、类型和 IP 的重复失败一小时只记一次，自动事件路径把事件表控制在约 10,000 条。

### RAM 子账号需要的权限

根据阿里云文档《云解析 DNS · RAM 权限策略的操作资源和条件》以及各接口文档的授权信息，PulseDNS 只调用下面 4 个接口：

| 接口 | RAM 操作 | 用途 | 资源 |
| --- | --- | --- | --- |
| DescribeDomainRecords | `alidns:DescribeDomainRecords` | 查询主机记录；保存主域名时校验 | `acs:alidns::{账号ID}:domain/{域名}`，可按域名授权 |
| AddDomainRecord | `alidns:AddDomainRecord` | 记录不存在时新建 A / AAAA | `acs:alidns::{账号ID}:domain/{域名}`，可按域名授权 |
| UpdateDomainRecord | `alidns:UpdateDomainRecord` | IP 变化时更新记录 | 文档给出的格式是 `acs:alidns::{账号ID}:domain/{#domainId}` |
| DescribeDomains | `alidns:DescribeDomains` | 仅在添加或更换 Key 时校验 Key（可选） | 只能授权 `*` |

前三个是必需的。`DescribeDomains` 不授权也能用：面板遇到它被拒绝时会继续把 Key 视为有效。建议给 RAM 用户只授予下面的自定义策略，把 `example.com` 换成你的主域名，多个域名写多行：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["alidns:DescribeDomainRecords", "alidns:AddDomainRecord", "alidns:UpdateDomainRecord"],
      "Resource": ["acs:alidns:*:*:domain/example.com"]
    }
  ]
}
```

注意：阿里云文档里 `UpdateDomainRecord` 的资源写的是 `{#domainId}` 而不是域名，文档没有进一步说明。如果按域名授权后，事件日志里出现更新记录被拒（`Forbidden` / `NoPermission`），请把 `alidns:UpdateDomainRecord` 单独放到一条资源为 `acs:alidns:*:*:domain/*` 的语句里。不要直接使用主账号 AccessKey 或 `AliyunDNSFullAccess` 这类全量权限。

## 登录、多用户与安全

- **登录**：独立登录页 + 会话 Cookie（`HttpOnly`、`SameSite=Strict`、HTTPS 下 `Secure`），会话 12 小时后失效，可随时退出。数据库只保存会话令牌的 SHA-256。
- **密码**：管理员与用户的密码只保存 scrypt 加盐哈希，无法还原，忘记只能重置。首次启动时由 `PULSEDNS_INITIAL_ADMIN_USER` / `PULSEDNS_INITIAL_ADMIN_PASSWORD` 创建唯一的管理员；创建后可以把这两行从 `.env` 删除，之后在「设置」里修改密码。
- **多用户模式**：在「设置 → 管理员设置」中开关，默认关闭。关闭时只允许管理员登录，已登录的普通用户会立即被退出（他们的节点照常运行、照常同步解析）。开启后，普通用户只能看到和管理自己的节点、Nyanpass 实例、主域名和阿里云账号；管理员可以看到全部。普通用户由管理员在「设置」中创建，不开放注册；还有节点、主域名或阿里云账号的用户不能删除。
- **防爆破**：15 分钟内同一来源 IP + 用户名失败 5 次，或同一来源 IP 失败 20 次（不论用户名），对应来源锁定 15 分钟，锁定期间密码正确也会被拒绝。用户名不存在时也执行同等耗时的校验，避免按耗时探测用户名。
- **跨站请求防护**：所有修改类接口（包括登录）只接受面板自己页面发出的请求（`Sec-Fetch-Site: same-origin`；旧浏览器比对 `Origin` 与 `Host`）。页面禁止被其他网站嵌入（`X-Frame-Options: DENY`、`frame-ancestors 'none'`）。
- **HTTPS**：面板容器只提供 HTTP，并且只绑定本机 `127.0.0.1`，由宝塔反向代理对外提供 HTTPS。未经 HTTPS 的登录会被拒绝。
- **加密存储**：阿里云 AccessKey、root 密码、开机配置和 Nyanpass Token 都用 `PULSEDNS_TASK_ENCRYPTION_KEY` 加密后存入数据库。这个密钥一旦使用就不能更换或丢失，请和数据库备份分开保管。

## 部署 Web 主控面板（Docker + 外置数据库）

面板以 Docker 容器运行，数据保存在你自己的 MySQL 8.0+ 或 MariaDB 10.6+（已在 MySQL 8.4 与 MariaDB 11.4 上测试）。启动时自动建表和升级表结构。

### 1. 准备数据库

在数据库服务器上创建独立的库和用户，只授予这个库的权限：

```sql
CREATE DATABASE pulsedns CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pulsedns'@'%' IDENTIFIED BY '请替换为强密码';
GRANT ALL PRIVILEGES ON pulsedns.* TO 'pulsedns'@'%';
```

如果数据库在另一台服务器上，请只对面板服务器的 IP 开放 3306 端口，并尽量走内网。

### 2. 获取固定版本的源码并配置

```bash
git clone https://github.com/rosalgee4-lgtm/pulsedns-control.git
```

```bash
git -C pulsedns-control checkout --detach __PANEL_SOURCE_COMMIT__
```

```bash
cd pulsedns-control && cp .env.example .env && chmod 600 .env
```

编辑 `.env`，逐项填写：

| 变量 | 说明 |
| --- | --- |
| `PULSEDNS_DATABASE_URL` | `mysql://用户:密码@主机:3306/pulsedns`；密码里的特殊字符要做 URL 编码 |
| `PULSEDNS_PUBLIC_URL` | 宝塔里绑定的 HTTPS 地址，例如 `https://panel.example.com`，安装命令和开机脚本都用它 |
| `PULSEDNS_BASE_PATH` | 随机入口路径，用 `printf '/%s\n' "$(openssl rand -hex 16)"` 生成 |
| `PULSEDNS_TASK_ENCRYPTION_KEY` | 加密密钥，用 `openssl rand -hex 32` 生成，之后不能更换 |
| `PULSEDNS_INITIAL_ADMIN_USER` / `PULSEDNS_INITIAL_ADMIN_PASSWORD` | 首次启动创建的管理员，密码 12-128 位 |
| `PULSEDNS_PANEL_PORT` | 面板在本机监听的端口，默认 `3100`，只绑定 `127.0.0.1` |

### 3. 启动

```bash
docker compose up -d --build
```

镜像在本机按上面固定的 commit 构建，基础镜像按摘要固定；容器以非 root 用户、只读根文件系统运行，并去掉全部 Linux capabilities。查看日志：`docker compose logs -f pulsedns`。

### 4. 在宝塔中开启 HTTPS 反向代理

1. 「网站」→「添加站点」，域名填 `panel.example.com`（需先解析到这台服务器）。
2. 站点设置 →「SSL」→ 申请 Let's Encrypt 证书，并打开「强制 HTTPS」。
3. 站点设置 →「反向代理」→ 添加反向代理，目标 URL 填 `http://127.0.0.1:3100`，发送域名填 `$host`。
4. 编辑反向代理的配置文件，确认包含下面几行（宝塔默认缺少 `X-Forwarded-Proto`，缺少时面板会因为“未经 HTTPS”拒绝登录）：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

防爆破按 `X-Real-IP` 识别来源。容器端口只绑定本机，外部无法绕过宝塔直接访问，所以面板信任这些代理头。完成后打开 `https://panel.example.com/<随机入口路径>/` 登录；直接访问域名根路径不能进入面板。

### 5. 升级

```bash
git -C pulsedns-control fetch origin
```

```bash
git -C pulsedns-control checkout --detach <新的发布 commit>
```

```bash
cd pulsedns-control && docker compose up -d --build
```

### Nyanpass 可信发布清单

无人值守预配使用的 Nyanpass 安装器与三种架构二进制必须通过 SHA-256 校验，可信清单由主控注入。默认值对应当前官方发布；上游正常轮换后，可在 `.env` 设置 `PULSEDNS_NYANPASS_INSTALLER_URL`、`PULSEDNS_NYANPASS_INSTALLER_SHA256`、`PULSEDNS_NYANPASS_BINARY_BASE_URL`、`PULSEDNS_NYANPASS_BINARY_RELEASE`、`PULSEDNS_NYANPASS_BINARY_AMD64_SHA256`、`PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256`、`PULSEDNS_NYANPASS_BINARY_ARM64_SHA256`，然后执行 `docker compose up -d`。主控只接受 `https://dl.nyafw.com/download/` 官方路径、UUIDv4 发布 ID 和小写 64 位摘要；配置错误时会停止生成新节点配置，而不是绕过校验。

## 探针安装与菜单


在 Web 控制台创建节点后，页面提供两种安装方式；关闭窗口或刷新页面后，可以在节点列表点击“安装命令”再次复制，无需删除重建节点：

1. **开机脚本 · User data**：默认选中，复制完整 POSIX `/bin/sh` 启动脚本到云服务器的 User data。
2. **下载并运行 · 一键命令**：复制一整行到目标 VPS 的 root Bash，自动下载固定版本公共脚本、校验 SHA-256，然后运行 `probe 节点参数`，不是单独的下载地址。

界面生成的命令包含真实节点参数和当前发布摘要；下面只演示结构，不要直接执行占位符：

```bash
( set -eu; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 -fLSs 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/661ef2da011e57ccf6d91518738a7fb07cfd8853/public/install.sh' -o "$tmp"; printf '%s  %s\n' 'c39616fbeec961dfa259bfc5503faa3f4b8025a0d94d0d3d0127ec2c0d63a87d' "$tmp" | sha256sum -c -; bash "$tmp" probe '<节点参数>' 'c6in' )
```

公共安装器会把接口返回的配置数据校验后以 `0600` 缓存为 `/root/pulsedns_<节点ID>_bootstrap.config`，并把通过 SHA-256 校验的同一固定安装器以 `0700` 缓存为 `/root/pulsedns_<节点ID>_installer.sh`；接口不会生成或返回另一份 Shell 脚本。开机启动器显式设置 `PATH`，首次执行即把自身原子复制到 `/var/lib/cloud/scripts/per-boot/`，并使用独立的 `_entrypoint.sh` 缓存，避免与安装器缓存互相覆盖。如果本次开机未完成，下次开机会再次调用；当前代次完成并成功恢复 `ddns-monitor` 后，敏感缓存与 per-boot 副本会被删除，仅清理包含本节点参数的 cloud-init 本地 user-data，不清理无关启动内容。

安装链接（下载 Token）长期有效，不会过期，也不会在首次使用或安装成功后失效；重复打开“安装命令”始终返回同一份开机脚本和一键命令，因此可以直接写入 AWS 启动模板。删除节点即撤销链接。已完成安装的节点在列表中同时提供“安装命令”和“升级命令”；同一台机器重复执行开机脚本时，会根据本机完成标记直接恢复 DDNS，不会重复安装 Nyanpass。未完成时启动器会校验或补齐 Bash、`curl`、校验工具与 CA 证书，包管理器暂时被占用或网络未就绪时最多重试 24 次，并最多重试下载固定安装器 36 次；固定安装器再用节点参数下载配置。

```bash
#!/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
# 已有完成标记时恢复 ddns-monitor；否则补齐环境并重试固定安装器。
# 首次运行注册 cloud-init per-boot；安装器经摘要校验后调用 probe 节点参数。
```

固定公共安装器会先在最小化系统中补齐 `curl`、CA 证书、`coreutils`、`util-linux` 与 `unzip`；包管理器锁或开机网络尚未就绪时会重试。它校验节点配置的协议、字段数量、权限与所有 Nyanpass 参数，随后等待主控，把过程写入 `/var/log/pulsedns-bootstrap.log`、使用固定文件描述符上的 `flock` 避免并发，并只在全部步骤成功后写入该节点专属的完成标记。直接打开交互式操作菜单时，也可从固定的 GitHub HTTPS 发布通道下载安装器并校验 SHA-256（目标机需要 `sha256sum`）：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/661ef2da011e57ccf6d91518738a7fb07cfd8853/public/install.sh -o "$tmp" &&
  printf '%s  %s\n' 'c39616fbeec961dfa259bfc5503faa3f4b8025a0d94d0d3d0127ec2c0d63a87d' "$tmp" | sha256sum -c - &&
  grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp" &&
  bash -n "$tmp" &&
  bash "$tmp"
)
```

自托管 HTTP 面板不会提供通用的 `/install.sh`、`/monitor.sh` 或 `/update.sh`，这些路径固定返回 404；Sites 托管模式不受此限制。唯一的公开例外是带高熵 Bearer Token 的节点专属 `/api/v1/bootstrap/...`，它只返回该节点首次安装所需的配置数据，不返回可执行脚本；通用安装器始终来自固定 GitHub HTTPS 发布通道并校验摘要。

菜单只对应原脚本已有动作：

1. 完整安装：locale → DDNS → 依赖 → 一个或多个 Nyanpass → BBR → SSH
2. 仅安装或重新配置 DDNS
3. 安装一个 Nyanpass 实例，可重复执行
4. 配置 root 密码和 SSH 登录
5. 配置 BBR/sysctl
6. 卸载 DDNS
7. 升级现有探针，启用 Nyanpass 远程同步

Web 中“添加探针节点”会先要求填写一次性 root 密码，选择 BBR 优化（c6in 或 c5in），并预配一个或多个 Nyanpass 服务名和官方命令。原 `OPTIMIZE` 选项已移除，一律以 `OPTIMIZE=0` 调用官方安装器，系统参数只由 BBR 选项控制。主控把 root 密码、节点原始令牌、下载凭据和规范化后的预配参数绑定 `nodeId + generation`，以 AES-GCM 加密暂存；页面并列提供开机脚本和下载后运行的一键命令。节点访问短时参数时，主控才解密并返回当前可信清单组成的有界配置数据。固定安装器执行：补齐基础环境 → 主控令牌预校验 → DDNS 安装与首次上报验收 → 全部 Nyanpass → BBR → 最后事务式配置 SSH → DDNS 复检。每完成一步都会把 `ddns`、`nyanpass`、`bbr` 或 `ssh` 随心跳和最终回执上报；面板在失败或结果未知时显示最后完成阶段，若 SSH 已完成则明确提示使用新密码核查。

新节点创建后先显示“等待开机安装”，不能提前修改或下发额外实例。超过 10 分钟仍未开始时，面板会提示检查 User data、CRLF 和出站网络。固定安装器开始执行后每 20 秒向主控续租，并用节点 generation 与本次随机 attempt ID 绑定回执；旧参数或另一台机器的回执不能覆盖当前结果。若机器断电或安装进程被强制终止，租约到期后会标记“结果未知”，per-boot 会在下次开机复用本机固定安装器和配置。探针对接全程无人值守：取得本机安装锁、主控确认旧尝试失败后，自动归档 `started` 并以新 attempt ID 重试，不再要求输入 `RETRY` 或手工删除标记。已完成的节点跳过重复安装；锁被占用、主控未确认、回执过期或本地标记冲突时，保留状态并报错退出，不强制重装。重试使用原配置和服务名，可能重新执行已完成部分的 Nyanpass 安装，但不会创建另一组实例；Nyanpass 安装继续由机器级任务锁串行保护。每次调用最多开始一次新尝试，不在失败后无限循环。旧版已下载的启动脚本不会自动变化，需从更新后的面板重新取得命令。

重新执行对接命令时，安装器会尝试用本次下载凭据刷新已有缓存中的固定安装器和 Nyanpass 可信清单；只接受节点、代次、主控地址和探针令牌一致的有效配置。网络不可用时保留原缓存继续恢复，返回无效或身份不符的配置则报错退出，不覆盖旧缓存。已完成的节点优先检查本机完成标记和服务文件，补发完成回执并恢复 DDNS，不再访问配置下载链接。

### AWS Spot 换机与换 IP

每份启动器只绑定一个 `nodeId + token`，对应一个域名和同一时间运行的**一台**机器。把开机脚本写入该机器的 AWS 启动模板（Launch Template）User data 后：

- **Spot 实例被回收、换成新实例**：新实例首次开机执行同一份 User data，下载节点配置，主控识别为“新机器（实例替换）”，以新的 attempt ID 无人值守重新安装 DDNS、全部首次预配的 Nyanpass 实例（例如 awsin 入口 + awsout 出口）、BBR 和 SSH，随后首次上报新公网 IP 并更新阿里云解析。旧实例上 Nyanpass 的服务名、令牌和参数保持不变。
- **旧实例在安装途中被回收**：主控等待旧尝试的 2 分钟安装租约超时，新实例的安装器在等待期内自动重试（最多约 3 分钟），租约过期后接管；旧实例的晚到回执会被忽略。
- **同一实例停止后再启动 / 只换 IP**：磁盘上已有完成标记，开机脚本只恢复 `ddns-monitor`，不会重装；探针每 10 秒检测，公网 IP 变化后立即上报并更新解析。

同一份 User data 不能在 ASG 中同时运行多台实例：多台机器会争用同一个域名记录，安装期间的第二台机器会被主控拒绝。需要多台机器时为每台单独创建节点。重装包含创建节点时预配的 Nyanpass 实例，以及之后通过“同步到机器”追加或修改并安装成功的实例（安装成功后写入节点的加密换机重装列表，参数与远程同步一致：服务名、入口/出口、面板地址和 Token）；在面板中移除登记的实例会从列表中删除，新机器不再安装它，但节点至少保留一个实例。同步结果为“结果未知”后才晚到的成功回执无法再取得 Token，这种实例需要重新粘贴命令并同步一次才会进入列表。

创建完成后可在节点、DNS 记录和 Nyanpass 列表中直接修改配置。节点修改会保留原探针令牌与上报状态，并在已有公网地址时立即同步新的阿里云 DNS 映射；单独新增 Nyanpass 实例时，保存后点击“同步到机器”，探针会领取固定类型任务、安装并回传状态。一个节点可以登记多个实例，探针会逐个串行安装。实例名就是传给官方安装器的机器服务名，创建后不可直接改名，避免旧服务仍在 VPS 运行却失去登记；需要换名时应新增实例，确认新服务正常后再移除旧登记。尚未领取的任务可以安全取消；机器开始安装后不能远程取消。只有探针任务心跳离线且节点没有其他安装在运行时，排队超过 5 分钟才会自动结束并允许重试；运行租约超时则标记为“结果未知”并继续接受原探针的晚到回执，绝不会自动重复安装。总览“最近变更”和完整事件日志均支持按节点、类型、级别及关键词筛选，完整日志还可折叠。

实例名不能使用 `ddns-monitor`、`pulsedns-control`、`ssh`、`sshd`、`systemd-*` 或 systemd 单元后缀。机器端还会拒绝被其他服务、非 Nyanpass 目录或符号链接占用的目标，已有 Nyanpass 服务仍可按原名修复。失败或取消后重新排队使用新的执行 ID，旧租约回执和本地状态文件不能污染新尝试；不新增实例记录或数据库表。

HTTP 面板上的“复制下载并运行命令”和“复制开机脚本”按钮都包含兼容回退，复制前会把 CRLF/CR 统一为 LF，并明确显示成功或失败。没有成功提示时不要粘贴，避免使用剪贴板中残留的其他节点旧内容；若实例没有生成 `/var/log/pulsedns-bootstrap*.log`，先查看目标终端中的下载错误，使用 User data 时再检查内容是否被外部编辑器转换为 CRLF。

开机 payload 中的 root 密码、原始探针 Token、下载 Token 和预配 Nyanpass 参数只以 AES-GCM 密文保存，下载校验使用独立 SHA-256 摘要。为了支持 Spot 换机重装，安装成功后不再清空密文和摘要；删除节点会一并删除。旧版本已安装并擦除密文的节点无法再取得安装命令，需要删除后重新创建才能使用换机重装。旧版本未加密保存下载 Token 的节点会在原记录上重新签发一次，之后保持不变。为支持稍后点击同步，单独新增实例的 Nyanpass Token 使用同一主控密钥的独立加密域保存；成功安装、任务失效或结果未知后立即清除。

**HTTP + 随机路径不是 TLS。** 下载直链本身是长期有效的 Bearer 凭据，拿到它的人随时可以下载包含 root 密码、探针令牌和 Nyanpass 令牌的节点配置；不要把它放进聊天、截图、工单、公开日志或第三方短链。AWS IMDS 在实例生命周期内会返回原始 user-data，请启用 IMDSv2 并设置 hop limit 为 1，只把面板端口放行给自己的来源 IP。怀疑泄漏时删除节点登记并重新创建，旧链接随即失效。一个节点同一时间只能运行在一台 VPS 上。

完整安装会修改 root 密码、SSH 登录策略并覆盖 `/etc/sysctl.conf`（原文件会带时间戳备份），与原脚本行为一致。卸载 DDNS 会清除 `/var/lib/ddns-monitor/tasks` 中的本地任务租约文件，但不会回滚这些系统设置，也不会卸载 Nyanpass。

## 升级 DDNS 探针

两个升级入口（`agent-upgrade` 和独立升级脚本）都会先取得开机安装锁，再等待当前 Nyanpass 任务结束，最多等待 15 分钟。锁占用或等待超时会报错退出，不替换或重启正在安装任务的探针。

使用当前 PulseDNS 安装器部署的节点可运行独立升级脚本：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/a22513d836cd8c69213825bf191bfe26527e143f/public/update.sh -o "$tmp" &&
  printf '%s  %s\n' 'edfedd95da06baf4b2879bb19cefe0b6af1a88e45374cc87f435e917684f9ee7' "$tmp" | sha256sum -c - &&
  bash "$tmp"
)
```

升级器支持 HTTPS 地址，以及带端口和 32 位随机路径的 HTTP 主控地址。它先补齐 `curl`、`jq`、`coreutils` 与 `util-linux`，再从固定 Git 提交的 GitHub HTTPS 地址下载专用 `monitor.sh` 并校验代码内固定的 SHA-256；不会从 HTTP 主控执行 root 脚本，也不会下载或执行完整安装器。它只替换 DDNS 探针，不接受新的主控地址或令牌，也不改 systemd 单元、配置、SSH、BBR 或 Nyanpass。配置、IP 缓存和日志不会被清空；运行中的服务会重启并继续正常检测，若公网 IP 此时已经变化，仍会按原逻辑上报并更新 DNS。停止的服务保持停止。新版启动失败时会恢复旧探针，并在 `/opt/ddns-monitor/monitor.sh.previous` 保留上一版本。

v0.7.x 及更早的探针不会轮询任务，第一次使用远程同步前必须升级一次。Nyanpass 页面会按节点版本显示“先升级探针”，并生成保留现有 `/etc/ddns-monitor.conf` 的一次性升级命令。v0.8.0 之后，探针每轮独立检查任务；官方安装器最长运行 10 分钟，超时后再给 30 秒强制终止进程组，但在后台锁中串行执行，不会暂停原来的 IP 检测。

## Nyanpass 入口与出口

Web 中添加实例时粘贴 Nyanpass 面板生成的原始命令。程序从 `rel_nodeclient` 参数中只用独立的 `-o` 判断方向：

- 参数中存在独立的 `-o`：出口。
- 参数中不存在 `-o`：入口。

不会根据 Token、面板 URL、IP 或端口猜测。创建探针时可一次添加多个面板/实例，命令中不含 Shell 元字符的其他官方参数（例如 `--ws-port 1145`）会原样用于首次安装。探针运行后再追加实例时，主控只下发 `serviceName`、入口/出口、HTTPS 面板地址和 Token 这些必要结构化字段（`OPTIMIZE` 固定为 0）；其他参数有无均不影响进出口登记。探针固定校验 Nyanpass 官方安装器及 amd64、amd64v3、arm64 对应二进制包的 SHA-256，再通过官方 `NO_DOWNLOAD=1` 路径安装，不执行上游未校验的二级下载脚本，也不接受任意命令或脚本地址。`OPTIMIZE=0` 会保持为空传给官方脚本，不再误触发优化；再次同步同名实例时会原子刷新 `start.sh` 中的已校验参数。

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

本地开发与测试需要一个 MySQL 8 / MariaDB（测试默认连接本机 13306 端口，可用 `PULSEDNS_TEST_MYSQL_URL` 指定）：

```bash
docker run -d --name pulsedns-mysql-test -e MYSQL_ROOT_PASSWORD=testroot -p 127.0.0.1:13306:3306 mysql:8.4
```

```bash
pnpm install && pnpm test && pnpm lint && pnpm build
```

每个测试文件都会创建独立的临时数据库，结束后自动删除。修改 `db/schema.ts` 后用 `pnpm db:generate` 生成迁移文件。
