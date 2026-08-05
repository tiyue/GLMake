# GLMake 部署文档（简体中文）

- 版本：1.0
- 目标：使维护者能从一台**全新阿里云服务器**独立完成安装、配置、启动、公网 HTTP
  访问、升级、备份和故障排查。不依赖私有脚本或额外托管服务。

## 1. 前置条件与风险确认

- 服务器：阿里云 ECS（首套验证环境 Alibaba Cloud Linux 2.1903 LTS 64 位；其他
  Linux 同等适用），建议 ≥2 vCPU / 2 GiB 内存 / 40 GiB 系统盘。
- 运行时：Node.js ≥ 22.5（内置 `node:sqlite`）。**运行期零第三方依赖，无需 npm。**
- 部署前必读 `docs/privacy.md`：默认公网 HTTP、静态数据与导出包不加密；只存放可接受
  泄露的非重要文件；使用 GLMake 专用独立密码。

## 2. 全新服务器安装

```bash
# 1) 安装 Node.js 22+（以系统包管理器或官方二进制为准，示例为二进制解压）
cd /opt && curl -fsSLO https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz
tar -xf node-v24.16.0-linux-x64.tar.xz && ln -s /opt/node-v24.16.0-linux-x64/bin/node /usr/local/bin/node

# 2) 获取源码（公开仓库）
git clone https://github.com/<账号>/GLMake.git /opt/glmake && cd /opt/glmake

# 3) 准备数据目录（与代码分离）
mkdir -p /var/lib/glmake && chmod 700 /var/lib/glmake

# 4) 启动（首次访问页面时建立所有者账户并展示一次性恢复码，请立即抄存）
GLMAKE_DATA=/var/lib/glmake PORT=80 nohup node server/app.mjs > /var/log/glmake.log 2>&1 &
```

- 端口 80 需 root 或 `setcap`；也可用 8787 等非特权端口。
- 进程管理：可用 systemd unit（示例见 §6）。无需数据库服务、对象存储或消息队列。

## 3. 首次使用

1. 浏览器访问 `http://<公网IP>:<端口>/`，输入用户名与≥8 位密码完成初始化。
2. 抄存页面展示的一次性恢复码（仅展示一次）。
3. 开始写作；Ctrl+S 手动同步；系统菜单可开启每 10 分钟条件自动同步。

## 4. 容量与水位（写入前强制检查）

| 项 | 上限（十进制） |
| --- | --- |
| 单篇正文 | 10,000,000 B |
| 活动正文合计 | 5,000,000,000 B |
| 单附件 | 50,000,000 B |
| 附件物理总量 | 500,000,000 B |
| 历史版本 | 每篇 ≤10 个且 ≤30 天；全实例 ≤5,000,000,000 B |
| 受管数据物理总量 | 12,000,000,000 B |
| 磁盘保留空间 | 始终 ≥8,000,000,000 B 可用，不足时落盘前拒绝 |

## 5. 备份与迁移

- 系统菜单"全量导出"生成未加密 `.glmake.zip`（ZIP64，含清单/正文/附件/回收站/版本），
  支持 Range 续传下载；导出前界面提示预计大小与风险。
- 所有者必须把导出包下载并保存到**服务器之外**；两次导出之间的数据没有自动恢复点。
- 迁移到新服务器：新装同版本 → 初始化新所有者 → `POST /api/import` 上传导出包；导入前
  全量校验（路径穿越/哈希/数量/容量），失败零副作用；旧分享链接与旧会话不迁移。

## 6. 升级与回滚

```ini
# /etc/systemd/system/glmake.service
[Unit]
Description=GLMake
After=network.target
[Service]
Environment=GLMAKE_DATA=/var/lib/glmake PORT=8787
ExecStart=/usr/local/bin/node /opt/glmake/server/app.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

- 升级：`git fetch && git checkout <tag>` → `systemctl restart glmake`。schema 只增不删列，
  数据目录跨版本兼容。
- 回滚：`git checkout <旧 tag>` → restart；同数据目录可直接读回。
- 升级前建议先做一次全量导出。

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 507 磁盘/水位拒绝 | 清理回收站/旧版本/附件，或下载导出包后永久删除 |
| 401 会话失效 | 重新登录；密码与恢复码同时丢失时不承诺找回 |
| 启动报 SQLite 错误 | 确认 Node ≥22.5 且数据目录不在网络文件系统上 |
| 日志位置 | `/var/log/glmake.log`（或 journalctl -u glmake）；日志不含正文与凭据 |

## 8. 兼容矩阵（当前证据状态）

| 浏览器 | 状态 | 证据 |
| --- | --- | --- |
| Chromium 系（内嵌 148 / Edge 151 headless） | 已验证（观察级） | 阶段 2 试验与 M1–M3 冒烟 |
| Chrome / Edge 最近两个稳定版（有界面） | 待服务器轮复测 | — |
| Firefox | 未验证（本机未安装） | 外部阻塞 |
| Safari / iOS Safari | 未验证（需 macOS/真机） | 外部阻塞 |
| Android Chrome | 未验证 | 外部阻塞 |

正式发布前必须在目标环境补齐上表"待复测/未验证"项（立项 §3.16 红线）。
