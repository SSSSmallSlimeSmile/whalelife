import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readdir } from "node:fs/promises";
import { HostUpdates } from "../core/host-updates.ts";
import { startWeb } from "../core/web.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repository = "https://github.com/iinukami/whalelife";
const manifestName = "whalelife-update.json";
const latestManifest = repository + "/releases/latest/download/" + manifestName;

function manifestSource(version: string, onCheck: () => Response | undefined, digest = () => "a".repeat(64)): typeof fetch {
  const tagged = repository + "/releases/download/v" + version + "/" + manifestName;
  const asset = "https://release-assets.githubusercontent.com/example/manifest";
  return async input => {
    const url = String(input);
    if (url === latestManifest) return onCheck() ?? Response.redirect(tagged, 302);
    if (url === tagged) return Response.redirect(asset, 302);
    assert.equal(url, asset);
    return Response.json({ format: 1, version, size: 3, sha256: digest() });
  };
}

test("仅查询、过期版本和未确认操作均不能启动更新；发行包换过摘要时必须重新确认", async () => {
  const root = await temporaryDirectory("whale-host-approval-");
  let digest = "a".repeat(64), fetched = 0, activated = 0;
  const updates = new HostUpdates(root, "0.1.0", () => { activated++; },
    manifestSource("0.1.1", () => { fetched++; return undefined; }, () => digest), () => true);
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
  const updates = new HostUpdates(root, "0.1.0", () => {activations++;},
    manifestSource("0.1.1", () => { requests++; return undefined; }));
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

test("手动复查期间和失败后，不能使用上次看到的版本启动安装", async () => {
  const root = await temporaryDirectory("whale-host-recheck-");
  const source = manifestSource("0.1.1", () => undefined);
  let resumeCheck!: () => void;
  const gate = new Promise<void>(resolve => { resumeCheck = resolve; });
  let checkingAgain = false, activations = 0;
  const updates = new HostUpdates(root, "0.1.0", () => { activations++; }, async (url, init) => {
    if (checkingAgain && String(url) === latestManifest) {
      await gate;
      return new Response(null, { status: 503 });
    }
    return source(url, init);
  }, () => true);
  const previous = await updates.check();
  assert.equal(previous.latest?.version, "0.1.1");
  checkingAgain = true;
  const pending = updates.check();
  const confirm = () => updates.apply({ version: "0.1.1", confirmed: true });
  await assert.rejects(confirm(), { status: 409 });
  resumeCheck();
  const failed = await pending;
  assert.ok(failed.error);
  assert.equal(failed.lastCheckedAt, previous.lastCheckedAt);
  assert.equal(failed.latest, null);
  await assert.rejects(confirm(), { status: 409 });
  assert.equal(activations, 0);
});

test("读取本体状态从不访问发行源，检查失败后仅手动重试", async t => {
  const root = await temporaryDirectory("whale-host-manual-");
  let fetched = 0;
  const hostUpdates = new HostUpdates(root, "0.1.0", undefined, manifestSource("0.1.0", () => {
    fetched++;
    if (fetched === 1) return new Response(null, { status: 403 });
    if (fetched === 2) return new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    if (fetched === 4) return new Response(null, { status: 404 });
  }));
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
  const forbidden = await check();
  assert.match(forbidden.error, /^GitHub 拒绝了本次版本查询/);
  assert.deepEqual(await status(), forbidden);
  assert.equal(fetched, 1);
  const limited = await check();
  assert.match(limited.error, /^GitHub 暂时限制了更新查询。请稍后再试/);
  assert.equal(limited.checked, false);
  assert.equal(limited.latest, null);
  assert.deepEqual(await status(), limited);
  assert.equal(fetched, 2);
  const latest = await check();
  assert.equal(latest.checked, true);
  assert.equal(latest.latest, null);
  assert.equal(latest.error, undefined);
  assert.deepEqual(await status(), latest);
  assert.equal(fetched, 3);
  assert.ok(Number.isFinite(Date.parse(latest.lastCheckedAt)));
  const missing = await check();
  assert.ok(missing.error);
  assert.equal(missing.checked, false);
  assert.equal(missing.lastCheckedAt, latest.lastCheckedAt);
  assert.deepEqual(await status(), missing);
  assert.equal(fetched, 4);
});
