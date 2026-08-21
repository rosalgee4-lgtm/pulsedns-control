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
| root 密码与 SSH root/password 登录配置 | 保留；菜单模式现场输入，Web 一键安装使用仅出现在一次性命令中的密码 |
| 原 23 项 BBR/sysctl 配置 | 保留为菜单动作；执行前仍备份 `/etc/sysctl.conf` |
| Nyanpass `rel_nodeclient` 安装 | 保留；创建探针时预配一个或多个实例，由同一条命令无人值守安装 |
| `--run` / `--uninstall` | 保留；卸载范围仍仅为 DDNS 服务、安装目录和 IP 缓存 |

原仓库部分文件末尾还拼接了一个不存在的 `vps3_all_in_one_install.sh`，会在已经完成安装或卸载后错误退出。这是失效代码而不是功能，合并版不再执行它。原仓库中的明文 root 密码、DDNS 密钥和 Nyanpass 令牌也不会复制到新程序，均改为运行时输入。

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

准备一台使用 systemd 的 Linux VPS，并先把面板域名的 A/AAAA 记录解析到该 VPS，放行 80 与 443 端口。由于本仓库是私有仓库，需要一个对此仓库具有 Contents 只读权限的 GitHub Token。然后以 root 执行这一条命令：

```bash
read -rsp "GitHub Token: " GH_TOKEN && echo && export GH_TOKEN && bash <(curl -fLSs -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw+json" https://api.github.com/repos/rosalgee4-lgtm/pulsedns-control/contents/public/panel-install.sh?ref=main) install; unset GH_TOKEN
```

脚本会询问面板域名、管理员账号、阿里云 AccessKey，随后自动安装经过校验的 Node.js 与 Caddy、构建 PulseDNS、创建本地 SQLite 数据库、配置管理员 Basic Auth、申请 HTTPS 证书并注册 systemd 服务。再次不带参数运行同一脚本会打开操作菜单：

1. 一键安装 Web 主控面板
2. 升级面板
3. 查看运行状态
4. 卸载面板（保留数据库）

一键升级命令：

```bash
read -rsp "GitHub Token: " GH_TOKEN && echo && export GH_TOKEN && bash <(curl -fLSs -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw+json" https://api.github.com/repos/rosalgee4-lgtm/pulsedns-control/contents/public/panel-install.sh?ref=main) update; unset GH_TOKEN
```

面板数据保存在 `/var/lib/pulsedns-control/pulsedns.db`；管理员密码和阿里云凭据保存在权限为 `0600` 的 `/etc/pulsedns-control.env`。卸载面板时数据库默认保留。

### 探针安装与菜单

在 Web 控制台创建节点后会得到一次性令牌和安装命令。直接打开操作菜单：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl -fLSs https://你的主控地址/install.sh -o "$tmp" &&
  sudo bash "$tmp"
)
```

菜单只对应原脚本已有动作：

1. 完整安装：locale → SSH → DDNS → 依赖 → 一个或多个 Nyanpass → BBR
2. 仅安装或重新配置 DDNS
3. 安装一个 Nyanpass 实例，可重复执行
4. 配置 root 密码和 SSH 登录
5. 配置 BBR/sysctl
6. 卸载 DDNS

Web 中“添加探针节点”会先要求填写一次性 root 密码，并预配一个或多个 Nyanpass 服务名、官方命令及原脚本的 `OPTIMIZE` 选项。主控把它们全部嵌入同一条完整安装命令：SSH → DDNS → 全部 Nyanpass → BBR。VPS 只需粘贴一次，执行过程中不再要求粘贴 Nyanpass 命令或确认；每个实例通过原安装器支持的 `S` 与 `OPTIMIZE` 环境变量自动安装。

root 密码、Nyanpass Token、完整官方命令和解析后的安装参数都不会写入数据库或事件日志，只存在于生成后显示一次的安装命令中。数据库只登记服务名、所属探针、面板地址及入口/出口角色。

完整安装会修改 root 密码、SSH 登录策略并覆盖 `/etc/sysctl.conf`（原文件会带时间戳备份），与原脚本行为一致。卸载 DDNS 不会回滚这些系统设置，也不会卸载 Nyanpass。

## 升级 DDNS 探针

使用当前 PulseDNS 安装器部署的节点可运行独立升级脚本：

```bash
(
  tmp="$(mktemp)" &&
  trap 'rm -f "$tmp"' EXIT &&
  curl -fLSs https://你的主控地址/update.sh -o "$tmp" &&
  sudo bash "$tmp"
)
```

DDNS 主控地址必须使用 HTTPS。升级器只从节点现有配置中的主控下载专用 `monitor.sh`，不会下载或执行完整安装器。它只替换 DDNS 探针，不接受新的主控地址或令牌，也不改 systemd 单元、配置、SSH、BBR 或 Nyanpass。配置、IP 缓存和日志不会被清空；运行中的服务会重启并继续正常检测，若公网 IP 此时已经变化，仍会按原逻辑上报并更新 DNS。停止的服务保持停止。新版启动失败时会恢复旧探针，并在 `/opt/ddns-monitor/monitor.sh.previous` 保留上一版本。

## Nyanpass 入口与出口

Web 中添加实例时粘贴 Nyanpass 面板生成的原始命令。程序只检查 `rel_nodeclient` 参数：

- 参数中存在独立的 `-o`：出口。
- 参数中不存在 `-o`：入口。

不会根据 Token、面板 URL、IP 或端口猜测。创建探针时可一次添加多个面板/实例，它们随探针命令自动安装。探针创建后单独追加实例时，生成的命令同样直接安装且不再二次确认。主控只保存实例名、所属节点、面板地址和由命令得到的入口/出口，不保存 Nyanpass Token 或完整命令。每次生成的安装命令只显示一次。

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
