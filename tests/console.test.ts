import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { WebSocket } from "ws";
import { boot } from "../core/index.ts";
import { persona } from "../core/persona.ts";
import { startWeb } from "../core/web.ts";

test("plugin management opens the store drawer and public catalog links still work", async t => {
  const { renderPlugins } = await import(new URL("../core/ui/views.js", import.meta.url).href);
  const management = renderPlugins({ state: { status: { plugins: [] } } });
  assert.match(management, /href="#market"/);
  assert.doesNotMatch(management, /data-plugin-view|id="official-shelf"/);
  const web = await startWeb({ web: { port: 0 } }, { channels: {}, logger: { info() {} } }, {});
  t.after(() => web.close());
  const address = web.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  const shellHTML = await shell.text();
  assert.match(shellHTML, /<dialog\b[^>]*\bid="store-drawer"/);
  const sidebar = shellHTML.match(/<aside\b[^>]*\bid="sidebar"[^>]*>[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar);
  assert.doesNotMatch(sidebar, /href="#market"/);
  const store = await fetch(base + "/ui/plugin-store.js");
  assert.equal(store.status, 200);
  assert.match(store.headers.get("content-type") || "", /javascript/);
  const market = new URL("/market/", base);
  const page = await fetch(market);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /^text\/html/);
  assert.match(await page.text(), /<footer\b[^>]*>[\s\S]*?962935021[\s\S]*?<\/footer>/);

  const paths = new Map([
    ["index.html", "text/html"], ["assets/market.css", "text/css"],
    ["assets/catalog.js", "text/javascript"], ["assets/symbols.js", "text/javascript"],
    ["assets/catalog-validation.js", "text/javascript"], ["assets/market.js", "text/javascript"],
    ["assets/whale.svg", "image/svg+xml"], ["catalog.json", "application/json"],
    ["official-releases.json", "application/json"],
  ]);
  const ids = ["qq", "qzone", "autonomy", "gallery", "surf", "bilibili", "vision", "computer"];
  for (const [file, mime] of paths) {
    const asset = await fetch(new URL(file + "?cache=1", market));
    assert.equal(asset.status, 200, file);
    assert.equal(asset.headers.get("content-type")?.split(";")[0], mime, file);
    if (file === "catalog.json" || file === "official-releases.json") {
      const data = await asset.json();
      const plugins = file === "catalog.json" ? data.official : data.plugins;
      assert.deepEqual(plugins.map((plugin: { id: string }) => plugin.id), ids);
    }
  }
  const redirect = await fetch(base + "/market?view=official", { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/market/?view=official");
  assert.equal((await fetch(new URL("tools/check-official.mjs", market))).status, 404);
  assert.equal((await fetch(market, { headers: { Origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const signedIn = await fetch(market, { redirect: "manual", headers: { cookie } });
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get("location"), "/#market");
});

test("console config API persists model selection, protects secrets and changes the next chat request", async () => {
  const requested: string[] = [];
  const systemPrompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          data: [{ id: "chat-a" }, { id: "chat-b" }, { id: "vector-a" }],
        }),
      );
    }
    if (req.url === "/v1/embeddings") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
      );
    }
    if (req.url === "/v1/chat/completions") {
      requested.push(body.model);
      systemPrompts.push(body.messages[0].content);
      res.setHeader("Content-Type", "text/event-stream");
      return res.end(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "模型 " + body.model } }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerPort = (provider.address() as any).port;
  const root = await temporaryDirectory("whale-console-");
  await mkdir(join(root, "config"));
  const config = {
    web: { host: "127.0.0.1", port: 19274 },
    providers: [
      {
        id: "local",
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        api_key: "private-fixture-secret",
        model: "chat-a",
      },
    ],
    personas: {
      whale: {
        name: "鲸鲸",
        file: "memory/personas/whale.md",
        provider: "local",
        permission: "off",
      },
    },
    channels: { web: { persona: "whale", permission: "off" } },
    memory: { root: "memory" },
    custom: { keep: "unchanged" },
  };
  await writeFile(join(root, "config/config.json"), JSON.stringify(config));
  let app: any;
  const url = "http://127.0.0.1:19274";
  try {
    app = await boot(root);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: "{}",
    });
    let cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = async (path: string) =>
      await fetch(url + path, { headers: { Cookie: cookie } });
    const post = async (path: string, data: any) =>
      fetch(url + path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    assert.equal((await fetch(url + "/api/model-config")).status, 401);
    assert.equal((await fetch(url + "/api/persona?id=whale")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/model-config/probe", {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal((await get("/")).status, 200);
    assert.equal(
      (await get("/ui/app.js")).headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.equal((await get("/ui/not-allowed")).status, 404);
    assert.match(
      (await get("/ui/models.css")).headers.get("content-type") || "",
      /text\/css/,
    );
    let snapshot = await (await get("/api/model-config")).json();
    assert.ok(!JSON.stringify(snapshot).includes("private-fixture-secret"));
    const draft = () => ({
      revision: snapshot.revision,
      providers: snapshot.providers,
      models: snapshot.models,
      bindings: snapshot.bindings,
      personaModels: Object.fromEntries(
        snapshot.personas.map((p: any) => [p.id, p.model]),
      ),
    });
    const next = { ...draft(), personaNames: { whale: "验收人格" } };
    next.models.push(
      {
        id: "second",
        name: "第二个对话模型",
        model: "chat-b",
        provider: "local",
        type: "chat",
        enabled: true,
        parameters: { temperature: 0.2 },
      },
      {
        id: "vector",
        name: "向量模型",
        model: "vector-a",
        provider: "local",
        type: "embedding",
        enabled: true,
        parameters: {},
      },
    );
    next.bindings.chat = "second";
    next.bindings.embedding = "vector";
    const saved = await post("/api/model-config", next);
    assert.equal(saved.status, 200);
    snapshot = await saved.json();
    assert.ok(!JSON.stringify(snapshot).includes("private-fixture-secret"));
    const persisted = JSON.parse(
      await readFile(join(root, "config/config.json"), "utf8"),
    );
    assert.equal(persisted.providers[0].api_key, "private-fixture-secret");
    assert.deepEqual(persisted.custom, { keep: "unchanged" });
    assert.equal(app.config.personas.whale.name, "验收人格");
    const beforePersona = await (await get("/api/persona?id=whale")).json();
    const editedPersona = {
      ...beforePersona,
      prompt: "# 验收人格\n使用简洁中文回答。",
    };
    const personaSaved = await post("/api/persona", editedPersona);
    assert.equal(personaSaved.status, 200);
    assert.equal(
      (await persona(root, app.config, "whale")).prompt,
      editedPersona.prompt,
      "the next request reads the edited persona file",
    );
    assert.equal((await post("/api/persona", beforePersona)).status, 409);
    assert.equal((await get("/api/persona?id=__proto__")).status, 400);
    assert.equal(
      (await post("/api/persona", { ...editedPersona, prompt: "" })).status,
      400,
    );
    snapshot = await (await get("/api/model-config")).json();
    const probe = await post("/api/model-config/test", { modelId: "vector" });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).dimensions, 4);
    const beforeDraftTest = await readFile(
      join(root, "config/config.json"),
      "utf8",
    );
    const draftPayload = {
      provider: {
        ...snapshot.providers[0],
        api_key: "",
        timeout_seconds: 15,
        proxy_url: "",
      },
      model: {
        ...snapshot.models.find((m: any) => m.id === "vector"),
        dimensions: 8,
      },
    };
    assert.equal(
      (await post("/api/model-config/probe", draftPayload)).status,
      502,
    );
    const detected = await post("/api/model-config/probe", {
      ...draftPayload,
      detectDimensions: true,
    });
    assert.equal(detected.status, 200);
    assert.equal((await detected.json()).dimensions, 4);
    assert.equal(
      await readFile(join(root, "config/config.json"), "utf8"),
      beforeDraftTest,
      "draft tests must not save or switch the active model",
    );
    const available = await post("/api/model-config/models", {
      providerId: "local",
    });
    assert.deepEqual((await available.json()).models, [
      "chat-a",
      "chat-b",
      "vector-a",
    ]);
    const beforeList = await readFile(join(root, "config/config.json"), "utf8");
    const listProvider = snapshot.providers.find((p: any) => p.id === "local");
    const draftList = await post("/api/model-config/models/draft", {
      provider: listProvider,
    });
    assert.equal(draftList.status, 200);
    assert.deepEqual((await draftList.json()).models, [
      "chat-a",
      "chat-b",
      "vector-a",
    ]);
    assert.equal(
      await readFile(join(root, "config/config.json"), "utf8"),
      beforeList,
    );
    assert.equal(
      (
        await post("/api/model-config/models/draft", {
          provider: { ...listProvider, base_url: "https://other.example/v1" },
        })
      ).status,
      400,
      "draft list cannot forward a saved key to a changed address",
    );
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url.replace("http", "ws") + "/ws/chat", {
        headers: { Cookie: cookie },
      });
      let text = "";
      const timer = setTimeout(() => {
        ws.close();
        reject(Error("chat timeout"));
      }, 5000);
      ws.on("open", () =>
        ws.send(JSON.stringify({ session: "console-test", text: "测试选择" })),
      );
      ws.on("message", (raw) => {
        const item = JSON.parse(raw.toString());
        if (item.type === "chunk") text += item.text;
        else if (item.type === "done" || item.type === "error") {
          clearTimeout(timer);
          ws.close();
          if (item.type === "error") reject(Error(item.error));
          else resolve(text);
        }
      });
      ws.on("error", reject);
    });
    assert.match(reply, /chat-b/);
    assert.ok(
      systemPrompts
        .at(-1)
        ?.includes(
          "【当前人格设定】\n" + editedPersona.prompt + "\n【人格设定结束】",
        ),
      "edited persona reaches the actual model request",
    );
    assert.equal(requested.at(-1), "chat-b");
    // 无分页参数仍然是数组（旧契约）；显式要分页才是对象
    assert.equal((await (await get("/api/session?id=console-test")).json()).length, 2);
    const paged = await (await get("/api/session?id=console-test&limit=1")).json();
    assert.equal(paged.items.length, 1);
    assert.equal(paged.hasMore, true);
    const pluginReply = await app.llm.chat({
      model: "second",
      messages: [{ role: "user", content: "explicit registry selection" }],
    });
    assert.match(pluginReply.text, /chat-b/);
    await assert.rejects(
      () => app.llm.chat({ model: "vector", messages: [] }),
      /对话模型/,
    );
    const invalid = draft();
    invalid.models = invalid.models.filter((m: any) => m.id !== "second");
    assert.equal((await post("/api/model-config", invalid)).status, 400);
    assert.equal((await post("/api/model-config", next)).status, 409);
    const malformed = await fetch(url + "/api/model-config", {
      method: "POST",
      headers: { Cookie: cookie },
      body: '{"api_key":"new-malformed-secret"',
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes("new-malformed-secret"));
    assert.ok(!app.logger.lines.join("\n").includes("new-malformed-secret"));
    const created = await post("/api/persona/config", {
      configRevision: snapshot.revision,
      name: "新测试人格",
      model: "local-chat",
      prompt: "你是测试人格 ALPHA。只按新人格回答。",
      activate: false,
    });
    assert.equal(created.status, 200);
    const createdData = await created.json();
    const newPersonaId = createdData.persona.id;
    assert.equal(
      createdData.config.activePersona,
      "whale",
      "save alone does not activate",
    );
    assert.equal(app.config.channels.web.persona, "whale");
    const activation = {
      ...createdData.persona,
      configRevision: createdData.config.revision,
      activate: true,
    };
    const activated = await post("/api/persona/config", activation);
    assert.equal(activated.status, 200);
    const activeData = await activated.json();
    assert.equal(activeData.config.activePersona, newPersonaId);
    assert.equal(
      (await (await get("/api/status")).json()).personaName,
      "新测试人格",
    );
    await app.sessions.chat("persona-new", "自我介绍", () => {});
    assert.equal(requested.at(-1), "chat-a");
    assert.ok(
      systemPrompts
        .at(-1)
        ?.includes(
          "【当前人格设定】\n" +
            createdData.persona.prompt +
            "\n【人格设定结束】",
        ),
    );
    const updatedPrompt = "你是测试人格 BETA。只按修改后的要求回答。";
    const updated = await post("/api/persona/config", {
      ...activeData.persona,
      prompt: updatedPrompt,
      configRevision: activeData.config.revision,
      activate: false,
    });
    assert.equal(updated.status, 200);
    await app.sessions.chat("persona-new", "再介绍一次", () => {});
    assert.ok(
      systemPrompts
        .at(-1)
        ?.includes("【当前人格设定】\n" + updatedPrompt + "\n【人格设定结束】"),
      "prompt edits affect the next request without a restart",
    );
    assert.equal((await post("/api/persona/config", activation)).status, 409);
    await app.close();
    app = await boot(root);
    assert.equal(app.config.model_bindings.chat, "second");
    assert.equal(app.config.model_bindings.embedding, "vector");
    assert.equal(app.config.personas.whale.name, "验收人格");
    assert.equal(app.config.channels.web.persona, newPersonaId);
    assert.equal(
      (await persona(root, app.config, newPersonaId)).prompt,
      updatedPrompt,
    );
    assert.equal(
      (await persona(root, app.config, "whale")).prompt,
      editedPersona.prompt,
    );
  } finally {
    await app?.close();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
