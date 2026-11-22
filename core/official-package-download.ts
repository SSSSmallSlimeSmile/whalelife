/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestFile, directoryAt } from "./official-package-files.ts";

export interface OfficialAsset {
  repository: string;
  assetUrl: string;
  sizeBytes: number;
  sha256: string;
}

const cdns = new Set(["https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"]);
const redirects = new Set([301, 302, 303, 307, 308]);
const pending = new Map<string, Promise<void>>();

function assetLocation(asset: OfficialAsset): URL {
  let repo: URL, url: URL;
  try {
    repo = new URL(asset.repository);
    url = new URL(asset.assetUrl);
  } catch {
    throw Error("GitHub 发行包地址无效。");
  }
  const repoPath = repo.pathname.replace(/\/$/, "");
  const prefix = repoPath + "/releases/download/";
  if (repo.origin !== "https://github.com" || repo.username || repo.password || repo.hash || repo.search ||
      !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repoPath) ||
      url.origin !== repo.origin || url.username || url.password || url.hash || url.search ||
      !url.pathname.startsWith(prefix) || !/^[^/]+\/[^/]+$/.test(url.pathname.slice(prefix.length)) ||
      /%(?:2f|5c|25|00)/i.test(url.pathname)) {
    throw Error("发行包地址必须指向登记的 GitHub 仓库和具体发行版本。");
  }
  return url;
}

async function openAsset(source: URL, signal: AbortSignal): Promise<Response> {
  let url = source;
  for (let hops = 0; hops <= 5; hops++) {
    const response = await fetch(url, {
      redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" }, signal,
    });
    if (response.status === 200 && response.body) return response;
    await response.body?.cancel();
    if (!redirects.has(response.status)) throw Error(`获取 GitHub 发行包失败（HTTP ${response.status}）。`);
    const location = response.headers.get("location");
    if (!location) throw Error("GitHub 发行包缺少重定向地址。");
    const next = new URL(location, url);
    if (next.username || next.password || !(cdns.has(next.origin) ||
        (next.origin === source.origin && next.pathname === source.pathname))) {
      throw Error("拒绝跳转到未登记的发行包下载地址。");
    }
    url = next;
  }
  throw Error("GitHub 发行包重定向次数过多。");
}

type Fingerprint = Pick<OfficialAsset, "sha256" | "sizeBytes">;
type Populate = (write: (chunk: Uint8Array) => Promise<void>, cache: string) => Promise<void>;
type CacheExtension = ".wlpkg.gz" | ".inventory.json";

async function populateCache(root: string, asset: Fingerprint, populate: Populate, extension: CacheExtension) {
  const cache = (await directoryAt(root, ".artifacts/official-packages", true))!;
  const target = join(cache, asset.sha256 + extension);
  try {
    if (await digestFile(target, asset.sizeBytes) === asset.sha256) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(cache, ".downloading-" + randomUUID());
  const file = await open(temporary, "wx", 0o600);
  const identity = await file.stat({ bigint: true });
  const ownTemporary = async () => {
    if (!await directoryAt(root, ".artifacts/official-packages")) return false;
    try {
      const current = await lstat(temporary, { bigint: true });
      return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  let published = false;
  try {
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      await populate(async chunk => {
        bytes += chunk.byteLength;
        if (bytes > asset.sizeBytes) throw Error("发行包超出已验证大小。");
        hash.update(chunk);
        await file.writeFile(chunk);
      }, cache);
      if (bytes !== asset.sizeBytes) throw Error("发行包不完整。");
      if (hash.digest("hex") !== asset.sha256) throw Error("发行包 SHA-256 校验失败。");
    } finally {
      await file.close();
    }
    if (!await ownTemporary()) throw Error("下载期间发行包临时文件已变化。");
    // Rename on the same volume publishes all verified bytes at once, including repairs of a broken cache.
    await rename(temporary, target);
    published = true;
  } finally {
    if (!published && await ownTemporary()) await unlink(temporary);
  }
}

/** Publish verified bytes under their content address, or reuse an already verified cache entry. */
export async function ensureCachedPackage(root: string, asset: Fingerprint, populate: Populate,
  extension: CacheExtension = ".wlpkg.gz"): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
    throw Error("官方发行包大小或 SHA-256 无效。");
  }
  const host = resolve(root);
  const key = join(host, asset.sha256 + extension);
  const previous = pending.get(key);
  if (previous) return previous;
  const work = populateCache(host, asset, populate, extension);
  pending.set(key, work);
  try { await work; }
  finally { pending.delete(key); }
}

/** Fetch only a release pinned by the local registry. Package files are unpacked separately by the installer. */
export async function ensureOfficialPackage(root: string, asset: OfficialAsset, shutdown?: AbortSignal): Promise<void> {
  shutdown?.throwIfAborted();
  const source = assetLocation(asset);
  return ensureCachedPackage(root, asset, async write => {
    const controller = new AbortController();
    const idle = setTimeout(() => controller.abort(), 60_000).unref();
    const signals = [controller.signal, AbortSignal.timeout(30 * 60_000)];
    if (shutdown) signals.push(shutdown);
    const signal = AbortSignal.any(signals);
    try {
      const response = await openAsset(source, signal);
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.sizeBytes)) {
        throw Error("GitHub 发行包大小与已验证版本不一致。");
      }
      const reader = response.body!.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          idle.refresh();
          await write(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      shutdown?.throwIfAborted();
      if (signal.aborted) throw Error("下载 GitHub 发行包超时，请重试。");
      if (error instanceof TypeError) throw Error("无法完整读取 GitHub 发行包，请检查网络后重试。");
      throw error;
    } finally {
      clearTimeout(idle);
      controller.abort();
    }
  });
}
