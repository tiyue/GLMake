# GLMake

免费、开源、可自托管的 Markdown 写作与同步工具（类马克飞象体验，独立实现）。
单用户、本地优先、自有服务器同步；Apache-2.0。

- **仅 Web**：桌面/平板/手机浏览器响应式；light/dark/跟随系统。
- **核心能力**：双栏编辑（深色编辑区/浅色预览区）、完整 Markdown 方言（公式/流程图/
  表格/复选框）、多笔记本与标签、附件、手动+条件自动同步、四路径冲突处理、30 天回收站、
  版本历史、可撤销只读分享、未加密 `.glmake.zip` 全量导出/导入。
- **运行期零第三方依赖**：Node.js ≥ 22.5（内置 SQLite）。前端构建产物已 vendor 入库。

## 快速开始

```bash
git clone <本仓库> && cd GLMake
GLMAKE_DATA=./data PORT=8787 node server/app.mjs
# 浏览器打开 http://127.0.0.1:8787 ，首次访问建立所有者账户
```

测试：`node --test tests/server.test.mjs`

## 重要提示

- 默认公网 HTTP、数据与导出包不加密：只存放可接受泄露的非重要文件。详见
  `docs/privacy.md`。
- 部署/升级/回滚/备份：`docs/deploy.md`。
- 立项与验收边界：`docs/project-charter.md`；技术设计：`docs/tech-design.md`；
  阶段 2 试验证据：`experiments/evidence/`。

## 许可证

Apache-2.0（`LICENSE`）。前端 vendor 组件（CodeMirror 6、KaTeX、mermaid）保留其 MIT
许可与版权声明，见 `server/static/vendor/NOTICE.md`。
