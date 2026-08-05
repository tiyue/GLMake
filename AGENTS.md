# GLMake 工作区索引（AGENTS.md）

- 项目：GLMake（免费开源的类马克飞象 Markdown 写作与同步工具，Apache-2.0）
- 当前状态：阶段 2 服务器轮待补；技术设计与 M1 开发已获授权启动（立项 §3.16/§3.17）。
- 工作区目录 `马克飞象-私人版` 仅为本地路径，对外名称统一使用 GLMake。

## 权威文档索引（Spec 体系）

| 文档 | 角色 | 状态 |
| --- | --- | --- |
| `docs/project-charter.md` | 立项调研草案（权威：决策、边界、门禁、未知项） | 版本 0.43 |
| `docs/tech-trials-prep.md` | 阶段 2 技术试验准备与执行结论（GLMAKE-TRIAL-001） | 已确认，第 1–4 轮完成 |
| `docs/tech-design.md` | 技术设计（GLMAKE-DESIGN-001，M1–M4 里程碑） | 开发中 |

## 产品代码（server/、tests/）

- 启动：`GLMAKE_DATA=./data PORT=8787 node server/app.mjs`（零第三方依赖，Node ≥ 22.5）
- 测试：`node --test tests/server.test.mjs`（12 项：认证/冲突/幂等/容量/附件/回收站/搜索/分享/导出导入/会话）
- 数据目录 `data/`、`data-dev/` 永不入库（含凭据）。

## 技术试验（experiments/）

- 固定样本生成：`node experiments/tools/gen-samples.mjs`（固定种子，可重复复现）
- 整轮试验：`node experiments/trials/run-all.mjs --round <轮次编号>`
- 单项试验：`experiments/trials/e1…e6、e10、e11`，说明见 `docs/tech-trials-prep.md` §4
- 浏览器侧 harness：`experiments/browser/harness.html`（本地 `python -m http.server` 后访问）
- 真实浏览器轮驱动：`node experiments/browser/real-browser-trial.mjs`（CDP 驱动本机 Edge）
- 证据（只增不改，随仓库提交）：`experiments/evidence/<轮次编号>/`
- 清理（只删可再生成的产物）：`node experiments/tools/cleanup.mjs`
- 依赖：Node.js ≥ 22.5（`node:sqlite`）、Python ≥ 3.11（仅 E6 交叉验证）；无第三方包。

## 协作规则

- 遵循 `D:/code/zvec/docs/development-workflow-guide.md` 的阶段门禁；技术试验必须有
  明确假设、固定样本、可重复步骤、通过门槛、结论和限制，不得冒充正式功能或验收。
- 凭据（密码、恢复码、密钥、会话）不得进入聊天、文档或仓库。
- 每次修改只动当前任务范围；修改前先明文列出文件范围。
