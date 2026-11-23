import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = () => import(new URL("../core/ui/rich.js", import.meta.url).href);
const appSource = () => readFile(new URL("../core/ui/app.js", import.meta.url), "utf8");
const cssSource = () => readFile(new URL("../core/ui/styles.css", import.meta.url), "utf8");

/** 只实现 detailsState / applyDetailsState 用到的那点 DOM 形状。 */
type StubDetails = { open: boolean };
type StubMessage = {
  dataset: { index: string; detailKey?: string };
  querySelectorAll: (selector: string) => StubDetails[];
};
const boxOf = (messages: StubMessage[]) => ({
  querySelectorAll: (selector: string) => (selector === ".message[data-index]" ? messages : []),
});
const messageOf = (index: number, details: StubDetails[], detailKey?: string): StubMessage => ({
  dataset: detailKey === undefined ? { index: String(index) } : { index: String(index), detailKey },
  querySelectorAll: (selector: string) => (selector === "details" ? details : []),
});

test("表格单元格里的转义竖线不算列分隔", async () => {
  const { renderRich } = await load();
  const html = renderRich(["| 内容 | 状态 |", "| --- | --- |", "| A\\|B | 完成 |"].join("\n"));
  assert.equal((html.match(/<td/g) || []).length, 2);
  assert.match(html, /A\|B/);
  assert.match(html, /完成/);
  assert.doesNotMatch(html, /\\/);
});

test("行内代码保留原样，不被当成加粗或链接", async () => {
  const { renderRich } = await load();
  const bold = renderRich("`**原样**`");
  assert.match(bold, /<code>\*\*原样\*\*<\/code>/);
  assert.doesNotMatch(bold, /<strong>/);
  const link = renderRich("`[说明](https://example.org/)`");
  assert.match(link, /<code>\[说明\]\(https:\/\/example\.org\/\)<\/code>/);
  assert.doesNotMatch(link, /<a /);
});

test("算式里的乘号不会被当成斜体", async () => {
  const { renderRich } = await load();
  const html = renderRich("3 * 4 * 5 = 60");
  assert.match(html, /3 \* 4 \* 5 = 60/);
  assert.doesNotMatch(html, /<em>/);
});

test("四个反引号围栏能把三个反引号的示例整段包住", async () => {
  const { renderRich } = await load();
  const html = renderRich(["````markdown", "```js", "**示例**", "```", "````"].join("\n"));
  assert.equal((html.match(/<pre/g) || []).length, 1);
  assert.match(html, /```js/);
  assert.match(html, /\*\*示例\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test("重画消息列表时保留「查看模型原文」的展开状态", async () => {
  const { detailsState, applyDetailsState } = await load();
  const state = detailsState(boxOf([messageOf(0, [{ open: false }]), messageOf(1, [{ open: true }])]));
  assert.equal(state.size, 1);
  const after = boxOf([messageOf(0, [{ open: false }]), messageOf(1, [{ open: false }])]);
  applyDetailsState(after, state);
  assert.equal(after.querySelectorAll(".message[data-index]")[1].querySelectorAll("details")[0].open, true);
});

test("两个会话同序号的「查看模型原文」不共用展开状态", async () => {
  const { detailsState, applyDetailsState } = await load();
  // A 会话的第 1 条展开着
  const state = detailsState(boxOf([messageOf(1, [{ open: true }], "sessionA:m1")]));
  assert.deepEqual([...state], ["sessionA:m1:0"]);
  // 切到 B 会话，同样在第 1 条，不该跟着展开
  const after = boxOf([messageOf(1, [{ open: false }], "sessionB:m1")]);
  applyDetailsState(after, state);
  assert.equal(after.querySelectorAll(".message[data-index]")[0].querySelectorAll("details")[0].open, false);
  // 回到 A，展开状态还在
  const back = boxOf([messageOf(1, [{ open: false }], "sessionA:m1")]);
  applyDetailsState(back, state);
  assert.equal(back.querySelectorAll(".message[data-index]")[0].querySelectorAll("details")[0].open, true);
});

test("没有 detail-key 时退回序号，旧行为不变", async () => {
  const { detailsState, applyDetailsState } = await load();
  const state = detailsState(boxOf([messageOf(2, [{ open: true }])]));
  assert.deepEqual([...state], ["i2:0"]);
  const after = boxOf([messageOf(2, [{ open: false }])]);
  applyDetailsState(after, state);
  assert.equal(after.querySelectorAll(".message[data-index]")[0].querySelectorAll("details")[0].open, true);
});

test("只有空白的首个分片不撤掉等待气泡，头像跟着人格名", async () => {
  const { hasVisibleText, avatarLabel } = await load();
  assert.equal(hasVisibleText(""), false);
  assert.equal(hasVisibleText("\n"), false);
  assert.equal(hasVisibleText(" \n\t"), false);
  assert.equal(hasVisibleText("你好"), true);
  assert.equal(avatarLabel("鲸鲸"), "鲸");
  assert.equal(avatarLabel(""), "助");
});

test("流式分片只重画当前回复，等待气泡不再写死人名", async () => {
  const source = await appSource();
  const from = source.indexOf('data.type === "chunk"');
  const branch = source.slice(from, source.indexOf('data.type === "done"', from));
  assert.match(branch, /if \(created\) this\.renderMessages\(\);/);
  assert.match(branch, /else this\.updateStreamingReply\(\);/);
  assert.match(source, /data-streaming="1"/);
  assert.doesNotMatch(source, /mini-avatar">勘</);
});

test("行首三个反引号包住的行内代码不是围栏，不吃掉下一行", async () => {
  const { renderRich } = await load();
  const html = renderRich(["```npm test```", "然后看测试结果。"].join("\n"));
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /然后看测试结果。/);
  assert.doesNotMatch(html, /<pre/);
});

test("表头与分隔行格数不一致时不按表格解析，末列不丢", async () => {
  const { renderRich } = await load();
  const html = renderRich(["Linux | macOS", "---", "Python | Node | Go"].join("\n"));
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /Python \| Node \| Go/);
});

test("标题里的井号是正文，结尾的闭合井号才去掉", async () => {
  const { renderRich } = await load();
  assert.match(renderRich("## C#"), /<h3>C#<\/h3>/);
  assert.match(renderRich("### 标题 ###"), /<h4>标题<\/h4>/);
});

test("「查看模型原文」的展开状态存在实例上，整页重画也能保留", async () => {
  const source = await appSource();
  assert.match(source, /this\.detailsOpen/);
  assert.match(source, /addEventListener\("toggle"/);
  // 不能只在重画时读当前那个刚被换掉的盒子
  assert.doesNotMatch(source, /const open = detailsState\(box\);/);
  assert.match(source, /applyDetailsState\(box, open\);/);
  // 键里带会话前缀，切会话时还要清空，两处都得在
  assert.match(source, /data-detail-key="\$\{e\(keyOf\(m, index\)\)\}"/);
  assert.match(source, /const keyOf = \(m, index\) => \(this\.state\.session \|\| "-"\)/);
  assert.match(source, /this\.detailsOpen = new Set\(\);/);
});

test("思考中那三个点是实心小圆点，不是零尺寸的空标签", async () => {
  const css = await cssSource();
  const rule = css.match(/\.bubble\.thinking i \{[^}]*\}/);
  assert.ok(rule, "找不到 .bubble.thinking i 的样式");
  assert.match(rule[0], /display:\s*inline-block/);
  assert.match(rule[0], /width:\s*5px/);
  assert.match(rule[0], /height:\s*5px/);
  assert.match(rule[0], /background:/);
});
