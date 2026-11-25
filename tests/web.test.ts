import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryDirectory } from "./temporary-directory.ts";
import { once } from "node:events";
import { connect } from "node:net";
import { WebSocket } from "ws";
import { Logger } from "../core/logger.ts";
import { startWeb } from "../core/web.ts";

test("a gated host closes browser preconnections before finishing preflight", async t => {
  const app = await startWeb({ web: { port: 0 } }, { channels: {}, logger: { info() {} }, hostStarting: () => true }, {});
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const accepted = once(app.server, "connection");
  const socket = connect(address.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await Promise.all([accepted, once(socket, "connect")]);
  const disconnected = once(socket, "close");
  let expired = false;
  const deadline = setTimeout(() => { expired = true; socket.destroy(); }, 2000);
  try {
    await Promise.all([app.close(), disconnected]);
    assert.equal(expired, false, "the host closed the connection without waiting for the client");
  } finally { clearTimeout(deadline); }
});

test("the plugin update GET returns a local snapshot and only the check POST fetches the market approvals", async t => {
  const browserFetch = globalThis.fetch;
  const upstream: string[] = [];
  const plugin = { id: "test-notice", version: "1.0.0", repository: "https://github.com/example/test-notice" };
  const catalog = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
  const entry = { ...plugin, name: "Notice", description: "Notice", installation: plugin.repository, dependencies: [],
    verifiedReleases: [{ version: "1.1.0", hostRange: "0.1.0", platform: "any", arch: "any", sha256: "a".repeat(64),
      assetUrl: plugin.repository + "/releases/download/v1.1.0/test-notice.wlpkg.gz", sizeBytes: 100, dependencies: {} }] };
  t.mock.method(globalThis, "fetch", async (input: string) => {
    upstream.push(input);
    if (input === catalog) return Response.json({ official: [], community: [entry] });
    return new Response(null, { status: 404 });
  });
  const root = await temporaryDirectory("whale-update-web-");
  const logger = new Logger(root);
  const runtime = { root, list: () => [plugin], records: new Map([[plugin.id, { manifest: plugin }]]),
    pluginState: { load: async () => {}, enabled: () => true }, managePackages: (run: () => unknown) => run() };
  const app = await startWeb({ web: { port: 0 } }, { logger }, runtime);
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port;
  const login = await browserFetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const endpoint = url + "/api/plugin-updates";
  const snapshot = () => browserFetch(endpoint, { headers: { Cookie: cookie } }).then(res => res.json());
  assert.deepEqual((await snapshot()).updates, []);
  assert.deepEqual(upstream, []);
  const checked = await browserFetch(endpoint + "/check", {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
  }).then(res => res.json());
  assert.equal(checked.updates[0]?.latestVersion, "1.1.0");
  assert.deepEqual(upstream, [catalog]);
  const count = upstream.length;
  assert.deepEqual((await snapshot()).updates, checked.updates);
  assert.equal(upstream.length, count);
});

test("authenticated HTTP/WS, cross-origin rejection and same-source logs", async () => {
  const logger = new Logger(await temporaryDirectory("whale-web-"));
  const config = {
    web: { host: "127.0.0.1", port: 19271, password: "测试密码" },
    providers: [],
    channels: { web: { persona: "test", permission: "off" } },
  };
  const app = await startWeb(
    config,
    {
      logger,
      memory: { status: async () => ({ files: 0 }) },
      sessions: {
        chat: async (_id: any, _text: any, onChunk: any) => {
          onChunk("你好");
        },
      },
    },
    { list: () => [] },
  );
  try {
    const url = "http://127.0.0.1:19271";
    assert.equal((await fetch(url + "/api/status")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/login", {
          method: "POST",
          headers: { Origin: "http://foreign.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/login", {
          method: "POST",
          body: JSON.stringify({ password: "wrong" }),
        })
      ).status,
      401,
    );
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "测试密码" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await fetch(url + "/api/status", { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    const ws = new WebSocket("ws://127.0.0.1:19271/ws/logs", {
      headers: { Cookie: cookie },
    });
    await once(ws, "open");
    const result = new Promise<any>((resolve) =>
      ws.on("message", (raw) => {
        const row = JSON.parse(raw.toString());
        if (row.line.includes("same-source-marker")) resolve(row);
      }),
    );
    logger.info("same-source-marker");
    const line = (await result).line;
    assert.equal(line, logger.lines.at(-1));
    ws.close();
    await once(ws, "close");
    const remove = app.page("/plugins/test", (_req: any, res: any) =>
      res.end("plugin page"),
    );
    assert.equal(
      await (
        await fetch(url + "/plugins/test", { headers: { Cookie: cookie } })
      ).text(),
      "plugin page",
    );
    remove();
    assert.equal(
      (await fetch(url + "/plugins/test", { headers: { Cookie: cookie } }))
        .status,
      404,
    );
  } finally {
    await app.close();
  }
  await assert.rejects(
    () =>
      startWeb(
        { ...config, web: { host: "0.0.0.0", port: 19271 } },
        { logger },
        {},
      ),
    /局域网/,
  );
});
