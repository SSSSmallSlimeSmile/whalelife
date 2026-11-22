import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readdir } from "node:fs/promises";
import { HostUpdates } from "../core/host-updates.ts";
import { startWeb } from "../core/web.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repository = "https://github.com/iinukami/whalelife";
function metadata(digest: string) {
  const name = "whalelife-v0.1.1.wlhost.gz";
  return {tag_name:"v0.1.1", prerelease:false, draft:false, html_url:repository + "/releases/tag/v0.1.1",
    assets:[{name, size:3, state:"uploaded", digest:"sha256:" + digest,
      browser_download_url:repository + "/releases/download/v0.1.1/" + name}]};
}

test("仅查询、过期版本和未确认操作均不能启动更新；发行包换过摘要时必须重新确认", async () => {
  const root = await temporaryDirectory("whale-host-approval-");
  let digest = "a".repeat(64), fetched = 0, activated = 0;
  const updates = new HostUpdates(root, "0.1.0", () => { activated++; }, async () => {
    fetched++;
    return Response.json(metadata(digest));
  }, () => true);
  assert.equal((await updates.view()).checked, false);
  assert.equal(fetched, 0);
  const [first, second] = await Promise.all([updates.check(), updates.check()]);
  assert.equal(first.latest?.version, "0.1.1");
  assert.deepEqual(second, first);
  assert.deepEqual(await updates.view(), first);
  assert.equal(fetched, 1);
  await assert.rejects(updates.apply({ version: "0.1.1", confirmed:false }));
  await assert.rejects(updates.apply({ version: "0.1.2", confirmed:true }));
  assert.deepEqual(await readdir(root), []);
  digest = "b".repeat(64);
  await updates.apply({version:"0.1.1", confirmed:true});
  for (let i=0; i<50 && !(await updates.view()).lastResult; i++) await delay(5);
  const result = await updates.view();
  assert.equal(result.lastResult?.status, "failed");
  assert.match(result.lastResult!.message, /发行版本或摘要已变化/);
  assert.equal(activated, 0);
  assert.deepEqual(await readdir(root), []);
});

test("旧安装启动器无法申请停机，仍能读取当前状态和正式发行信息", async () => {
  const root = await temporaryDirectory("whale-legacy-launcher-");
  let requests = 0, activations = 0;
  // The old worker passes an activation callback but cannot negotiate a detached trial.
  const updates = new HostUpdates(root, "0.1.0", () => {activations++;}, async () => {
    requests++;
    return Response.json(metadata("a".repeat(64)));
  });
  const snapshot = await updates.check();
  assert.equal(snapshot.current, "0.1.0");
  assert.equal(snapshot.latest?.version, "0.1.1");
  assert.equal(snapshot.supported, false);
  assert.match(snapshot.error!, /根目录的启动器/);
  await assert.rejects(updates.apply({version:"0.1.1", confirmed:true}), {status:409});
  assert.deepEqual(await updates.view(), snapshot);
  assert.deepEqual([requests, activations], [1, 0]);
  assert.deepEqual(await readdir(root), []);
});

test("读取本体状态从不访问发行源，检查失败后仅手动重试", async t => {
  const root = await temporaryDirectory("whale-host-manual-");
  let fetched = 0;
  const hostUpdates = new HostUpdates(root, "0.1.0", undefined, async () => {
    return new Response(null, { status: ++fetched === 1 ? 403 : 404 });
  });
  const web = await startWeb({ web: { port: 0 } }, { channels: {}, logger: { info() {} }, hostUpdates }, { root });
  t.after(() => web.close());
  const address = web.server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const endpoint = base + "/api/host-update";
  const status = () => fetch(endpoint, { headers: { cookie } }).then(res => res.json());
  const check = () => fetch(endpoint + "/check", {
    method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}",
  }).then(res => res.json());
  assert.equal((await status()).checked, false);
  assert.equal(fetched, 0);
  assert.match((await check()).error, /HTTP 403/);
  assert.match((await status()).error, /HTTP 403/);
  assert.equal(fetched, 1);
  const latest = await check();
  assert.equal(latest.checked, true);
  assert.equal(latest.latest, null);
  assert.deepEqual(await status(), latest);
  assert.equal(fetched, 2);
});
