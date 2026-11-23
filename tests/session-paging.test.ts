import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { boot } from "../core/index.ts";

/**
 * 会话分页的三条契约：
 * 1. 不传分页参数时仍是「最近 100 条的数组」，旧调用方可以照旧 rows.filter；
 * 2. 传了分页参数时页边界按「可显示的聊天消息」算——工具记录不占格，
 *    否则整页会被前端滤空（这正是复测里「有历史却是空白页」的成因）；
 * 3. start / end 是消息在整份历史里的绝对行号，往前翻页拿它当游标，
 *    窗口怎么放大都不会改变同一条消息的编号。
 */
test("会话分页按可显示消息算页边界，游标用绝对行号", async () => {
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
    // 每条消息前面垫了 3 条工具记录，所以「第 20 条」在文件的第 83 行
    assert.equal(first.start, 83);
    assert.equal(first.end, 120);
    assert.equal(first.hasMore, true);

    const older = await get(`/api/session?id=paging&limit=10&before=${first.start}`);
    assert.equal(older.items.length, 10);
    assert.equal(older.items[0].text, "第 10 条");
    assert.equal(older.start, 43);
    assert.equal(older.end, 80);
    assert.equal(older.hasMore, true);

    const oldest = await get(`/api/session?id=paging&limit=10&before=${older.start}`);
    assert.equal(oldest.items.length, 10);
    assert.equal(oldest.items[0].text, "第 0 条");
    assert.equal(oldest.start, 3);
    assert.equal(oldest.hasMore, false);

    // 游标处没有更早的消息时，返回空页并收工，不能让前端一直往前翻
    const past = await get(`/api/session?id=paging&limit=10&before=${oldest.start}`);
    assert.deepEqual(past.items, []);
    assert.equal(past.hasMore, false);

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

test("一直往前翻能翻到最早那条，不会翻回最后一屏", async () => {
  const root = await temporaryDirectory("whale-paging-walk-");
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config/config.json"),
    JSON.stringify({
      web: { host: "127.0.0.1", port: 19289 },
      providers: [{ id: "local", base_url: "http://127.0.0.1:1/v1", model: "chat-a" }],
      personas: { whale: { name: "鲸鲸", file: "memory/personas/whale.md", provider: "local", permission: "off" } },
      channels: { web: { persona: "whale", permission: "off" } },
      memory: { root: "memory" },
    }),
  );
  const app: any = await boot(root);
  try {
    for (let i = 0; i < 200; i += 1)
      await app.memory.appendEvent({ session: "walk", type: "message", role: "user", text: `第 ${i} 条` });

    const url = "http://127.0.0.1:19289";
    const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = async (path: string) => (await fetch(url + path, { headers: { Cookie: cookie } })).json();

    const seen: string[] = [];
    const starts: number[] = [];
    let before = 0;
    let page = await get("/api/session?id=walk&limit=40");
    for (let guard = 0; guard < 20; guard += 1) {
      for (const row of page.items) seen.push(row.text);
      starts.push(page.start);
      if (!page.hasMore) break;
      assert.ok(page.start < before || before === 0, "游标必须一直往前，不能跳回后面");
      before = page.start;
      page = await get(`/api/session?id=walk&limit=40&before=${before}`);
    }

    assert.equal(seen.length, 200, "五页正好把 200 条走完");
    assert.equal(new Set(seen).size, 200, "没有重复出现同一条消息");
    assert.equal(seen[0], "第 160 条", "第一页从最新的一条开始");
    assert.equal(seen.at(-1), "第 39 条", "最后一页收在最老那一段的末尾");
    assert.ok(seen.includes("第 0 条"), "最早那条翻得到");
    assert.deepEqual(starts, [160, 120, 80, 40, 0], "游标逐页往前，不跳回");
  } finally {
    await app.close?.();
  }
});

test("旧渠道回执里的正文不能因为分页而丢", async () => {
  const root = await temporaryDirectory("whale-paging-receipt-");
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config/config.json"),
    JSON.stringify({
      web: { host: "127.0.0.1", port: 19293 },
      providers: [{ id: "local", base_url: "http://127.0.0.1:1/v1", model: "chat-a" }],
      personas: { whale: { name: "鲸鲸", file: "memory/personas/whale.md", provider: "local", permission: "off" } },
      channels: { web: { persona: "whale", permission: "off" } },
      memory: { root: "memory" },
    }),
  );
  const app: any = await boot(root);
  try {
    await app.memory.appendEvent({ session: "receipt", type: "message", role: "user", text: "问 1" });
    // 旧渠道：助手的话在 sent 回执里，不是 message 行
    await app.memory.appendEvent({
      session: "receipt",
      type: "channel_receipt",
      direction: "out",
      status: "sent",
      text: "答 1",
      delivery_id: "d-1",
      sent_at: new Date().toISOString(),
      conversation: { channel: "qq" },
    });
    await app.memory.appendEvent({ session: "receipt", type: "message", role: "user", text: "问 2" });

    const url = "http://127.0.0.1:19293";
    const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = async (path: string) =>
      (await fetch(url + path, { headers: { Cookie: cookie } })).json();

    const legacy = await get("/api/session?id=receipt");
    assert.ok(Array.isArray(legacy));
    assert.ok(
      legacy.some((row: any) => row.text === "答 1"),
      "不分页时看得到这条回执投影出来的正文",
    );

    const paged = await get("/api/session?id=receipt&limit=2");
    const texts = paged.items.map((row: any) => row.text);
    assert.deepEqual(texts, ["答 1", "问 2"], "分页也要按同一套投影算，不能把回执正文丢掉");
  } finally {
    await app.close?.();
  }
});
