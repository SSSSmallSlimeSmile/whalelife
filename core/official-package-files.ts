/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { directoryAt } from "./instance-directory.ts";
import { recoverReplacementDirectories, replacementIdentity, replacementFormat, replacementName,
  retireReplacement, type ReplacementJournal } from "./plugin-replacement-recovery.ts";

export { directoryAt };

export interface OfficialPackageSpec {
  directory: string;
  sha256: string;
  recognitionOnly?: boolean;
  preserve?: readonly string[];
}
export interface OfficialFileState {
  state: "absent" | "installed" | "blocked";
  reason?: string;
}
interface PackageFile { path: string; size: number; sha256: string }
interface Inventory {
  files: PackageFile[];
  byPath: Map<string, PackageFile>;
  directories: Set<string>;
}
const hashPattern = /^[a-f0-9]{64}$/;
const held = new Map<string, Promise<void>>();
const metadata = new Map<string, { stamp: string; inventory: Inventory }>();
const digestCache = new Map<string, { stamp: string; digest: string }>();
const persistent = new Set(["data", "config", "config.json", "config.yml", "config.yaml", "settings.json", ".env"]);

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.normalize("NFC") === value &&
    value.split("/").every(part => part && !/[. ]$/.test(part) && !/[\\<>:"|?*\x00-\x1f]/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) && !/~\d+(?:\.|$)/.test(part));
}
export function isPackageDataPath(path: string, preserve: readonly string[] = []) {
  const lower = path.toLowerCase();
  if (preserve.some(value => lower === value.toLowerCase() || lower.startsWith(value.toLowerCase() + "/"))) return true;
  // Each nested plugin has its own data/config namespace. Libraries may have source files named config.
  const parts = lower.split("/");
  let offset = 0;
  while (parts[offset] === "sub" && parts.length > offset + 2) offset += 2;
  return persistent.has(parts[offset]) || parts[offset].startsWith(".env.");
}
export function inventoryOf(header: Buffer): Inventory {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
  if (value?.format !== 1 || !Array.isArray(value.files) || value.files.length > 150_000) throw Error("发行包清单格式错误");
  const byPath = new Map<string, PackageFile>(), directories = new Set<string>(), spellings = new Map<string, string>();
  let size = 0;
  for (const file of value.files) {
    if (!safePath(file?.path) || !hashPattern.test(file?.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        isPackageDataPath(file.path) || byPath.has(file.path)) throw Error(`发行包文件不合规：${file?.path}`);
    size += file.size;
    if (size > 16 * 1024 ** 3) throw Error("发行包超出大小上限");
    const parts = file.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/"), key = path.toLowerCase();
      if ((spellings.has(key) && spellings.get(key) !== path) || (i < parts.length && byPath.has(path)) ||
          (i === parts.length && directories.has(path))) throw Error(`发行包文件名冲突：${path}`);
      spellings.set(key, path);
      if (i < parts.length) directories.add(path);
    }
    byPath.set(file.path, file);
  }
  if (!byPath.has("plugin.yaml")) throw Error("发行包缺少 plugin.yaml");
  return { files: [...byPath.values()], byPath, directories };
}

// gzip wraps one UTF-8 inventory line followed by each file's exact bytes in inventory order.
async function readPackage(path: string, staging?: string, expected?: Inventory,
  manifests?: Map<string, Buffer>): Promise<Inventory> {
  const compressed = createReadStream(path), gzip = createGunzip({ chunkSize: 256 * 1024 });
  compressed.on("error", error => gzip.destroy(error)).pipe(gzip);
  const header: Buffer[] = [], created = new Set<string>();
  let headerSize = 0, inventory: Inventory | undefined, index = 0, written = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined, hash = createHash("sha256");
  let captured: Buffer[] = [];
  try {
    for await (const chunk of gzip) {
      const bytes = chunk as Buffer;
      let offset = 0;
      if (!inventory) {
        const end = bytes.indexOf(10), part = end < 0 ? bytes : bytes.subarray(0, end);
        headerSize += part.length;
        if (headerSize > 32 * 1024 ** 2) throw Error("发行包清单过大");
        header.push(part);
        if (end < 0) continue;
        inventory = inventoryOf(Buffer.concat(header));
        if (!staging && !manifests) return inventory;
        if (expected && (expected.files.length !== inventory.files.length || expected.files.some((file, i) => {
          const next = inventory!.files[i];
          return next.path !== file.path || next.size !== file.size || next.sha256 !== file.sha256;
        }))) throw Error("解包时发行清单已变化");
        offset = end + 1;
      }
      while (index < inventory.files.length) {
        const file = inventory.files[index];
        if (offset === bytes.length && file.size > written) break;
        const capture = manifests && /^(?:sub\/[^/]+\/)*plugin\.yaml$/.test(file.path);
        if (capture && (file.size > 128 * 1024 || manifests.size >= 256)) throw Error("发行包插件清单过大或子插件过多");
        if (staging && !handle) {
          const target = join(staging!, file.path), parent = dirname(target);
          if (!created.has(parent)) { await mkdir(parent, { recursive: true }); created.add(parent); }
          handle = await open(target, "wx");
        }
        const length = Math.min(bytes.length - offset, file.size - written);
        if (length) {
          const part = bytes.subarray(offset, offset + length);
          hash.update(part);
          if (handle) await handle.writeFile(part);
          if (capture) captured.push(part);
          written += length;
          offset += length;
        }
        if (written === file.size) {
          await handle?.close();
          handle = undefined;
          if (hash.digest("hex") !== file.sha256) throw Error(`发行文件校验失败：${file.path}`);
          if (capture) { manifests!.set(file.path, Buffer.concat(captured)); captured = []; }
          index++;
          written = 0;
          hash = createHash("sha256");
        }
      }
      if (offset !== bytes.length) throw Error("发行包包含清单之外的内容");
    }
    if (!inventory || index !== inventory.files.length) throw Error("发行包内容不完整");
    return inventory;
  } finally {
    compressed.destroy();
    gzip.destroy();
    await handle?.close();
  }
}

/** Stream verified contents and collect only plugin manifests, before any file becomes executable. */
export async function verifiedPackageManifests(root: string, spec: OfficialPackageSpec) {
  const { archive, inventory } = await releaseAt(root, spec);
  const manifests = new Map<string, Buffer>();
  await readPackage(archive, undefined, inventory, manifests);
  return { paths: inventory.byPath, manifests };
}

async function fileStamp(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) throw Error(`不是普通文件或使用了链接：${path}`);
  return { size: info.size, key: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join("/") };
}
export async function digestFile(path: string, expectedSize?: number, fresh = false) {
  const stamp = await fileStamp(path);
  if (expectedSize !== undefined && stamp.size !== BigInt(expectedSize)) return "";
  const previous = digestCache.get(path);
  if (!fresh && previous?.stamp === stamp.key) return previous.digest;
  const hash = createHash("sha256");
  if (stamp.size < 128 * 1024) hash.update(await readFile(path));
  else for await (const bytes of createReadStream(path, { highWaterMark: 512 * 1024 })) hash.update(bytes);
  if ((await fileStamp(path)).key !== stamp.key) throw Error(`校验时文件被修改：${path}`);
  const digest = hash.digest("hex");
  if (digestCache.size >= 150_000) digestCache.clear();
  digestCache.set(path, { stamp: stamp.key, digest });
  return digest;
}

async function releaseAt(root: string, spec: OfficialPackageSpec) {
  if (!/^plugins\/[a-z][a-z0-9-]*(?:\/sub\/[a-z][a-z0-9-]*)*$/.test(spec.directory) || !hashPattern.test(spec.sha256) ||
      spec.preserve?.some(path => !safePath(path))) throw Error("官方插件目录或摘要无效");
  if (spec.recognitionOnly) {
    let archive = fileURLToPath(new URL("../market/inventories/" + spec.sha256 + ".json", import.meta.url));
    let stamp: string;
    try { stamp = (await fileStamp(archive)).key; }
    catch (error) {
      if (!missing(error)) throw error;
      const cache = await directoryAt(root, ".artifacts/official-packages");
      if (!cache) throw error;
      // A manual update check may have saved a newer inventory here. Recovery can use it offline.
      archive = join(cache, spec.sha256 + ".inventory.json");
      stamp = (await fileStamp(archive)).key;
    }
    let entry = metadata.get(archive);
    if (entry?.stamp !== stamp) {
      const bytes = await readFile(archive);
      if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256) throw Error("历史发行清单 SHA-256 校验失败");
      entry = { stamp, inventory: inventoryOf(bytes) };
      metadata.set(archive, entry);
    }
    if (spec.preserve?.length && entry.inventory.files.some(file => isPackageDataPath(file.path, spec.preserve!)))
      throw Error("历史清单包含需保留的用户资料");
    return { cache: join(root, ".artifacts", "official-packages"), archive, inventory: entry.inventory };
  }
  const cache = await directoryAt(root, ".artifacts/official-packages");
  if (!cache) throw Error("尚未取得已验证的发行包");
  const archive = join(cache, spec.sha256 + ".wlpkg.gz");
  let stamp: string;
  try { stamp = (await fileStamp(archive)).key; }
  catch (error) { if (missing(error)) throw Error("尚未取得已验证的发行包"); throw error; }
  let entry = metadata.get(archive);
  if (entry?.stamp !== stamp) {
    if (await digestFile(archive) !== spec.sha256) throw Error("发行包 SHA-256 校验失败");
    entry = { stamp, inventory: await readPackage(archive) };
    if ((await fileStamp(archive)).key !== stamp) throw Error("校验期间发行包被替换");
    metadata.set(archive, entry);
  }
  if (spec.preserve?.length && entry.inventory.files.some(file => isPackageDataPath(file.path, spec.preserve!))) {
    throw Error("发行包包含用户配置或持久数据");
  }
  return { cache, archive, inventory: entry.inventory };
}
function subDirectory(path: string) {
  return /^(?:sub\/[^/]+\/)*sub$/.test(path);
}
type RetainedPaths = { data: string[]; children: string[] };
async function inspectTree(root: string, spec: OfficialPackageSpec, inventory: Inventory, fresh = false,
  retained?: RetainedPaths, partial?: Set<string>): Promise<OfficialFileState> {
  const base = await directoryAt(root, spec.directory);
  if (!base) return { state: "absent" };
  const seen = new Set<string>();
  async function visit(parent: string) {
    for (const item of await readdir(join(base!, parent), { withFileTypes: true })) {
      const path = parent ? parent + "/" + item.name : item.name;
      if (isPackageDataPath(path, spec.preserve)) {
        if (item.isSymbolicLink()) throw Error(`持久目录或配置使用了链接：${path}`);
        retained?.data.push(path);
        continue;
      }
      if (item.isSymbolicLink()) throw Error(`插件目录中存在链接：${path}`);
      if (item.isDirectory()) {
        if (subDirectory(parent) && !inventory.directories.has(path)) {
          retained?.children.push(path);
          continue;
        }
        const containsPreserved = spec.preserve?.some(value => value.toLowerCase().startsWith(path.toLowerCase() + "/"));
        if (!inventory.directories.has(path) && !subDirectory(path) && !containsPreserved) throw Error(`无法确认目录归属：${path}`);
        await visit(path);
      } else {
        if (!item.isFile() || !inventory.byPath.has(path)) throw Error(`无法确认文件归属：${path}`);
        seen.add(path);
      }
    }
  }
  await visit("");
  if (!seen.size) return { state: "absent" };
  const files = partial ? inventory.files.filter(file => seen.has(file.path)) : inventory.files;
  for (const file of files) {
    if (!seen.has(file.path)) throw Error(`缺少发行文件：${file.path}`);
    partial?.add(file.path);
  }
  for (let i = 0; i < files.length; i += 16) {
    await Promise.all(files.slice(i, i + 16).map(async file => {
      if (await digestFile(join(base, file.path), file.size, fresh) !== file.sha256) throw Error(`文件与已审核发行包不一致：${file.path}`);
    }));
  }
  return { state: "installed" };
}
async function serialized<T>(root: string, work: () => Promise<T>) {
  const key = resolve(root).toLowerCase(), previous = held.get(key);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  held.set(key, gate);
  try { await previous; return await work(); }
  finally { release(); if (held.get(key) === gate) held.delete(key); }
}
export async function inspectOfficialFiles(root: string, spec: OfficialPackageSpec): Promise<OfficialFileState> {
  return serialized(root, async () => {
    try {
      await checkPendingReplacement(root, spec.directory, true);
      return await inspectTree(root, spec, (await releaseAt(root, spec)).inventory);
    }
    catch (error) { return { state: "blocked", reason: errorText(error) }; }
  });
}

async function change(root: string, spec: OfficialPackageSpec, install: boolean, interruptedInstall = false) {
  return serialized(root, async () => {
    await checkPendingReplacement(root, spec.directory);
    if (install && spec.recognitionOnly) throw Error("历史清单仅供识别已安装的官方版本。");
    const { archive, cache, inventory } = await releaseAt(root, spec);
    const partial = interruptedInstall ? new Set<string>() : undefined;
    const before = await inspectTree(root, spec, inventory, true, undefined, partial);
    if (before.state === (install ? "installed" : "absent")) return;
    await directoryAt(root, ".artifacts/official-packages", true);
    const staging = await mkdtemp(join(cache, install ? "install-" : "uninstall-"));
    const moved: PackageFile[] = [], made = new Set<string>(), checked = new Set<string>();
    let keepBackup = false;
    try {
      if (install) await readPackage(archive, staging, inventory);
      const base = (await directoryAt(root, spec.directory, install, made))!;
      // Publish the manifest last on install; hide it first on uninstall.
      const files = inventory.files.filter(file => file.path !== "plugin.yaml" && (!partial || partial.has(file.path)));
      const manifest = inventory.byPath.get("plugin.yaml")!;
      if (install) files.push(manifest);
      else if (!partial || partial.has(manifest.path)) files.unshift(manifest);
      for (const file of files) {
        const target = join(base, file.path), backup = join(staging, file.path), parent = dirname(target);
        if (!checked.has(parent)) {
          const relative = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
          if (!await directoryAt(base, relative, install, made)) throw Error(`目标目录已变化：${file.path}`);
          checked.add(parent);
        }
        if (install) {
          // link publishes the complete verified file atomically and never overwrites an existing name.
          await link(backup, target);
        } else {
          if (await digestFile(target, file.size) !== file.sha256) throw Error(`卸载时文件已改变：${file.path}`);
          await mkdir(dirname(backup), { recursive: true });
          await rename(target, backup);
        }
        moved.push(file);
      }
      if (!install) {
        for (const path of [...inventory.directories].sort((a, b) => b.length - a.length)) await removeEmpty(join(base, path));
        await removeEmpty(base);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const file of moved.reverse()) {
        const target = join(root, spec.directory, file.path), backup = join(staging, file.path);
        try {
          if (install) {
            if (await digestFile(target, file.size) !== file.sha256) throw Error("文件已变化");
            await unlink(target);
          } else {
            await directoryAt(root, spec.directory + (file.path.includes("/") ? "/" + file.path.slice(0, file.path.lastIndexOf("/")) : ""), true);
            await link(backup, target);
          }
        } catch (rollback) { failures.push(`${file.path}：${errorText(rollback)}`); }
      }
      if (install) for (const path of [...made].sort((a, b) => b.length - a.length)) await removeEmpty(path);
      if (failures.length) {
        keepBackup = true;
        throw Error(`${errorText(error)}；撤回未完成，备份在 ${staging}：${failures.join("、")}`);
      }
      throw Error(`${errorText(error)}；已撤回本步的 ${moved.length} 项文件改动`);
    } finally {
      if (!keepBackup) await rm(staging, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
async function removeEmpty(path: string) {
  try { await rmdir(path); }
  catch (error: any) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}
export function installOfficialFiles(root: string, spec: OfficialPackageSpec) { return change(resolve(root), spec, true); }
export function uninstallOfficialFiles(root: string, spec: OfficialPackageSpec) { return change(resolve(root), spec, false); }
/** Only for a journaled dependency that was absent before the interrupted install. */
export function rollbackInterruptedInstall(root: string, spec: OfficialPackageSpec) { return change(resolve(root), spec, false, true); }

const liveReplacements = new Set<string>();
export { safePath as validPackagePath };

export async function verifyReplacementTree(root: string, tree: string, spec: OfficialPackageSpec) {
  const retained: RetainedPaths = {data: [], children: []};
  const {inventory} = await releaseAt(root, spec);
  if ((await inspectTree(dirname(tree), {...spec, directory:basename(tree)}, inventory, true, retained)).state !== "installed")
    throw Error("插件程序文件缺失：" + tree);
  return retained;
}

export async function recoverPendingPluginReplacements(root: string) {
  root = resolve(root);
  return serialized(root, async () => {
    const cache = await directoryAt(root, ".artifacts/official-packages");
    return cache ? recoverReplacementDirectories(root, cache, liveReplacements) : [];
  });
}

// A process can exit between the two renames. Even when no manifest is at the live path, a
// pending backup belongs to an installed plugin. Never allow a later install to take its place.
async function checkPendingReplacement(root: string, directory: string, allowLiveRead = false) {
  const cache = await directoryAt(root, ".artifacts/official-packages");
  if (!cache) return;
  const key = replacementName(directory);
  for (const name of await readdir(cache)) {
    if (name !== key && !name.startsWith(key + ".sub.") && !key.startsWith(name + ".sub.")) continue;
    const transaction = join(cache, name);
    if (allowLiveRead && liveReplacements.has(transaction)) continue;
    throw Error("插件更新事务尚未结束，请先处理更新备份：" + transaction);
  }
}

async function vacant(path: string) {
  try { await lstat(path); }
  catch (error) { if (missing(error)) return; throw error; }
  throw Error("目标路径已被占用，已保留原文件：" + path);
}

// Do not follow links while copying data: a failed trial must be reversible within this instance.
async function dataStamp(file: string) {
  const info = await lstat(file, { bigint: true });
  if (!info.isDirectory() && !info.isFile()) throw Error("插件资料包含链接或特殊文件，无法完整备份：" + file);
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join("/");
}
async function copyPluginData(source: string, target: string, stamps: Map<string, string>) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
    filter: async file => {
      stamps.set(file, await dataStamp(file));
      return true;
    },
  });
}

async function replacementPaths(root: string, tree: string, old: OfficialPackageSpec, next: Inventory) {
  const retained = await verifyReplacementTree(root, tree, old);
  const independent: ReplacementJournal["children"] = [];
  const empty: Inventory = {files: [], byPath: new Map(), directories: new Set()};
  for (const path of retained.children) {
    if (!next.directories.has(path)) {
      independent.push({path, identity:await replacementIdentity(join(tree, path))});
      continue;
    }
    // A previous uninstall can leave a data-only directory at the newly bundled child's path.
    const nested: RetainedPaths = { data: [], children: [] }, prefix = path + "/";
    const preserve = old.preserve?.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    try { await inspectTree(tree, {...old, directory:path, preserve}, empty, true, nested); }
    catch (error) { throw Error("新发行包与已有独立子插件目录冲突：" + path + "，" + errorText(error)); }
    for (const name of nested.data) retained.data.push(prefix + name);
    for (const name of nested.children) retained.children.push(prefix + name);
  }
  return {data: retained.data, independent};
}

/** The caller stops the target before switching and stops a failed trial before rollback. */
export async function replaceOfficialFiles(root: string, oldSpec: OfficialPackageSpec, newSpec: OfficialPackageSpec, transactionId?: string) {
  root = resolve(root);
  return serialized(root, async () => {
    if (oldSpec.directory !== newSpec.directory || newSpec.recognitionOnly) throw Error("更新必须替换同一插件的已审核发行包。");
    const directory = oldSpec.directory;
    const preserve = [...new Set([...(oldSpec.preserve ?? []), ...(newSpec.preserve ?? [])])];
    const oldFiles = { ...oldSpec, preserve }, newFiles = { ...newSpec, preserve };
    await checkPendingReplacement(root, directory);
    const old = await releaseAt(root, oldFiles), next = await releaseAt(root, newFiles);
    const base = join(root, directory);
    if (!await directoryAt(root, directory)) throw Error("原版本程序文件缺失，无法安全更新。");
    const {independent} = await replacementPaths(root, base, oldFiles, next.inventory);
    const stage = join(next.cache, replacementName(directory));
    const original = join(stage, "original"), candidate = join(stage, "candidate"), failed = join(stage, "trial");
    const children = new Set<string>();
    let displaced = false, published = false, childSource = candidate;
    let disposition: "pending" | "committed" | "restored" = "pending";
    let cleanupWarning = "";
    let trialIdentity = "";
    const removeBackup = async (keepTrial = false) => {
      const archive = await retireReplacement(stage, next.cache, keepTrial);
      if (keepTrial) cleanupWarning = "试运行文件有其他改动，已将副本保留在 " + archive;
    };
    const restore = async () => {
      if (!displaced) return;
      if (published) {
        if (await directoryAt(root, directory) !== base || await replacementIdentity(base) !== trialIdentity)
          throw Error("更新后目标目录发生变化，已保留更新前备份：" + original);
        await rename(base, failed);
        published = false;
        childSource = failed;
      }
      for (const path of children) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (!await directoryAt(childSource, parent)) throw Error("独立子插件的父目录已变化：" + path);
        await directoryAt(original, parent, true);
        await vacant(join(original, path));
        await rename(join(childSource, path), join(original, path));
        children.delete(path);
      }
      await directoryAt(root, directory.slice(0, directory.lastIndexOf("/")));
      await vacant(base);
      await rename(original, base);
      displaced = false;
    };
    await mkdir(stage);
    liveReplacements.add(stage);
    try {
      await mkdir(candidate);
      trialIdentity = await replacementIdentity(candidate);
      const oldIdentity = await replacementIdentity(base);
      const journal: ReplacementJournal = {
        format: replacementFormat, transactionId, old: oldFiles, next: newFiles, oldIdentity, trialIdentity,
        stageIdentity: await replacementIdentity(stage), parentIdentity: await replacementIdentity(dirname(base)), children: independent,
      };
      await writeFile(join(stage, "transaction.json"), JSON.stringify(journal), { flag: "wx", mode: 0o600, flush: true });
      await readPackage(next.archive, candidate, next.inventory);
      if (!await directoryAt(root, directory) || await replacementIdentity(base) !== oldIdentity) throw Error("更新前插件路径已变化。");
      await rename(base, original);
      displaced = true;
      const retained = await replacementPaths(root, original, oldFiles, next.inventory);
      const identities = new Map(independent.map(child => [child.path, child.identity]));
      if (independent.length !== retained.independent.length || retained.independent.some(child => identities.get(child.path) !== child.identity))
        throw Error("更新前独立子插件目录已变化。");
      const stamps = new Map<string, string>();
      for (const path of retained.data) await copyPluginData(join(original, path), join(candidate, path), stamps);
      // Independently installed children keep the same files, even if they write data during
      // the trial and the parent later rolls back. A new bundle cannot claim an existing child.
      for (const child of independent) {
        const path = child.path;
        if (await replacementIdentity(join(original, path)) !== child.identity) throw Error("独立子插件目录已变化：" + path);
        const target = join(candidate, path);
        await directoryAt(candidate, path.slice(0, path.lastIndexOf("/")), true);
        await vacant(target);
        await rename(join(original, path), target);
        children.add(path);
      }
      for (const [path, stamp] of stamps) {
        if (await dataStamp(path) !== stamp) throw Error("复制期间插件资料已变化，请等待写入结束后再试：" + path);
      }
      if (await replacementIdentity(candidate) !== trialIdentity ||
          (await inspectTree(stage, { ...newFiles, directory: "candidate" }, next.inventory)).state !== "installed")
        throw Error("切换前新版文件已变化。");
      await vacant(base);
      await rename(candidate, base);
      published = true;
      return {
        get cleanupWarning() { return cleanupWarning; },
        rollback: () => serialized(root, async () => {
          if (disposition === "restored") return;
          if (disposition === "committed") throw Error("已确认的更新不能再次回滚。");
          // Preserve unexpected local edits in the failed trial, outside the restored plugin.
          let keepTrial = false;
          if (published) {
            const retainedTrial: RetainedPaths = { data: [], children: [] };
            try {
              await inspectTree(root, newFiles, next.inventory, true, retainedTrial);
              keepTrial = retainedTrial.children.some(path => !children.has(path) && !old.inventory.directories.has(path));
            } catch { keepTrial = true; }
          }
          try {
            await restore();
            disposition = "restored";
            try { await removeBackup(keepTrial); }
            catch (error) { cleanupWarning = "原版本及资料已恢复，临时备份清理失败：" + errorText(error); }
          } finally { liveReplacements.delete(stage); }
        }),
        commit: () => serialized(root, async () => {
          if (disposition === "committed") return;
          if (disposition === "restored") throw Error("更新已撤回。");
          disposition = "committed";
          try {
            await writeFile(join(stage, "committed"), JSON.stringify({stage:journal.stageIdentity, sha256:newFiles.sha256}), {flag:"wx", mode:0o600, flush:true});
            await removeBackup();
          } finally { liveReplacements.delete(stage); }
        }),
      };
    } catch (error) {
      try { await restore(); }
      catch (rollback) { throw Error(errorText(error) + "；恢复未完成，备份在 " + stage + "：" + errorText(rollback)); }
      finally { liveReplacements.delete(stage); }
      try { await removeBackup(); }
      catch (cleanup) { throw Error(errorText(error) + "；临时备份清理失败：" + errorText(cleanup)); }
      throw error;
    }
  });
}
