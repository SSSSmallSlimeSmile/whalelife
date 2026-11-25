/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { hostAssetName, hostReleaseRootFiles, latestHostRelease, stageHostRelease } from "../core/host-release.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repo = "https://github.com/iinukami/whalelife";
const version = "0.10.0", url = repo + "/releases/tag/v" + version, filename = hostAssetName(version);
const assetURL = repo + "/releases/download/v" + version + "/" + filename;
const latestManifest = repo + "/releases/latest/download/whalelife-update.json";
const taggedManifest = repo + "/releases/download/v" + version + "/whalelife-update.json";
const manifest = { format: 1, version, size: 100, sha256: "a".repeat(64) };
function withManifest(reply: () => Response): typeof fetch {
  return async input => {
    if (String(input) === latestManifest) return Response.redirect(taggedManifest);
    assert.equal(String(input), taggedManifest);
    return reply();
  };
}
const release = (bytes: Buffer) => ({ version, url, size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") });
const builder = fileURLToPath(new URL("../tools/build-host-release.mjs", import.meta.url));

test("release checks read a tag-bound manifest from GitHub release assets and compare numeric versions", async () => {
  const cdn = "https://release-assets.githubusercontent.com/example";
  const visited: string[] = [];
  let signal: AbortSignal | null | undefined;
  const found = await latestHostRelease("0.9.30", async (input, init) => {
    const address = String(input);
    visited.push(address);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.ok(init?.signal);
    signal ??= init.signal;
    assert.equal(init.signal, signal);
    if (address === latestManifest) return new Response(null, { status: 302, headers: { location: new URL(taggedManifest).pathname } });
    if (address === taggedManifest) return Response.redirect(cdn);
    assert.equal(address, cdn);
    return Response.json(manifest);
  });
  assert.deepEqual(found, { version, url, digest: "a".repeat(64), size: 100 });
  assert.deepEqual(visited, [latestManifest, taggedManifest, cdn]);
  for (const current of [version, "1.0.0"])
    assert.equal(await latestHostRelease(current, withManifest(() => Response.json(manifest))), null);
});

test("missing, malformed or unpinned manifests cannot supply a host update or confirm it is current", async () => {
  for (const status of [404, 503]) {
    const reply = () => new Response(null, { status });
    for (const request of [async () => reply(), withManifest(reply)])
      await assert.rejects(latestHostRelease(version, request), status === 404 ? /缺少更新清单/ : /503/);
  }
  for (const overrides of [
    { format: 2 }, { version: "0.9.0" }, { size: 0 }, { size: 40 * 1024 ** 2 + 1 },
    { sha256: "bad digest" }, { sha256: [manifest.sha256] }, { downloadURL: assetURL },
  ]) await assert.rejects(latestHostRelease(version, withManifest(() => Response.json({ ...manifest, ...overrides }))));
  await assert.rejects(latestHostRelease(version, withManifest(() => new Response("not JSON"))), /清单 JSON/);
  await assert.rejects(latestHostRelease(version, withManifest(() => new Response(" ".repeat(16 * 1024 + 1)))), /大小上限/);
  await assert.rejects(latestHostRelease(version, async () => Response.json(manifest)), /标签/);
  for (const location of [
    taggedManifest.replace("v0.10.0", "v0.10.0-beta.1"), taggedManifest.replace("/iinukami/", "/other-owner/"),
    assetURL, "https://release-assets.githubusercontent.com/example",
  ]) await assert.rejects(latestHostRelease(version, async input => {
    assert.equal(String(input), latestManifest);
    return Response.redirect(location);
  }), /正式版本标签/);
  await assert.rejects(latestHostRelease(version, withManifest(() => Response.redirect("https://example.org/file"))), /跳转/);
});

test("GitHub release checks distinguish rate limits from other forbidden responses", async t => {
  const now = Date.parse("2026-11-24T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  const reset = String(now / 1000 + 3600);
  const check = (status: number, headers: Record<string, string> = {}, body?: string) =>
    latestHostRelease("0.1.3", async () => new Response(body, { status, headers }));
  await assert.rejects(check(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), /GitHub 暂时限制了更新查询.*北京时间 .*19:00:00/);
  await assert.rejects(check(429, { "retry-after": "90", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), /北京时间 .*18:01:30/);
  await assert.rejects(check(403, { "retry-after": "60" }), /北京时间 .*18:01:00/);
  for (const invalid of ["", "invalid", String(now / 1000 - 1)])
    await assert.rejects(check(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": invalid }), /限制了更新查询。请稍后再试/);
  await assert.rejects(check(403, {}, JSON.stringify({ message: "You have exceeded a secondary rate limit." })), /限制了更新查询。请稍后再试/);
  await assert.rejects(check(429), /限制了更新查询。请稍后再试/);
  await assert.rejects(check(403, { "x-ratelimit-remaining": "25", "x-ratelimit-reset": reset }, "Forbidden"), /GitHub 拒绝了本次版本查询/);
});

test("invalid downloads and an archive outside the program allowlist leave staging empty", async () => {
  const root = await temporaryDirectory("whale-host-release-bad-");
  for (const path of ["plugins/gallery/index.ts", "config/config.json", "core/../config/x", "market/CON"]) {
    const bytes = gzipSync(JSON.stringify({ format: 1, version, files: [{ path, size: 1 }] }) + "\nx");
    const request: typeof fetch = async () => new Response(new Uint8Array(bytes));
    await assert.rejects(stageHostRelease(release(bytes), root, request), /路径/);
    await assert.rejects(stageHostRelease({ ...release(bytes), digest: "0".repeat(64) }, root, request), /SHA-256/);
  }
  let calls = 0;
  await assert.rejects(stageHostRelease(release(Buffer.from("a")), root, async () => {
    calls++; return Response.redirect("https://example.org/file");
  }), /跳转/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
});

function git(source: string, ...args: string[]) {
  return execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function writePackage(source: string, version: string, lockVersion = version, rootVersion = version) {
  const pkg = { name: "whalelife", version, type: "module" };
  await writeFile(join(source, "package.json"), JSON.stringify(pkg));
  await writeFile(join(source, "package-lock.json"), JSON.stringify({ ...pkg, version: lockVersion,
    lockfileVersion: 3, packages: { "": { ...pkg, version: rootVersion } } }));
}

async function prepareSource(root: string, version: string) {
  const source = join(root, "source");
  await mkdir(source);
  const tracked: Record<string, string> = Object.fromEntries(hostReleaseRootFiles.map(p => [p, p]));
  Object.assign(tracked, { "core/index.ts": 'console.log("healthy")', "market/catalog.json": "{}", "market/official-releases.json": "[]" });
  for (const [path, value] of Object.entries(tracked)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), value);
  }
  await writePackage(source, version);
  git(source, "init", "--quiet", "-b", "main");
  git(source, "add", "--", ...Object.keys(tracked));
  return source;
}

test("build two identical releases from tracked source and extract a working independent program", async () => {
  const root = await temporaryDirectory("whale-host-bundle-");
  const source = await prepareSource(root, version);
  const unpacked = join(root, "slot"), out1 = join(root, "first"), out2 = join(root, "second");
  await mkdir(unpacked);
  await writeFile(join(source, "core", "private-local-file.ts"), "private");
  await mkdir(join(source, "config")); await writeFile(join(source, "config/config.json"), "private");
  for (const out of [out1, out2]) {
    const report = JSON.parse(execFileSync(process.execPath, [builder, out, source], { encoding: "utf8" }));
    assert.equal(report.path, join(out, filename));
    assert.equal(report.manifestPath, join(out, "whalelife-update.json"));
    const bytes = await readFile(report.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(JSON.parse(await readFile(report.manifestPath, "utf8")), { format: 1, version, size: bytes.length, sha256 });
    assert.equal(report.sha256, sha256);
    assert.equal(report.size, bytes.length);
  }
  const bytes = await readFile(join(out1, filename));
  assert.deepEqual(bytes, await readFile(join(out2, filename)));
  assert.deepEqual(await readFile(join(out1, "whalelife-update.json")), await readFile(join(out2, "whalelife-update.json")));
  await stageHostRelease(release(bytes), unpacked, async (input, init) => {
    assert.equal(init?.redirect, "manual");
    if (String(input) === assetURL) return Response.redirect("https://release-assets.githubusercontent.com/sample");
    assert.equal(String(input), "https://release-assets.githubusercontent.com/sample");
    return new Response(new Uint8Array(bytes));
  });
  assert.deepEqual(await readdir(join(unpacked, "core")), ["index.ts"]);
  assert(!(await readdir(unpacked)).includes("config"));
  assert.equal(execFileSync(process.execPath, [join(unpacked, "core/index.ts")], { encoding: "utf8" }).trim(), "healthy");
  await assert.rejects(stageHostRelease(release(bytes), unpacked), /空的暂存目录/);
});

test("a conflicting release asset is preserved without leaving a mismatched companion", async () => {
  const root = await temporaryDirectory("whale-host-release-collision-");
  const source = await prepareSource(root, version);
  for (const [index, existing] of ["whalelife-update.json", filename].entries()) {
    const out = join(root, "out-" + index);
    await mkdir(out);
    await writeFile(join(out, existing), "previous asset");
    const result = spawnSync(process.execPath, [builder, out, source], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(await readdir(out), [existing]);
    assert.equal(await readFile(join(out, existing), "utf8"), "previous asset");
  }
});

test("ordinary builds reject diverging versions in either lockfile field before writing a bundle", async () => {
  const root = await temporaryDirectory("whale-host-version-lock-");
  const source = await prepareSource(root, version);
  const out = join(root, "out");
  await mkdir(out);
  for (const [top, nested] of [["0.1.0", version], [version, "0.1.0"]]) {
    await writePackage(source, version, top, nested);
    git(source, "add", "package-lock.json");
    const result = spawnSync(process.execPath, [builder, out, source], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /版本/);
    assert.deepEqual(await readdir(out), []);
  }
});

test("release builds use a committed main revision and a version above the deployed baseline and all published stable tags", async () => {
  const root = await temporaryDirectory("whale-host-version-release-");
  const source = await prepareSource(root, "0.1.0");
  git(source, "commit", "-m", "Initial host");
  const initial = git(source, "rev-parse", "HEAD");
  const remote = join(root, "public.git");
  git(root, "clone", "--bare", "--no-hardlinks", source, remote);
  const out = join(root, "out");
  await mkdir(out);
  // Allow only local file transports so a URL or argument regression cannot contact a real repository.
  function build(output: string, repository = remote) {
    return spawnSync(process.execPath, [builder, "--release", output, source], {
      encoding: "utf8", env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url." + pathToFileURL(repository).href + ".insteadOf",
        GIT_CONFIG_VALUE_0: repo + ".git" },
    });
  }
  async function rejected(repository = remote) {
    const result = build(out, repository);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(await readdir(out), []);
  }
  await rejected(); // There are no public tags yet, but users already run 0.1.0.
  git(remote, "update-ref", "refs/tags/v0.9.99", initial);
  git(remote, "update-ref", "refs/tags/v1.0.0-beta.1", initial);
  await writePackage(source, version);
  git(source, "commit", "-am", "Prepare numeric version 0.10.0");
  const commit = git(source, "rev-parse", "HEAD");
  await rejected(); // This revision only exists locally.
  git(source, "push", remote, "HEAD:refs/heads/main");
  await rejected(join(root, "unavailable.git"));
  await writeFile(join(source, "core/index.ts"), 'console.log("changed")');
  await rejected();
  git(source, "add", "core/index.ts");
  await rejected();
  git(source, "restore", "--source=HEAD", "--staged", "--worktree", "core/index.ts");
  // A publisher can still package the reviewed revision after another change lands on main.
  git(source, "switch", "-c", "later-main");
  git(source, "commit", "--allow-empty", "-m", "Subsequent main commit");
  git(source, "push", remote, "HEAD:refs/heads/main");
  git(source, "switch", "main");
  const refs = git(remote, "show-ref");
  const success = build(join(root, "successful"));
  assert.equal(success.status, 0, success.stderr);
  const report = JSON.parse(success.stdout);
  assert.equal(report.tag, "v" + version);
  assert.equal(report.commit, commit);
  const archive = await readFile(join(root, "successful", filename));
  const manifest = JSON.parse(await readFile(join(root, "successful", "whalelife-update.json"), "utf8"));
  assert.deepEqual(manifest, { format: 1, version, size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") });
  assert.equal(git(remote, "show-ref"), refs);
  git(remote, "update-ref", "refs/tags/v" + version, commit);
  await rejected();
  git(remote, "update-ref", "-d", "refs/tags/v" + version);
  git(remote, "update-ref", "refs/tags/v0.10.1", commit);
  await rejected();
});
