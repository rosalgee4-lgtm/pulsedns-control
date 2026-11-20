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
| 原 23 项 BBR/sysctl 配置 | 完整安装和 Web 开机安装固定执行；添加节点时用下拉框选择 c6in（10MB 缓冲，默认）、c5in（50MB 缓冲）或「使用 nyp 的 BBR 优化」，选择写入生成的安装命令，安装时无人值守执行；菜单模式使用 c6in。执行前仍备份 `/etc/sysctl.conf`；选 nyp 时面板不改 `/etc/sysctl.conf`，改为以 `OPTIMIZE=1` 调用 Nyanpass 官方安装器，由它写入 `/etc/sysctl.d/ny.conf`（不含面板配置里的 ip_forward、forwarding、route_localnet） |
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
- **多用户模式**：在「设置 → 管理员设置」中开关，默认关闭。关闭时只允许管理员登录，已登录的普通用户会立即被退出（他们的节点照常运行、照常同步解析）。开启后，普通用户只能看到和管理自己的节点、Nyanpass 实例、主域名和阿里云账号；管理员可以看到全部。普通用户由管理员在「设置」中创建，不开放注册；管理员可以在用户列表点「改名」修改任何人的用户名（包括管理员自己），已登录的会话不受影响，之后用新用户名登录；还有节点、主域名、阿里云账号、Nyanpass 实例或共享机器上的解析的用户不能删除。
- **机器分享**：管理员在「探针节点」列表点某台机器的「分享」，把它分享给一个或多个普通用户（例如把 aws-sg 分享给 tenant）。被分享的用户：
  - 能看到这台机器的状态和 IP，能只读查看这台机器上所有人的 Nyanpass 实例和解析，以及这台机器的全部事件；
  - 能在「探针节点」或「添加Nyanpass实例」页（两处都按机器分组，一台机器下列出它的多个实例）点这台机器的「添加实例」，添加、修改、同步、移除**自己的**实例；
  - 可以不添加自己的域名，直接使用这台机器现有的解析（页面会显示，例如 `sg.example.com`，换机后自动更新）；
  - 能在「DNS 记录」页的「共享机器上的解析」中，用**自己的**主域名和阿里云账号添加多组解析指向这台机器，添加后立即同步一次；
  - 看不到 root 密码、安装命令和开机脚本，也不能修改或删除机器。

  每个人只能修改自己添加的实例和解析，管理员可以修改全部。Spot 换机后，被分享用户的解析会随探针上报自动改到新 IP，他们同步成功过的实例也会随开机脚本一起重装。管理员分享时还可以用自己的主域名给对方「分配解析」（例如自己用 jp1.a.com，分给对方 jp2.b.com），也可以之后在分享弹窗里给已分享的用户分配；分配的解析和机器自己的记录一样跟随探针上报自动同步，对方能看到但不能修改或删除，管理员可以随时移除（移除只停止同步）。取消分享会一并移除该用户在这台机器上的实例登记和全部解析（包括管理员分配的和对方自己添加的）：实例不再随换机重装；解析停止同步，并在阿里云上把这些记录设为「暂停」（不删除）。暂停失败时仍会取消分享，弹窗和事件记录会列出需要到阿里云控制台手动暂停的记录。之后重新分配同一条解析时会自动恢复解析。当前机器上已安装的服务不会被卸载。实例正在等待或执行同步时不能取消分享。
- **防爆破**：15 分钟内同一来源 IP + 用户名失败 5 次，或同一来源 IP 失败 20 次（不论用户名），对应来源锁定 15 分钟，锁定期间密码正确也会被拒绝。用户名不存在时也执行同等耗时的校验，避免按耗时探测用户名。
- **跨站请求防护**：所有修改类接口（包括登录）只接受面板自己页面发出的请求（`Sec-Fetch-Site: same-origin`；旧浏览器比对 `Origin` 与 `Host`）。页面禁止被其他网站嵌入（`X-Frame-Options: DENY`、`frame-ancestors 'none'`）。
- **HTTPS**：面板容器只提供 HTTP，并且只绑定本机 `127.0.0.1`，由宝塔反向代理对外提供 HTTPS。未经 HTTPS 的登录会被拒绝。
- **加密存储**：阿里云 AccessKey、root 密码、开机配置和 Nyanpass Token 都用 `PULSEDNS_TASK_ENCRYPTION_KEY` 加密后存入数据库。这个密钥一旦使用就不能更换或丢失，请和数据库备份分开保管。

## 部署 Web 主控面板（Docker + 外置数据库 + 宝塔 HTTPS）

面板以 Docker 容器运行，数据保存在你自己的 MySQL 8.0+ 或 MariaDB 10.6+（已在 MySQL 8.4、MariaDB 10.11 与 11.4 上测试），启动时自动建表和升级表结构。容器只在本机 `127.0.0.1:3100` 提供 HTTP，对外的 HTTPS 由宝塔反向代理负责。

整体结构：

```text
浏览器 / 探针 ──HTTPS──> 宝塔 Nginx（证书、强制 HTTPS）──HTTP──> 127.0.0.1:3100 PulseDNS 容器 ──> MySQL / MariaDB
```

### 0. 准备

- 一台装好宝塔面板的 Linux 服务器（x86_64 或 arm64），至少 2 GB 内存（构建镜像时需要）。
- 一个解析到这台服务器的域名，例如 `panel.example.com`。
- Docker 与 Docker Compose：在宝塔「软件商店」安装「Docker 管理器」，或用 Docker 官方安装脚本。执行 `docker compose version` 能看到版本号即可。
- `git` 与 `openssl`（宝塔服务器一般已自带）。
- 安全组 / 防火墙只需放行 80 和 443；**不要**放行 3100 和 3306。

### 1. 创建数据库

**数据库和面板在同一台服务器**（例如宝塔安装的 MySQL）：容器通过 `host.docker.internal` 访问宿主机，数据库用户需要允许 Docker 网段登录。在宝塔「数据库」→「root 密码」旁的「管理」(phpMyAdmin) 或命令行执行：

```sql
CREATE DATABASE pulsedns CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pulsedns'@'172.%' IDENTIFIED BY '请替换为强密码';
GRANT ALL PRIVILEGES ON pulsedns.* TO 'pulsedns'@'172.%';
```

`172.%` 只覆盖 Docker 默认网段，外网仍然连不上；3306 端口不要在防火墙放行。宝塔安装的 MySQL 默认监听所有网卡，容器可以直接连上。如果你改过 `bind-address=127.0.0.1`，需要改回 `0.0.0.0` 并重启 MySQL。

**数据库在另一台服务器或云数据库**：把上面的 `172.%` 换成面板服务器的 IP，并只对这个 IP 放行 3306，尽量走内网。

### 2. 获取固定版本的源码

```bash
git clone https://github.com/rosalgee4-lgtm/pulsedns-control.git
```

```bash
git -C pulsedns-control checkout --detach 4326d80bf2a1b2804004cd375b9d317d8dcf51b7
```

镜像按这个固定 commit 的源码在本机构建，基础镜像按摘要固定，依赖按 `pnpm-lock.yaml` 锁定，不会拉取其他版本的代码。

### 3. 填写配置

```bash
cd pulsedns-control && cp .env.example .env && chmod 600 .env
```

先生成两个随机值，复制备用：

```bash
printf 'PULSEDNS_BASE_PATH=/%s\nPULSEDNS_TASK_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)"
```

然后编辑 `.env`（可以用宝塔「文件」打开），逐项填写：

| 变量 | 填什么 |
| --- | --- |
| `PULSEDNS_DATABASE_URL` | 同一台服务器：`mysql://pulsedns:数据库密码@host.docker.internal:3306/pulsedns`；另一台服务器把 `host.docker.internal` 换成它的 IP。密码里有 `@ : / ? #` 等字符时要做 URL 编码 |
| `PULSEDNS_PUBLIC_URL` | `https://panel.example.com`，不要带随机路径。安装命令和开机脚本都用这个地址 |
| `PULSEDNS_BASE_PATH` | 上一步生成的 `/` + 32 位十六进制 |
| `PULSEDNS_TASK_ENCRYPTION_KEY` | 上一步生成的 64 位十六进制。**一旦使用就不能更换或丢失**，请另外抄一份保存 |
| `PULSEDNS_INITIAL_ADMIN_USER` | 管理员用户名，默认 `admin` |
| `PULSEDNS_INITIAL_ADMIN_PASSWORD` | 管理员初始密码，12-128 位 |
| `PULSEDNS_PANEL_PORT` | 面板在本机监听的端口，默认 `3100`，只绑定 `127.0.0.1` |

### 4. 构建并启动

```bash
docker compose up -d --build
```

第一次构建需要下载依赖，通常几分钟。之后查看日志，出现 `Production server running` 就是启动成功：

```bash
docker compose logs --tail 30 pulsedns
```

容器以非 root 用户、只读根文件系统运行，并去掉了全部 Linux capabilities。数据库表在第一次有人访问面板时自动创建，同时用 `.env` 里的账号创建管理员（数据库只保存密码哈希）。

### 5. 在宝塔中配置 HTTPS 反向代理

1. 「网站」→「添加站点」，域名填 `panel.example.com`，PHP 版本选「纯静态」。
2. 站点设置 →「SSL」→「Let's Encrypt」申请证书，开启「强制 HTTPS」。
3. 站点设置 →「反向代理」→「添加反向代理」：目标 URL 填 `http://127.0.0.1:3100`，发送域名填 `$host`。
4. 点反向代理的「配置文件」，确认 `location` 里有下面四行，缺少就补上，然后保存：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

宝塔默认的配置通常缺少 `X-Forwarded-Proto`。缺少这一行时面板会认为访问不是 HTTPS，并拒绝登录。防爆破以 `X-Forwarded-For` 最后一跳（由宝塔追加）识别来源 IP，客户端无法伪造。

### 5.1 （可选）套 Cloudflare 零信任

可以在面板前面再加一层 Cloudflare Zero Trust（Access）登录，但要对探针接口放行，否则节点装不上、也无法上报。安装脚本本身从 GitHub 下载，不经过面板；节点只回连面板的 `/<随机入口路径>/api/v1/` 下 `bootstrap`、`provision`、`tasks`、`report` 四个接口。

1. 域名在 Cloudflare 开启代理（橙色云朵），「SSL/TLS」模式选 **Full (strict)**。不要用 Flexible：它用 HTTP 回源，面板会认为访问不是 HTTPS 并拒绝登录。
2. Zero Trust →「Access」→「Applications」→ 添加两个 Self-hosted 应用：

| 应用 | 域名 | 路径 | 策略 |
| --- | --- | --- | --- |
| 面板 | `panel.example.com` | 留空 | Allow，按你的登录方式填写，例如指定邮箱 |
| 探针接口 | `panel.example.com` | `<随机入口路径>/api/v1`，例如 `0123456789abcdef0123456789abcdef/api/v1` | Action 选 **Bypass**，Include 选 **Everyone** |

   路径更具体的应用优先生效，所以这段路径（含子路径）直接放行，其余页面仍需先通过零信任。放行是安全的：这些接口本身就要求节点令牌，没有令牌会被拒绝。

3. 在宝塔站点「配置文件」的 `server` 中还原访客真实 IP。否则面板看到的来源都是 Cloudflare 节点，防爆破会把很多访客算成同一来源，可能一起被锁定 15 分钟。`set_real_ip_from` 要写上 <https://www.cloudflare.com/ips/> 公布的全部 IPv4、IPv6 段，下面只列出前两段作示例：

```nginx
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
real_ip_header CF-Connecting-IP;
```

   第 5 步的四行 `proxy_set_header` 不需要改。Cloudflare 的 IP 段偶尔会更新，届时同步修改。

4. 验证：用无痕窗口打开面板，应先跳转到 Cloudflare 登录页；在任意节点执行下面的命令，返回 `401`（面板提示「无效的探针凭据」）说明放行生效，若返回 Cloudflare 登录页的 HTML 则说明 Bypass 没有生效。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://panel.example.com/<随机入口路径>/api/v1/report
```

如果改用 Cloudflare Tunnel（cloudflared）代替宝塔反代，Access 的两个应用照样配置；真实 IP 的还原方式不同，不适用第 3 步。

### 6. 首次登录

打开 `https://panel.example.com/<随机入口路径>/`，例如 `https://panel.example.com/0123456789abcdef0123456789abcdef/`。直接访问域名根路径会返回 404，这是正常的。

用 `.env` 里的管理员账号登录后：

1. 「设置」→「修改密码」改成新密码。之后可以把 `.env` 里的 `PULSEDNS_INITIAL_ADMIN_USER` / `PULSEDNS_INITIAL_ADMIN_PASSWORD` 两行删掉，它们只在数据库里没有任何账号时使用。
2. 「阿里云主域名」→ 添加阿里云账号（建议用下文「RAM 子账号需要的权限」中的最小权限），再添加主域名。
3. 「节点」→「添加节点」，把生成的开机脚本写入 AWS 启动模板。
4. 需要合租时，在「设置 → 管理员设置」打开多用户模式并添加用户。

### 7. 升级

把 `NEW_COMMIT` 设为最新 README 第 2 步中的 commit，然后执行：

```bash
git -C pulsedns-control fetch origin
```

```bash
git -C pulsedns-control checkout --detach "$NEW_COMMIT"
```

```bash
cd pulsedns-control && docker compose up -d --build
```

升级会自动迁移数据库表结构；`.env`、数据库数据和已写入 AWS 的开机脚本都不受影响。

### 8. 备份

需要备份两样东西，并且分开保管：

- **数据库**：例如每天在宝塔「计划任务」里备份 `pulsedns` 库，或执行 `mysqldump --single-transaction pulsedns > pulsedns.sql`。
- **`.env` 里的 `PULSEDNS_TASK_ENCRYPTION_KEY`**：没有它，数据库里的阿里云 Key、root 密码和开机配置都无法解密。

### 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 登录提示「请通过 HTTPS 访问面板后再登录」 | 宝塔反代缺少 `proxy_set_header X-Forwarded-Proto $scheme;`，按第 5 步补上 |
| 日志里 `ECONNREFUSED` 或 `Access denied for user` | 数据库地址或用户来源不对：同一台服务器要用 `host.docker.internal`，并确认用户是 `'pulsedns'@'172.%'` |
| 日志里提示缺少 `PULSEDNS_TASK_ENCRYPTION_KEY` 或管理员 | `.env` 没填全，补上后执行 `docker compose up -d` |
| 打开域名显示 404 | 需要带上随机入口路径访问；路径必须与构建时 `.env` 中的 `PULSEDNS_BASE_PATH` 一致，修改路径后要重新 `docker compose up -d --build` |
| 套 Cloudflare 后提示「请通过 HTTPS 访问面板后再登录」 | Cloudflare「SSL/TLS」模式是 Flexible，改成 Full (strict) |
| 套零信任后节点一直等待安装或不上报 | 探针接口没有放行，按第 5.1 步为 `<随机入口路径>/api/v1` 添加 Bypass 应用 |
| 登录提示「登录失败次数过多」 | 防爆破锁定，等 15 分钟；或在数据库执行 `DELETE FROM login_attempts;` 立即解除 |
| 忘记管理员密码 | 见下方命令 |

忘记管理员密码时，先在面板目录生成新密码的哈希（把 `新的强密码` 换成你的密码）：

```bash
docker compose exec pulsedns node -e 'const c=require("node:crypto");const s=c.randomBytes(16);const k=c.scryptSync(process.argv[1].normalize("NFKC"),s,64,{N:16384,r:8,p:1,maxmem:67108864});console.log(`scrypt$16384$8$1$${s.toString("base64url")}$${k.toString("base64url")}`)' '新的强密码'
```

再在数据库执行（把输出的整行哈希填进去），并让已登录的会话全部失效：

```sql
UPDATE users SET password_hash = '上一步输出的哈希' WHERE role = 'admin';
DELETE FROM sessions;
```

### Nyanpass 可信发布清单

无人值守预配使用的 Nyanpass 安装器与三种架构二进制必须通过 SHA-256 校验，可信清单由主控注入。默认值对应当前官方发布；上游正常轮换后，可在 `.env` 设置 `PULSEDNS_NYANPASS_INSTALLER_URL`、`PULSEDNS_NYANPASS_INSTALLER_SHA256`、`PULSEDNS_NYANPASS_BINARY_BASE_URL`、`PULSEDNS_NYANPASS_BINARY_RELEASE`、`PULSEDNS_NYANPASS_BINARY_AMD64_SHA256`、`PULSEDNS_NYANPASS_BINARY_AMD64V3_SHA256`、`PULSEDNS_NYANPASS_BINARY_ARM64_SHA256`，然后执行 `docker compose up -d`。主控只接受 `https://dl.nyafw.com/download/` 官方路径、UUIDv4 发布 ID 和小写 64 位摘要；配置错误时会停止生成新节点配置，而不是绕过校验。

## 探针安装与菜单


在 Web 控制台创建节点后，页面提供两种安装方式；关闭窗口或刷新页面后，可以在节点列表点击“安装命令”再次复制，无需删除重建节点：

1. **开机脚本 · User data**：默认选中，复制完整 POSIX `/bin/sh` 启动脚本到云服务器的 User data。
2. **下载并运行 · 一键命令**：复制一整行到目标 VPS 的 root Bash，用 `wget` 把固定版本公共脚本下载到 `/root/<节点名>_<BBR 配置>_install.sh`（节点名中字母、数字、`-_.` 以外的字符替换为 `_`），校验 SHA-256 通过后才 `chmod +x` 并运行 `probe 节点参数`；校验失败不会执行。脚本文件保留在 `/root`，之后可以手动再运行一次。目标机需要 `wget` 与 `sha256sum`。

界面生成的命令包含真实节点参数和当前发布摘要；下面只演示结构，不要直接执行占位符：

```bash
wget -O '/root/aws-jp_c6in_install.sh' 'https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/eaa159a33c3db024a089f2de7516e3942a6e6923/public/install.sh' && echo '70058095eef10874e180d1b4c768ad2681d1970d120c6171ed02a0d8c94e7291  /root/aws-jp_c6in_install.sh' | sha256sum -c - && chmod +x '/root/aws-jp_c6in_install.sh' && bash '/root/aws-jp_c6in_install.sh' probe '<节点参数>' 'c6in'
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
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/eaa159a33c3db024a089f2de7516e3942a6e6923/public/install.sh -o "$tmp" &&
  printf '%s  %s\n' '70058095eef10874e180d1b4c768ad2681d1970d120c6171ed02a0d8c94e7291' "$tmp" | sha256sum -c - &&
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

Web 中“添加探针节点”会先要求填写一次性 root 密码，选择 BBR 优化（c6in、c5in 或 nyp），并预配一个或多个 Nyanpass 服务名和官方命令。实例上的 `OPTIMIZE` 选项已移除：选 c6in/c5in 时一律以 `OPTIMIZE=0` 调用官方安装器；选 nyp 时开机安装（含 Spot 换机重装）以 `OPTIMIZE=1` 安装全部实例，之后单个实例的同步仍传 `OPTIMIZE=0`。主控把 root 密码、节点原始令牌、下载凭据和规范化后的预配参数绑定 `nodeId + generation`，以 AES-GCM 加密暂存；页面并列提供开机脚本和下载后运行的一键命令。节点访问短时参数时，主控才解密并返回当前可信清单组成的有界配置数据。固定安装器执行：补齐基础环境 → 主控令牌预校验 → DDNS 安装与首次上报验收 → 全部 Nyanpass → BBR → 最后事务式配置 SSH → DDNS 复检。每完成一步都会把 `ddns`、`nyanpass`、`bbr` 或 `ssh` 随心跳和最终回执上报；面板在失败或结果未知时显示最后完成阶段，若 SSH 已完成则明确提示使用新密码核查。

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

开机 payload 中的 root 密码、原始探针 Token、下载 Token 和预配 Nyanpass 参数只以 AES-GCM 密文保存，下载校验使用独立 SHA-256 摘要。为了支持 Spot 换机重装，安装成功后不再清空密文和摘要；删除节点会一并删除。旧版本已安装并擦除密文的节点，点「安装命令」会先打开「补存安装命令」：填入机器上 `/etc/ddns-monitor.conf` 里的 `TOKEN=`、新的 root 密码、BBR 配置，以及各实例的 Nyanpass 官方对接命令（面板仍保存同步凭据的实例可以留空；留空的实例不会加入换机重装，至少需要一个）。面板校验令牌属于这个节点后补存一次，机器上的探针沿用原令牌，不用重装；之后安装命令和开机脚本与新节点一样长期固定。旧的一次性链接已经失效，若 AWS 启动模板里填过旧开机脚本，需要换成补存后的这一份。旧版本未加密保存下载 Token 的节点会在原记录上重新签发一次，之后保持不变。为支持稍后点击同步，单独新增实例的 Nyanpass Token 使用同一主控密钥的独立加密域保存；成功安装、任务失效或结果未知后立即清除。

**HTTP + 随机路径不是 TLS。** 下载直链本身是长期有效的 Bearer 凭据，拿到它的人随时可以下载包含 root 密码、探针令牌和 Nyanpass 令牌的节点配置；不要把它放进聊天、截图、工单、公开日志或第三方短链。AWS IMDS 在实例生命周期内会返回原始 user-data，请启用 IMDSv2 并设置 hop limit 为 1，只把面板端口放行给自己的来源 IP。怀疑泄漏时删除节点登记并重新创建，旧链接随即失效。一个节点同一时间只能运行在一台 VPS 上。

完整安装会修改 root 密码、SSH 登录策略并覆盖 `/etc/sysctl.conf`（原文件会带时间戳备份），与原脚本行为一致。卸载 DDNS 会清除 `/var/lib/ddns-monitor/tasks` 中的本地任务租约文件，但不会回滚这些系统设置，也不会卸载 Nyanpass。

## 升级 DDNS 探针

### 在面板上直接升级（探针 v0.9.0 起）

在「探针节点」点机器的「升级命令」：如果机器上的探针是 v0.9.0 或更新版本并且在线，弹窗里会有「直接升级到 vX」按钮，点一下即可，不用登录机器。

- 面板只下发一个固定的「升级探针」任务，内容只有本仓库固定 commit 的公共安装器地址和它的 SHA-256；探针只接受 `raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/<40 位 commit>/public/install.sh`，下载后校验摘要、文件头和语法，任何一项不通过都会拒绝并回报面板。
- 校验通过后，探针在独立的 systemd 临时单元（`pulsedns-agent-upgrade-*`）里执行 `install.sh agent-upgrade`，所以重启 `ddns-monitor` 不会打断升级。和手动升级一样，它会等正在进行的 Nyanpass 任务结束，保留节点令牌与 DDNS 配置，不重新安装 Nyanpass。升级期间面板不会下发新的 Nyanpass 任务。
- 探针以新版本重新上线即视为完成，事件记录里会出现「探针升级成功」。5 分钟内没有被领取，或 20 分钟内没有以新版本上线，会记为「探针升级失败」，可到机器上查看 `/var/log/ddns-monitor.log` 或 `journalctl -u 'pulsedns-agent-upgrade-*'`。
- v0.9.0 之前的探针不认识这个任务，需要先用下面的命令手动升级一次；之后就能在面板上直接升级。被分享的用户不能升级机器上的探针。

### 手动升级

两个升级入口（`agent-upgrade` 和独立升级脚本）都会先取得开机安装锁，再等待当前 Nyanpass 任务结束，最多等待 15 分钟。锁占用或等待超时会报错退出，不替换或重启正在安装任务的探针。

使用当前 PulseDNS 安装器部署的节点可运行独立升级脚本：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl --proto '=https' --proto-redir '=https' -fLSs https://raw.githubusercontent.com/rosalgee4-lgtm/pulsedns-control/eaa159a33c3db024a089f2de7516e3942a6e6923/public/update.sh -o "$tmp" &&
  printf '%s  %s\n' '455ac7fb86324559003799304de5b2d71a0e1dca495e22a2b667898e9aa40986' "$tmp" | sha256sum -c - &&
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
