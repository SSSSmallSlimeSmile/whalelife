/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const repository = "https://github.com/iinukami/whalelife";
const endpoint = "https://api.github.com/repos/iinukami/whalelife/releases/latest";
const githubCDNs = new Set(["https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"]);
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const compressedLimit = 40 * 1024 ** 2;
const expandedLimit = 120 * 1024 ** 2;
const headerLimit = 2 * 1024 ** 2;
const unzip = promisify(gunzip);
export interface HostRelease { version: string; url: string; digest: string; size: number }
export class GitHubReleaseQueryError extends Error {}

export function hostAssetName(version: string) {
  if (!versionPattern.test(version)) throw Error("本体版本号无效");
  return `whalelife-v${version}.wlhost.gz`;
}
function downloadURL(version: string) {
  return `${repository}/releases/download/v${version}/${hostAssetName(version)}`;
}
function validateRelease(release: HostRelease) {
  if (!versionPattern.test(release.version) || release.url !== repository + "/releases/tag/v" + release.version ||
      !/^[a-f0-9]{64}$/.test(release.digest) || !Number.isSafeInteger(release.size) ||
      release.size <= 0 || release.size > compressedLimit) throw Error("本体发行附件大小、来源或 SHA-256 无效");
}
async function boundedBytes(response: Response, limit: number) {
  if (!response.body) throw Error("GitHub 响应为空");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw Error("GitHub 响应超过大小上限");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

async function githubAccessMessage(response: Response) {
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  const retry = response.headers.get("retry-after") ?? "";
  const retrySeconds = /^\d{1,10}$/.test(retry) ? Number(retry) : undefined;
  let limited = response.status === 429 || exhausted || retrySeconds !== undefined;
  if (limited) {
    await response.body?.cancel();
  } else if (response.body) {
    // GitHub can report a secondary limit only in the JSON message.
    try {
      const { message } = JSON.parse((await boundedBytes(response, 16 * 1024)).toString("utf8"));
      limited = typeof message === "string" && /\brate limit(?:ed|ing)?\b/i.test(message);
    } catch { /* An unreadable 403 still means access was denied. */ }
  }
  const alternative = "也可查看「GitHub 正式发行版」。";
  if (!limited) return "GitHub 拒绝了本次版本查询（HTTP 403）。请稍后再试，" + alternative;
  const now = Date.now();
  const reset = response.headers.get("x-ratelimit-reset") ?? "";
  const retryAt = retrySeconds !== undefined ? now + retrySeconds * 1000 :
    exhausted && /^\d{1,10}$/.test(reset) ? Number(reset) * 1000 : 0;
  const time = retryAt > now ? new Date(retryAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }) : "";
  return "GitHub 暂时限制了更新查询。" + (time ? `请在北京时间 ${time} 后再试，` : "请稍后再试，") + alternative;
}

/** A missing first Release is normal. An unreachable or malformed release is a check failure. */
export async function latestHostRelease(current: string, request: typeof fetch = fetch): Promise<HostRelease | null> {
  if (!versionPattern.test(current)) throw Error("当前本体版本号无效");
  const response = await request(endpoint, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200) {
    if (response.status === 403 || response.status === 429)
      throw new GitHubReleaseQueryError(await githubAccessMessage(response));
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new GitHubReleaseQueryError(`GitHub 发行服务返回 HTTP ${response.status}，请稍后再试。`);
  }
  const meta = JSON.parse((await boundedBytes(response, headerLimit)).toString("utf8"));
  if (meta?.draft === true || meta?.prerelease === true) return null;
  if (meta?.draft !== false || meta?.prerelease !== false || typeof meta.tag_name !== "string" ||
      !meta.tag_name.startsWith("v")) throw Error("GitHub 正式发行信息无效");
  const version: string = meta.tag_name.slice(1), name = hostAssetName(version);
  const parts = current.split(".").map(Number);
  const difference = version.split(".").map((v, i) => Number(v) - parts[i]).find(n => n !== 0) ?? 0;
  if (difference <= 0) return null;
  const matches = Array.isArray(meta.assets) ? meta.assets.filter((a: any) => a?.name === name) : [];
  const asset = matches[0];
  if (matches.length !== 1 || asset.state !== "uploaded" || asset.browser_download_url !== downloadURL(version) ||
      typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:")) throw Error("此正式版本缺少可校验的本体发行附件");
  const release = { version, url: meta.html_url, size: asset.size, digest: asset.digest.slice(7) };
  validateRelease(release);
  return release;
}

async function download(release: HostRelease, request: typeof fetch) {
  const source = downloadURL(release.version), signal = AbortSignal.timeout(180_000);
  let url = new URL(source);
  for (let i = 0; i < 6; i++) {
    const response = await request(url, { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" }, signal });
    if (response.status === 200) {
      const bytes = await boundedBytes(response, release.size);
      if (bytes.length !== release.size || createHash("sha256").update(bytes).digest("hex") !== release.digest)
        throw Error("本体发行包大小或 SHA-256 校验失败");
      return bytes;
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      throw Error(`获取本体发行包失败（HTTP ${response.status}）`);
    url = new URL(location, url);
    if (url.username || url.password || !(githubCDNs.has(url.origin) || url.href === source))
      throw Error("拒绝跳转至非 GitHub 发行附件地址");
  }
  throw Error("GitHub 发行附件重定向次数过多");
}

export const hostReleaseRootFiles = ["package.json", "package-lock.json", "LICENSE", "LICENSE-ADDITIONAL", "NOTICE.md", "THIRD_PARTY_NOTICES.md"];
const roots = new Set(hostReleaseRootFiles);
export function hostProgramPath(path: string) {
  if (typeof path !== "string" || path.length > 650 || !path.split("/").every(part =>
      /^[\w@+-][\w.@+-]{0,159}$/.test(part) && !part.endsWith(".") &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) return false;
  return roots.has(path) || path.startsWith("core/") || path.startsWith("market/") || path.startsWith("node_modules/");
}

/** Validate the entire inventory and locked dependencies before the first filesystem write. */
export function decodeHostArchive(raw: Buffer, version: string) {
  const end = raw.subarray(0, headerLimit + 1).indexOf(10);
  if (end < 0 || raw.length > expandedLimit) throw Error("本体包清单过大或不完整");
  const header = JSON.parse(raw.subarray(0, end).toString("utf8"));
  if (header?.format !== 1 || header.version !== version || !Array.isArray(header.files) || header.files.length > 10_000)
    throw Error("本体包格式或版本不匹配");
  const files = new Map<string, Buffer>(), spelling = new Map<string, string>(), directories = new Set<string>();
  let offset = end + 1;
  for (const item of header.files) {
    const path = item?.path, size = item?.size;
    if (!hostProgramPath(path) || !Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 ** 2 ||
        offset + size > raw.length) throw Error("本体包包含无效文件或路径");
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), key = prefix.toLowerCase();
      if ((spelling.has(key) && spelling.get(key) !== prefix) || files.has(prefix) ||
          (i === parts.length && directories.has(prefix))) throw Error("本体包文件名冲突");
      spelling.set(key, prefix);
      if (i < parts.length) directories.add(prefix);
    }
    files.set(path, raw.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== raw.length || ![...roots, "core/index.ts", "market/catalog.json", "market/official-releases.json"].every(p => files.has(p)))
    throw Error("本体包缺少必需文件或长度不符");
  const pkg = JSON.parse(files.get("package.json")!.toString("utf8"));
  const lock = JSON.parse(files.get("package-lock.json")!.toString("utf8"));
  if (pkg.name !== "whalelife" || pkg.version !== version || lock.name !== pkg.name || lock.version !== version ||
      lock.lockfileVersion !== 3 || lock.packages?.[""]?.version !== version) throw Error("本体文件与发行版本不一致");
  const packages = new Set<string>();
  for (const [dir, spec] of Object.entries<any>(lock.packages)) {
    if (!dir || spec.dev) continue;
    const manifest = files.get(dir + "/package.json");
    if (!manifest && spec.optional) continue;
    if (!dir.startsWith("node_modules/") || !manifest || JSON.parse(manifest.toString("utf8")).version !== spec.version)
      throw Error("本体包缺少锁定的运行依赖，或依赖版本不匹配");
    packages.add(dir);
  }
  for (const path of files.keys()) {
    if (!path.startsWith("node_modules/")) continue;
    const parts = path.split("/"), start = parts.lastIndexOf("node_modules") + 1;
    const end = start + (parts[start]?.startsWith("@") ? 2 : 1);
    if (end >= parts.length || !packages.has(parts.slice(0, end).join("/"))) throw Error("本体包包含未锁定的依赖");
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!packages.has("node_modules/" + name)) throw Error("本体包缺少直接运行依赖");
  }
  return files;
}

/** The supervisor exclusively owns the fresh staging directory and discards it on any failure. */
export async function stageHostRelease(release: HostRelease, destination: string, request: typeof fetch = fetch): Promise<void> {
  validateRelease(release);
  const root = resolve(destination);
  if (resolve(await realpath(root)) !== root || !(await lstat(root)).isDirectory() || (await readdir(root)).length)
    throw Error("本体发行包需要独立、空的暂存目录");
  const raw = await unzip(await download(release, request), { maxOutputLength: expandedLimit });
  const files = decodeHostArchive(raw, release.version);
  for (const [path, bytes] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    if (resolve(await realpath(dirname(target))) !== dirname(target)) throw Error("本体暂存目录包含链接");
    await writeFile(target, bytes, { flag: "wx" });
  }
}
