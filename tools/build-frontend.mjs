// 前端构建：esbuild 打包 CM6/KaTeX/mermaid 为静态产物（vendor 入库，部署零 npm）
// 用法：node tools/build-frontend.mjs
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR = path.join(ROOT, 'server/static/vendor');

fs.mkdirSync(VENDOR, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(ROOT, 'server/static/src/frontend.mjs')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2017',
  outfile: path.join(VENDOR, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

// KaTeX 样式与字体
const katexDist = path.join(ROOT, 'node_modules/katex/dist');
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(VENDOR, 'katex.min.css'));
fs.cpSync(path.join(katexDist, 'fonts'), path.join(VENDOR, 'fonts'), { recursive: true });

// 许可证声明（MIT 组件随产品分发，遵循其许可证要求）
fs.writeFileSync(path.join(VENDOR, 'NOTICE.md'), `# 第三方组件声明（构建产物）

以下组件以 MIT 许可证打包进 app.js / katex.min.css，版权见各自仓库：

- CodeMirror 6（codemirror、@codemirror/lang-markdown 等）© Marijn Haverbeke 等
- KaTeX © Khan Academy 等
- mermaid © Knut Sveidqvist 等

GLMake 主体采用 Apache-2.0；上述组件保留其 MIT 许可与版权声明。
`);

console.log('构建完成：', fs.statSync(path.join(VENDOR, 'app.js')).size, 'bytes → server/static/vendor/app.js');
