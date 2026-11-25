/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { directoryAt } from "./instance-directory.ts";

const area = ".whalelife-updates";
const format = "whalelife.host-backup/1";
const retired = "whalelife.host-backup/retired/1";
export const validHostBackupSlot = (value: unknown): value is string =>
  typeof value === "string" && /^backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const preparing = /^\.backup-(?:slot-)?preparing-[A-Za-z0-9]{6}$/;

function backupName(slot?: string) {
  if (slot === undefined) return "backup"; // Existing installations and their interrupted updates.
  if (!validHostBackupSlot(slot)) throw Error("本体更新备份位置无效。");
  return slot;
}

async function marker(path: string, expected: string) {
  const info = await stat(path);
  return !!info && info.isFile() && info.nlink === 1 && info.size === Buffer.byteLength(expected) &&
    await readFile(path, "utf8") === expected;
}
const reserved = new Set([area, ".git", ".artifacts", "core", "market", "node_modules", "runtime", "tools", "tests",
  "architecture", "start.bat", "package.json", "package-lock.json"]);
type BackupItem = { path: string; present: boolean };

async function stat(path: string) {
  return lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
}

function relativeData(root: string, path: string) {
  const name = relative(root, resolve(root, path)).split(sep).join("/");
  const first = name.split("/")[0].toLowerCase();
  if (!name || first === ".." || isAbsolute(name) || reserved.has(first) || first.startsWith("."))
    throw Error("资料路径位于实例外或与程序目录重叠，无法创建可回滚的本体更新。");
  return name;
}

async function backupPaths(root: string) {
  await directoryAt(root, "config");
  const configFile = join(root, "config/config.json");
  if (!(await lstat(configFile)).isFile()) throw Error("配置文件不是可备份的普通文件。");
  const config = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, ""));
  const names = ["plugins", "config", "memory", "data", "personas", "backups", "logs/executions", config.memory.root,
    ...Object.values<{file: string}>(config.personas).map(p => p.file)];
  const paths: string[] = [];
  for (const name of [...new Set(names.map(p => relativeData(root, p)))].sort((a,b) => a.length-b.length)) {
    if (!paths.some(parent => name === parent || name.startsWith(parent + "/"))) paths.push(name);
  }
  return paths;
}

async function validateBackup(root: string, slot?: string) {
  const base = await directoryAt(root, area + "/" + backupName(slot));
  if (!base) return;
  const owner = join(base, "owner");
  if (!await marker(owner, format))
    throw Error("现有备份目录归属不明，请保留现场。");
  return base;
}

export async function prepareHostBackup(root: string, slot?: string) {
  const parent = (await directoryAt(root, area, true))!;
  const paths = await backupPaths(root);
  const committed = join(parent, backupName(slot));
  if (await stat(committed)) throw Error("上次本体更新的资料备份尚待处理。");
  // The original 0.1.1 manager can still be finishing cleanup of its own staging area.
  const base = await mkdtemp(join(parent, slot ? ".backup-slot-preparing-" : ".backup-preparing-"));
  await writeFile(join(base, "owner"), format, { flag: "wx", mode: 0o600 });
  await mkdir(join(base, "saved"));
  await mkdir(join(base, "displaced"));
  await mkdir(join(base, "restoring"));
  const items: BackupItem[] = [];
  for (const path of paths) {
    const source = join(root, path);
    const parentPath = dirname(path).split(sep).join("/");
    await directoryAt(root, parentPath === "." ? "" : parentPath);
    const exists = !!await stat(source);
    if (exists) await cp(source, join(base, "saved", String(items.length)), {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
      filter: async entry => {
        const info = await lstat(entry);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          throw Error("资料目录含有链接或特殊文件，无法完整备份：" + relative(root, entry));
        return true;
      },
    });
    items.push({ path, present: exists });
  }
  // The supervisor cannot start the trial until this manifest is complete.
  await writeFile(join(base, "items.json"), JSON.stringify(items), { flag: "wx", mode: 0o600 });
  await rename(base, committed);
}

function unchanged(before: BigIntStats, after: BigIntStats) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function fileDigest(path: string, before: BigIntStats, buffer: Buffer) {
  const file = await open(path, "r");
  try {
    if (!unchanged(before, await file.stat({bigint:true}))) throw Error("校验前文件已变化：" + path);
    const hash = createHash("sha256");
    let remaining = before.size;
    while (remaining > 0n) {
      const count = remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length;
      const { bytesRead } = await file.read(buffer, 0, count, null);
      if (!bytesRead) throw Error("校验时文件提前结束：" + path);
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    if (!unchanged(before, await file.stat({bigint:true}))) throw Error("校验期间文件已变化：" + path);
    return hash.digest("hex");
  } finally { await file.close(); }
}

// A separate plugin service may still be running from this tree. Skip its rename only
// after comparing both complete trees, including empty directories and large model files.
async function verifyPluginSnapshot(live: string, saved: string, buffer: Buffer): Promise<void> {
  const [a,b] = await Promise.all([lstat(live,{bigint:true}), lstat(saved,{bigint:true})]);
  const mismatch = () => Error("当前插件与更新前的快照不一致：" + live);
  if (a.mode !== b.mode || a.isSymbolicLink() || b.isSymbolicLink()) throw mismatch();
  if (a.isDirectory() && b.isDirectory()) {
    const names = await readdir(live);
    const expected = new Set(await readdir(saved));
    if (names.length !== expected.size || names.some(name => !expected.has(name))) throw mismatch();
    for (const name of names) await verifyPluginSnapshot(join(live,name), join(saved,name), buffer);
  } else if (a.isFile() && b.isFile()) {
    if (a.size !== b.size || await fileDigest(live,a,buffer) !== await fileDigest(saved,b,buffer)) throw mismatch();
  } else throw mismatch();
  if (!unchanged(a,await lstat(live,{bigint:true})) || !unchanged(b,await lstat(saved,{bigint:true})))
    throw Error("核对插件快照期间目录或文件已变化：" + live);
}

export async function restoreHostBackup(root: string, slot?: string) {
  const name = backupName(slot);
  const base = await validateBackup(root, slot);
  if (!base) throw Error("缺少更新前的资料备份，已停止恢复。");
  if (await stat(join(base, "retired"))) throw Error("本体更新引用了已退役的备份，请保留现场。");
  for (const child of ["saved", "displaced", "restoring"]) {
    if (!await directoryAt(root, area + "/" + name + "/" + child)) throw Error("资料备份目录不完整：" + name);
  }
  const items: BackupItem[] = JSON.parse(await readFile(join(base, "items.json"), "utf8"));
  for (const [i, item] of items.entries()) {
    if (typeof item.present !== "boolean" || relativeData(root, item.path) !== item.path) throw Error("备份清单无效。");
    const target = join(root, item.path), saved = join(base, "saved", String(i)), displaced = join(base, "displaced", String(i));
    const restoring = join(base, "restoring", String(i));
    const parent = dirname(item.path).split(sep).join("/");
    await directoryAt(root, parent === "." ? "" : parent, item.present);
    if (item.present && !(await stat(saved))) {
      if (!(await stat(restoring))?.isFile() || !(await stat(target))) throw Error("原始备份或恢复记录缺失：" + item.path);
      continue; // Already renamed back during an earlier interrupted restore.
    }
    if (await stat(target)) {
      try { await rename(target, displaced); }
      catch (error) {
        if (item.path !== "plugins" || !item.present || !busy(error) || await stat(displaced)) throw error;
        try {
          await verifyPluginSnapshot(target, saved, Buffer.allocUnsafe(256 * 1024));
        } catch (comparison) {
          throw Error(`插件目录无法移动（${(error as NodeJS.ErrnoException).code}），保留当前目录和快照。` +
            (comparison instanceof Error ? comparison.message : String(comparison)), {cause: error});
        }
        continue; // The installed tree already holds the saved bytes. Keep the snapshot until the old host is serving.
      }
    }
    if (item.present) {
      await writeFile(restoring, "", {mode: 0o600});
      await rename(saved, target);
    }
  }
}

// Called only by the manager after the selected worker is serving and before it
// accepts the next transaction. A locked descendant need not be renamed or removed.
export async function retireHostBackup(root: string, slot?: string) {
  const parent = await directoryAt(root, area);
  if (!parent) return;
  const selected = backupName(slot);
  for (const entry of await readdir(parent, {withFileTypes:true})) {
    if (!entry.isDirectory() || (entry.name !== selected && !preparing.test(entry.name))) continue;
    const base = join(parent,entry.name), label = join(base,"retired");
    if (await marker(label,retired)) continue;
    if (!await marker(join(base,"owner"),format)) {
      if (entry.name === selected) throw Error("现有备份目录归属不明，已保留现场。");
      continue;
    }
    await writeFile(label, retired, {flag:"wx",mode:0o600});
  }
}

// The original v0.1.1 manager can recursively delete its fixed /backup after we acknowledge
// service, including its owner file before a locked descendant. Keep the retirement proof
// outside that tree, bound to this directory object, never to a future directory at the same path.
const stockReceipt = /^stock-backup-(owned|verify)-([a-f0-9]+-[a-f0-9]+-[a-f0-9]+)$/;
function busy(error: unknown) {
  return ["EBUSY","EPERM","EACCES","ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "");
}
async function stockIdentity(base: string) {
  const info = await lstat(base, {bigint:true}).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  if (!info?.isDirectory() || info.isSymbolicLink() || !info.ino || info.birthtimeNs <= 0n) return;
  return [info.dev, info.ino, info.birthtimeNs].map(n => n.toString(16)).join("-");
}
async function emptyReceipt(path: string) {
  try { await writeFile(path, "", {flag:"wx", mode:0o600}); }
  catch (error: any) { if (error.code !== "EEXIST" || !await marker(path, "")) throw error; }
}
export async function retireStockHostBackup(root: string) {
  const base = await directoryAt(root, area + "/backup");
  if (!base) return;
  const identity = await stockIdentity(base);
  if (!identity) return;
  let status = "owned";
  try { if (!await marker(join(base,"owner"),format)) return; }
  catch (error) {
    if (!busy(error)) throw error;
    // An unreadable owner is never an authorization to delete. Recheck when it unlocks.
    status = "verify";
  }
  if (await stockIdentity(base) === identity)
    await emptyReceipt(join(dirname(base), "stock-backup-" + status + "-" + identity));
}
async function collectStockReceipt(parent: string, name: string, match: RegExpMatchArray) {
  const receipt = join(parent,name), base = join(parent,"backup");
  if (!await marker(receipt,"")) return false;
  const [, status, identity] = match;
  if (await stockIdentity(base) === identity) {
    if (status === "verify") {
      if (await marker(join(base,"owner"),format) && await stockIdentity(base) === identity) {
        await emptyReceipt(join(parent,"stock-backup-owned-" + identity));
        await unlink(receipt);
        return true;
      }
    } else await rm(base,{recursive:true,force:true});
  }
  await unlink(receipt);
  return false;
}

// New transactions always use a fresh slot. Only a completed, marked snapshot
// can enter this path, even if a new trial starts during a slow filesystem call.
export async function collectRetiredHostBackups(root: string) {
  const parent = await directoryAt(root, area);
  if (!parent) return false;
  let pending = false;
  for (const entry of await readdir(parent, {withFileTypes:true})) {
    const receipt = entry.isFile() && stockReceipt.exec(entry.name);
    if (receipt) {
      try { if (await collectStockReceipt(parent,entry.name,receipt)) pending = true; }
      catch (error: any) {
        if (busy(error)) pending = true;
        else if (error.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!entry.isDirectory() || !(entry.name === "backup" || validHostBackupSlot(entry.name) || preparing.test(entry.name))) continue;
    const base = join(parent,entry.name), owner = join(base,"owner"), label = join(base,"retired");
    try {
      if (!await marker(label,retired)) continue;
      const names = await readdir(base);
      if (!await marker(owner,format)) {
        // Cleanup can be interrupted after unlinking owner. Never remove unknown contents.
        if (names.some(name => name !== "retired")) continue;
      } else {
        for (const name of names) {
          if (name !== "owner" && name !== "retired") await rm(join(base,name), {recursive:true, force:true});
        }
        await unlink(owner);
      }
      await unlink(label);
      await rmdir(base);
    } catch (error: any) {
      if (error.code === "ENOENT") continue;
      if (!busy(error)) throw error;
      pending = true;
    }
  }
  return pending;
}

export async function discardHostBackup(root: string) {
  await retireHostBackup(root);
  await collectRetiredHostBackups(root);
}
