# GLMake 技术设计（M1 垂直切片）

- 文档编号：GLMAKE-DESIGN-001
- 版本：0.1
- 状态：开发中（授权见立项 §3.16）
- 依据：`docs/project-charter.md`（需求/边界/验收）、`docs/tech-trials-prep.md`（试验证据）
- 修改范围：`server/`、`tests/`、`docs/`；**不得修改** `experiments/` 下既有试验脚本与证据。

## 1. 架构

单体 Node.js 进程（≥22.5），**零第三方运行时依赖**（内置 `node:sqlite`、`node:http`、
`node:crypto`），保证全新阿里云服务器无需 npm 即可复现部署。模块按职责分文件：

| 模块 | 职责 |
| --- | --- |
| `server/app.mjs` | HTTP 路由、会话 Cookie、限速、安全响应头、静态资源 |
| `server/zip64.mjs` | ZIP64 流式读写（自试验轮转正，Apache-2.0 自有代码） |
| `server/static/` | 单页前端（原生 JS，无构建步骤） |

数据布局（`GLMAKE_DATA` 目录，默认 `./data`）：`glmake.db`（WAL）、`objects/<2>/<sha256>`
（不可变附件）、`tmp/`（上传与导出暂存）、`config.json`（所有者凭据，0600，不进仓库）。

## 2. 数据模型（SQLite，试验轮 schema 转正）

documents(doc_id PK, notebook_id FK, title, body, revision, updated_ms, deleted_ms)、
notebooks、tags、doc_tags、versions(doc_id, revision, body, created_ms)、
idempotency(request_id PK)、conflicts、attachments(hash PK, size, mime, orig_name, refcount)、
sessions(token_hash PK, expires_ms, revoked_ms)、recovery(code_hash PK, used_ms)、
shares(token_hash PK, doc_id, revoked_ms)、changes(seq INTEGER PK AUTOINCREMENT, doc_id, kind, ms)。

- `changes` 提供全局单调 `change_seq`，客户端按检查点增量拉取。
- FTS5 trigram 虚拟表 `docs_fts`（可整体重建；<3 字符查询前端提示最少 3 字符）。

## 3. 同步协议（立项 §3.8.3 落地）

- 写入必须携带 `base_revision` 与 `Idempotency-Key`；相等才生成下一修订，否则 409 冲突并
  保留双方（conflicts 表）。相同幂等键重复请求只产生一次业务变化。
- 创建/更新/删除/恢复/永久删除/移动笔记本/标签变化均写 `changes`。
- 删除=tombstone（deleted_ms），30 天可恢复；永久删除清活动数据与之后导出包可见性。

## 4. 容量与水位（立项 §3.9/§3.10/§3.11.4，落盘前拒绝）

单篇正文 ≤ 10,000,000 B；活动正文合计 ≤ 5,000,000,000 B；单附件 ≤ 50,000,000 B；
附件物理总量 ≤ 500,000,000 B；历史版本每篇 ≤10 且 ≤30 天、全实例 ≤5 GB；
受管数据物理总量 ≤ 12 GB；始终保留 ≥ 8 GB 可用空间（启动与写入前检查 `statfs` 等效：
Node 无内置 statfs，用 `fs.statfsSync`（Node 18.15+ 提供））。任一入口不得绕过。

## 5. 账户与安全（立项 §3.8.5）

- 首启 `POST /api/setup` 建立唯一所有者；密码用 scrypt（本轮实现，参数 64MB/8/1 实测记录；
  服务器轮切换 Argon2id 的接口预留为 `hashAlgo` 字段）。恢复码一次性，用后全部会话失效。
- 会话 30 天；`HttpOnly` Cookie；`/api/logout-all` 立即撤销全部。
- 登录/恢复接口限速：每 IP 每分钟 5 次（内存计数）。
- 附件下载强制 `X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`；
  仅安全图片清单（png/jpeg/gif/webp 且魔数校验）可 `?inline=1`。
- 分享页与响应带 `X-Robots-Tag: noindex` 与 meta noindex。

## 6. 导出/导入（立项 §3.8.4/§3.10.9）

`.glmake.zip` 单 ZIP64：manifest.json（format_version、app_version、exported_at、
documents/attachments 清单含 sha256/size）+ documents/*.md + attachments/<hash>。
不含凭据/会话/分享令牌；导入前全量校验（路径穿越、哈希、数量、容量），失败零副作用。
导出异步生成到 tmp，`GET` 支持 `Range` 续传；暂存包 24 h 过期清理、下载后清理。

## 7. 前端（M1）

单页：登录/设置入口、文档管理（列表/搜索/回收站）、编辑页（textarea 先行，虚拟化编辑器
为 M2 里程碑，见试验结论）、实时预览（M1 提供基础渲染：标题/段落/代码/列表/引用/表格，
完整方言 M2）。CSS 变量 token；light/dark/跟随系统；桌面双栏（深色编辑/浅色预览），
窄屏单栏。语义化 HTML；弹出菜单点击外部/Escape 收起。

## 8. 里程碑

- **M1（本轮）**：所有者账户、登录/会话、文档 CRUD+冲突+幂等、笔记本/标签、回收站、
  附件上传/下载/去重/安全头、搜索、分享只读链接、全量导出/导入、基础前端与主题。
- M2：虚拟化编辑器、完整 Markdown 方言与预览、快捷键、设置项、自动同步与四路径冲突 UI。
- M3：版本历史 UI、PDF 导出、图片粘贴完善、移动端细节。
- M4：服务器轮门禁、兼容矩阵、部署文档、发布。

## 9. 测试策略

`tests/server.test.mjs`（node:test + fetch）：覆盖认证、冲突、幂等、容量拒绝、附件去重与
安全头、回收站、分享撤销、导出/导入往返与路径穿越拒绝。每里程碑先跑试验轮脚本再跑本套件。

## 10. 回滚与升级

数据目录与代码分离；升级=替换代码+`PRAGMA user_version` 迁移；回滚=旧代码读同目录
（schema 只增不删列）。导出包即人工备份介质。
