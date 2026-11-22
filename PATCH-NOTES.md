# 前端渲染补丁库

给 [iinukami/whalelife](https://github.com/iinukami/whalelife) 的**纯前端呈现**改动：聊天消息气泡支持 Markdown，回复期间显示「思考中」气泡。

对应 PR：[#11](https://github.com/iinukami/whalelife/pull/11)

- 基线：上游 `main` = `0080ba4`（收录抖音 v0.1.5 并接入社区插件一键安装 #8）
- 分支：`feat/frontend-render`（本库即该分支的独立工作区）
- 补丁文件：`patches/frontend-render-v1.patch`（23,615 字节）

---

## 为什么不直接改 PR 分支

原来的 PR 分支基于 `181a5eb`，上游已经走到 `0080ba4`，中间差 20 个提交，`diverged` / ahead 2 / behind 20。直接合会撞车。

这个库从 `0080ba4` 重新起，把原来那两个提交 cherry-pick 过来，逐个确认合到新版文件后没有丢内容，再重新打包成补丁。

---

## 改了什么（6 个文件，+507 / −9）

| 文件 | 变动 | 作用 |
|---|---:|---|
| `core/ui/rich.js` | 新增 245 行 | 纯渲染函数，不碰 DOM，可在 node 里直接测 |
| `core/ui/app.js` | +48 / −8 | 接入渲染；流式只重画当前气泡；思考中气泡 |
| `core/ui/styles.css` | +128 | Markdown 与气泡样式 |
| `core/web.ts` | +1 | 静态白名单加 `rich.js` |
| `tests/ui-rich-render.test.ts` | 新增 84 行 | 12 组输入回归 |
| `tests/current-session.test.ts` | 1 行 | 跟随调整 |

### 支持的语法

**块级**：代码围栏（``` 或 ~~~，关闭须同字符且不少于开头）、GFM 表格（对齐行、`\|` 转义）、标题 `#`–`######`（渲染压到 h3–h6）、分割线、引用、有序/无序列表（缩进嵌套、`start` 属性）。

**行内**：行内代码（先占位，`**原样**` 不会被加粗）、链接（只放行 `http(s)://`、`mailto:`、`/`、`#`、`./`、`../`；外链带 `rel="noopener noreferrer"`）、粗体、删除线、斜体（定界符须紧贴文字，`3 * 4 * 5` 的乘号不被吃）。

**安全**：正文先 `escapeHTML` 再解析；HTML 标签只显示不执行；`javascript:` / `data:` 链接原样留成文本。

### 不包含

- 会话分页（`GET /api/session` 仍是数组）
- `/api/media`、`/api/file` 一类新接口
- `[[img:路径]]` 渲染成图片（保持上游行为，原样文本）
- 任何接口改动，除了 `web.ts` 白名单一行

---

## 怎么用

```bash
# 在纯净上游 clone 里
git apply --check patches/frontend-render-v1.patch
git apply patches/frontend-render-v1.patch

node --test tests/ui-rich-render.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

---

## 验证记录（2026-11-22，本机）

**在 `0080ba4` 上重新应用**

```
git cherry-pick b584103   → 2 files changed（app.js / styles.css）
git cherry-pick d1ea29d   → 5 files changed, +374 / −187
git diff --stat origin/main HEAD
  core/ui/app.js                |  56 ++++++++--
  core/ui/rich.js               | 245 ++++++++++++++++++++++++++
  core/ui/styles.css            | 128 ++++++++++++++
  core/web.ts                   |   1 +
  tests/current-session.test.ts |   2 +-
  tests/ui-rich-render.test.ts  |  84 +++++++++++++++
  6 files changed, 507 insertions(+), 9 deletions(-)
```

与 PR 号称的 `+507 / −9` 一致，说明自动合并没有吃掉改动。

**测试 / 类型**

```
node --test tests/ui-rich-render.test.ts     → 7 pass / 0 fail
node --test tests/current-session.test.ts tests/web.test.ts → 15 pass / 0 fail
node node_modules/typescript/bin/tsc --noEmit → 0 error
```

**装进纯净实例（9272）实跑**

```
POST 应用补丁 → 6 文件干净应用
宿主重启 → 9272 监听 PID 37560
GET /                      → 200, 4701 bytes
GET /ui/rich.js            → 200, 8499 bytes（含 export function renderRich）
GET /ui/app.js             → 200, 35175 bytes（含 rich.js 引用）
宿主 stderr               → 空
```

**渲染函数直调（node 里跑，不经浏览器）**

| 输入 | 输出要点 |
|---|---|
| 三列对齐表格 | `.md-table` 包裹，`text-align` 左/中/右都在 |
| ` ```ts ` 围栏 | `class="lang-ts"`，内部 ` `${1}` ` 原样 |
| ` ```` ` 包 ` ```js ` | 内层三反引号没提前结束，整段留在 code 里 |
| 嵌套列表 + `1.` / `2)` | `<ul>` 嵌套正确，`<ol>` 合并成一条 |
| `` `**原样**` `` + `3 * 4 * 5` | 行内代码不被加粗；乘号保留 |
| `<script>` + `[x](javascript:...)` | 标签转义为文本；坏链接原样留成 `[x](javascript:...)` |
| 引用两行 + `---` + `###` | `blockquote` 合并；`<hr>`；标题压成 `<h4>` |

---

## 没验的

- 只在 Windows 11 + Chrome 上看过，Firefox / Safari 未测
- 长消息（上千行）渲染性能未测
- 折叠 `<details>` 状态在极长会话里的恢复未压测
- 移动端窄屏下的表格横向滚动只看过 CSS，没在真机上滑过
