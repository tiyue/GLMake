# GLMake 工作区索引（AGENTS.md）

- 项目：GLMake（免费开源的类马克飞象 Markdown 写作与同步工具，Apache-2.0）
- 当前状态：**阶段 2（调研与可行性）进行中，不得开始开发**。试验产物不代表正式功能。
- 工作区目录 `马克飞象-私人版` 仅为本地路径，对外名称统一使用 GLMake。

## 权威文档索引（Spec 体系）

| 文档 | 角色 | 状态 |
| --- | --- | --- |
| `docs/project-charter.md` | 立项调研草案（权威：决策、边界、门禁、未知项） | 版本 0.40，阶段 2 进行中 |
| `docs/tech-trials-prep.md` | 阶段 2 技术试验准备与执行结论（GLMAKE-TRIAL-001） | 已确认，第 1–3 轮与浏览器轮已完成 |

## 技术试验（experiments/）

- 固定样本生成：`node experiments/tools/gen-samples.mjs`（固定种子，可重复复现）
- 整轮试验：`node experiments/trials/run-all.mjs --round <轮次编号>`
- 单项试验：`experiments/trials/e1…e6、e10、e11`，说明见 `docs/tech-trials-prep.md` §4
- 浏览器侧 harness：`experiments/browser/harness.html`（本地 `python -m http.server` 后访问）
- 证据（只增不改，随仓库提交）：`experiments/evidence/<轮次编号>/`
- 清理（只删可再生成的产物）：`node experiments/tools/cleanup.mjs`
- 依赖：Node.js ≥ 22.5（`node:sqlite`）、Python ≥ 3.11（仅 E6 交叉验证）；无第三方包。

## 协作规则

- 遵循 `D:/code/zvec/docs/development-workflow-guide.md` 的阶段门禁；技术试验必须有
  明确假设、固定样本、可重复步骤、通过门槛、结论和限制，不得冒充正式功能或验收。
- 凭据（密码、恢复码、密钥、会话）不得进入聊天、文档或仓库。
- 每次修改只动当前任务范围；修改前先明文列出文件范围。
