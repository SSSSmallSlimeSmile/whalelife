/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { decodeHostArchive, hostAssetName, hostManifestName, hostProgramPath, hostReleaseRootFiles } from "../core/host-release.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const officialRepository = "https://github.com/iinukami/whalelife.git";
const initialHostVersion = "0.1.0";
const programPaths = [...hostReleaseRootFiles, "core", "market"];
const gitArgs = source => ["-c", "safe.directory=" + source.replaceAll("\\", "/"), "-C", source];
const compareVersions = (a, b) => a.localeCompare(b, "en", { numeric: true });

function releaseCommit(source) {
  const opts = { encoding: "utf8", windowsHide: true };
  const args = gitArgs(source);
  const commit = execFileSync("git", [...args, "rev-parse", "--verify", "HEAD^{commit}"], opts).trim();
  if (execFileSync("git", [...args, "status", "--porcelain", "--untracked-files=no", "--", ...programPaths], opts).trim())
    throw Error("正式打包前请先提交待发布的程序文件");
  return commit;
}

function checkReleaseVersion(source, commit, version) {
  if (compareVersions(version, initialHostVersion) <= 0)
    throw Error(`正式本体版本 v${version} 必须高于已使用的基线 v${initialHostVersion}`);
  const args = gitArgs(source);
  let refs;
  try {
    refs = execFileSync("git", [...args, "ls-remote", "--refs", officialRepository, "refs/heads/main", "refs/tags/v*"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch { throw Error("无法核对 GitHub 主干和正式版本标签，请恢复连接后重新打包"); }
  let main = "", highest = initialHostVersion;
  for (const line of refs.trim().split(/\r?\n/)) {
    const [oid, ref] = line.split("\t");
    if (ref === "refs/heads/main") main = oid;
    const match = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(ref);
    if (match && compareVersions(match[1], highest) > 0) highest = match[1];
  }
  if (compareVersions(version, highest) <= 0)
    throw Error(`正式本体版本 v${version} 必须高于主仓已使用的 v${highest}`);
  if (!/^[0-9a-f]{40}$/.test(main)) throw Error("无法确定 GitHub 主干提交");
  try { execFileSync("git", [...args, "merge-base", "--is-ancestor", commit, main], { stdio: "pipe", windowsHide: true }); }
  catch { throw Error("请同步 GitHub main 的历史，并确认待发布提交已经合入公开主干"); }
}

// Read Git blobs, independent of local line endings, ignored credentials or development files.
function trackedFiles(source, commit) {
  const args = gitArgs(source);
  const list = commit ? ["ls-tree", "-r", "-z", "--format=%(objectmode) %(objectname) 0%x09%(path)", commit]
    : ["ls-files", "--stage", "-z"];
  const entries = execFileSync("git", [...args, ...list, "--", ...programPaths], { encoding: "utf8" }).split("\0").filter(Boolean);
  const blobs = [];
  for (const entry of entries) {
    const match = /^(100644|100755) ([a-f0-9]+) 0\t(.+)$/.exec(entry);
    if (!match) throw Error("请先解决代码冲突，并移除程序目录中的链接");
    const [, , id, path] = match;
    if (path.split("/").some(p => p.startsWith("."))) continue;
    if (!hostProgramPath(path)) throw Error("不支持的本体包文件名：" + path);
    blobs.push({ id, path });
  }
  const buffer = execFileSync("git", [...args, "cat-file", "--batch"], {
    input: blobs.map(b => b.id + "\n").join(""), maxBuffer: 120 * 1024 ** 2 });
  const files = new Map();
  let offset = 0;
  for (const { id, path } of blobs) {
    const end = buffer.indexOf(10, offset);
    const [oid, type, length] = buffer.toString("ascii", offset, end).split(" ");
    if (oid !== id || type !== "blob" || !/^\d+$/.test(length)) throw Error("无法读取 Git blob：" + path);
    const bytes = buffer.subarray(end + 1, end + 1 + Number(length));
    files.set(path, bytes);
    offset = end + bytes.length + 2;
  }
  return files;
}

async function productionDependencies(files, work) {
  const pkg = JSON.parse(files.get("package.json")), lock = JSON.parse(files.get("package-lock.json"));
  if (!Object.keys(pkg.dependencies ?? {}).length && !Object.keys(pkg.optionalDependencies ?? {}).length) return;
  // This universal bundle supports JavaScript dependencies. Platform-specific packages need their own asset format.
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.dev) continue;
    if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity) ||
        entry.os || entry.cpu || entry.libc || entry.hasInstallScript || entry.link)
      throw Error("通用本体包不支持此运行依赖的来源、平台或安装脚本：" + name);
  }
  await writeFile(join(work, "package.json"), files.get("package.json"));
  await writeFile(join(work, "package-lock.json"), files.get("package-lock.json"));
  const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-bin-links"];
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(p => p && p.endsWith(".js") && existsSync(p));
  execFileSync(npm ? process.execPath : "npm", npm ? [npm, ...args] : args,
    { cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  async function collect(directory) {
    for (const entry of await readdir(join(work, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = directory + "/" + entry.name;
      if (!hostProgramPath(path) || entry.isSymbolicLink() || path.endsWith(".node"))
        throw Error("运行依赖含通用包不支持的文件：" + path);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.set(path, await readFile(join(work, path)));
      else throw Error("不支持的运行依赖文件：" + path);
    }
  }
  await collect("node_modules");
}

async function build(sourceRoot, outputDirectory, official) {
  const source = resolve(sourceRoot);
  const commit = official ? releaseCommit(source) : null;
  const files = trackedFiles(source, commit);
  if (!files.has("package.json") || !files.has("package-lock.json")) throw Error("需在主仓中跟踪 package.json 和锁文件");
  const version = JSON.parse(files.get("package.json")).version, name = hostAssetName(version);
  if (commit) checkReleaseVersion(source, commit, version);
  const work = await mkdtemp(join(tmpdir(), "whalelife-host-build-"));
  try {
    await productionDependencies(files, work);
    const paths = [...files.keys()].sort(), inventory = paths.map(path => ({ path, size: files.get(path).length }));
    const header = Buffer.from(JSON.stringify({ format: 1, version, files: inventory }) + "\n");
    const raw = Buffer.concat([header, ...paths.map(path => files.get(path))]);
    decodeHostArchive(raw, version);
    const archive = gzipSync(raw, { level: 9 });
    if (archive.length > 40 * 1024 ** 2) throw Error("压缩后的本体包超出大小上限");
    const output = join(resolve(outputDirectory), name), manifestPath = join(dirname(output), hostManifestName);
    const size = archive.length, sha256 = createHash("sha256").update(archive).digest("hex");
    const manifest = { format: 1, version, size, sha256 };
    const stagedArchive = join(work, name), stagedManifest = join(work, hostManifestName);
    await writeFile(stagedArchive, archive);
    await writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + "\n");
    await mkdir(dirname(output), { recursive: true });
    // The manifest is published last. Concurrent builds may each create an archive, but only
    // the owner of the fixed manifest can finish. A losing build removes only its new archive.
    await copyFile(stagedArchive, output, constants.COPYFILE_EXCL);
    try {
      await copyFile(stagedManifest, manifestPath, constants.COPYFILE_EXCL);
    } catch (error) {
      await unlink(output);
      throw error;
    }
    return { path: output, manifestPath, size, sha256, ...(commit ? { tag: "v" + version, commit } : {}) };
  } finally {
    if (dirname(work) !== resolve(tmpdir())) throw Error("临时依赖目录路径无效");
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function buildHostRelease(sourceRoot, outputDirectory) {
  return (await build(sourceRoot, outputDirectory, false)).path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), official = argv[0] === "--release";
  const [out, source = project, extra] = official ? argv.slice(1) : argv;
  if (!out || out.startsWith("--") || extra) throw Error("用法：node tools/build-host-release.mjs [--release] <输出目录> [源码目录]");
  const result = await build(source, out, official);
  console.log(JSON.stringify(result));
}
