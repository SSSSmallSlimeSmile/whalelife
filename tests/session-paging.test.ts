import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { boot } from "../core/index.ts";

/**
 * 会话分页的两条契约：
 * 1. 不传分页参数时仍是「最近 100 条的数组」，旧调用方可以照旧 rows.filter；
 * 2. 传了分页参数时页边界按「可显示的聊天消息」算——工具记录不占格，
 *    否则整页会被前端滤空（这正是复测里「有历史却是空白页」的成因）。
 */
test("会话分页按可显示消息算页边界，无分页参数保持数组", async () => {
  const root = await temporaryDirectory("whale-paging-");
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config/config.json"),
    JSON.stringify({
      web: { host: "127.0.0.1", port: 19288 },
      providers: [{ id: "local", base_url: "http://127.0.0.1:1/v1", model: "chat-a" }],
      personas: { whale: { name: "鲸鲸", file: "memory/personas/whale.md", provider: "local", permission: "off" } },
      channels: { web: { persona: "whale", permission: "off" } },
      memory: { root: "memory" },
    }),
  );
  const app: any = await boot(root);
  try {
    // 30 条消息，每条前面垫 3 条工具记录：一页 10 条只能落在消息上
    for (let i = 0; i < 30; i += 1) {
      for (let k = 0; k < 3; k += 1)
        await app.memory.appendEvent({ session: "paging", type: "tool", text: `工具 ${i}-${k}` });
      await app.memory.appendEvent({ session: "paging", type: "message", role: "user", text: `第 ${i} 条` });
    }

    const url = "http://127.0.0.1:19288";
    const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = async (path: string) => (await fetch(url + path, { headers: { Cookie: cookie } })).json();

    const legacy = await get("/api/session?id=paging");
    assert.ok(Array.isArray(legacy), "无分页参数应返回数组");
    assert.ok(legacy.some((row: any) => row.type === "tool"), "旧契约里工具记录照旧在");

    const first = await get("/api/session?id=paging&limit=10");
    assert.equal(first.items.length, 10, "整页都应该落在消息上，不能被工具记录挤空");
    assert.ok(first.items.every((row: any) => row.type === "message"));
    assert.equal(first.items.at(-1).text, "第 29 条");
    assert.equal(first.items[0].text, "第 20 条");
    assert.equal(first.start, 20);
    assert.equal(first.end, 30);
    assert.equal(first.hasMore, true);

    const older = await get(`/api/session?id=paging&limit=10&before=${first.start}`);
    assert.equal(older.items.length, 10);
    assert.equal(older.items[0].text, "第 10 条");
    assert.equal(older.end, 20);
    assert.equal(older.hasMore, true);

    const oldest = await get(`/api/session?id=paging&limit=10&before=${older.start}`);
    assert.equal(oldest.items.length, 10);
    assert.equal(oldest.items[0].text, "第 0 条");
    assert.equal(oldest.start, 0);
    assert.equal(oldest.hasMore, false);

    // 窗口一开始不够（工具记录很密）时会继续往前扩，直到凑够一页
    for (let i = 0; i < 40; i += 1)
      await app.memory.appendEvent({ session: "dense", type: "tool", text: `密集 ${i}` });
    for (let i = 0; i < 5; i += 1)
      await app.memory.appendEvent({ session: "dense", type: "message", role: "user", text: `消息 ${i}` });
    const dense = await get("/api/session?id=dense&limit=5");
    assert.equal(dense.items.length, 5);
    assert.equal(dense.items[0].text, "消息 0");
    assert.equal(dense.hasMore, false);
  } finally {
    await app.close?.();
  }
});
