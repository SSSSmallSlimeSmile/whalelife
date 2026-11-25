/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directoryAt } from "./instance-directory.ts";
import { readHostUpdateState } from "./host-supervisor.ts";

// Git v0.1.1, commit afe281b. Also accept Git's whole-file CRLF checkout.
const stock: Record<string, string> = {
  "index.ts": "a92445a4f0fd2a4a684cfcd5fc355ea1a7730632a4bdf7a2d3474bcb5b3adc80",
  "host-child.ts": "4531755def175317ce66593c72831bd4dc08f172100c5a451a4a3b671b380962",
  "host-supervisor.ts": "624026aa456e4d7a7cd7ebb08486678fbc69d212499bb2109118e7a861bc3bbd",
  "host-update-backup.ts": "49e64093c0e5268b9b2dab066a235d9925edb6d2135c83816d882409dc0f6882",
  "host-updates.ts": "5eceab2e33906981d64be4b2896af863e8f9c2424d1714180aeed046b5478b64",
  "log-output.ts": "c27f7e11f0da9d8236705122a603ddbdf9af714c484c4c73aade3ebec2762355",
  "process-lifecycle.ts": "8d753e7daa99eab03c6a4881fc43ba4c95f293cf1adfe37b2a1c5498096aa04a",
  "official-package-files.ts": "72df223237ce728254191f1992609419f4b0a1f4da5a5f52ab945f1d332f4c3e",
};

const launcherFiles = ["host-supervisor.ts", "host-child.ts", "host-launcher-bridge.ts", "host-launcher-check.ts",
  "host-update-backup.ts", "instance-directory.ts", "log-output.ts", "process-lifecycle.ts"];
// Pin the code that stays with the original installation. Its digest is checked in the release tests.
const previousLauncher = "3f75eb515e5ee4e08014e22d8182e3c241e1ef8d171ee3cc9c2d757e0391f876";
export const launcherBundleDigest = "28c69e5d30a51a6ba32015b6ece18d3597226ac0b973e9d2a5f0ab7b545a6ac7";
const supervisor = "host-supervisor.ts", child = "host-child.ts";
const backupModule = "host-update-backup.ts";
const backupRevisions = new Set([
  "cb090df66a171df59afa53507ee0ce3fdfc30b23553b4652b2ab8916c09c62d8", // ef3cf56, first versioned backup slots
  "35afac03f2dffd4ecedfcd34ab7168e31e7552228b3150f21d779319b35686de", // official v0.1.2–v0.1.5
]);
const entryHeader = "/*! Copyright (c) 2026 iinukami and contributors. SPDX-License-Identifier: AGPL-3.0-only. See LICENSE-ADDITIONAL. */\n";
const publishedPath = (bundle: string) => ".whalelife-updates/launchers/" + bundle;
const sourceDir = dirname(fileURLToPath(import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const matchesStock = (name: string, bytes: Buffer) => {
  if (hash(bytes) === stock[name]) return true;
  const text = bytes.toString("utf8");
  return !/(?<!\r)\n/.test(text) && hash(Buffer.from(text.replaceAll("\r\n", "\n"))) === stock[name];
};

async function ordinaryFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
    throw Error("启动器文件类型或大小异常：" + path);
  return readFile(path);
}

export async function readLauncherBundle(directory: string) {
  const files = new Map<string, Buffer>();
  const fingerprint = createHash("sha256");
  for (const name of launcherFiles) {
    const bytes = await ordinaryFile(join(directory, name));
    // Git may check out CRLF. Install the exact same canonical bytes as the official archive.
    const canonical = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
    fingerprint.update(name + "\0" + hash(canonical) + "\n");
    files.set(name, canonical);
  }
  const actual = fingerprint.digest("hex");
  if (actual !== launcherBundleDigest) throw Error("发行包的启动器内容与已验证清单不符，实际 SHA-256 为 " + actual);
  return files;
}

async function writeNew(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o644);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

async function publishBundle(root: string, files: Map<string, Buffer>, bundle = launcherBundleDigest) {
  const area = ".whalelife-updates/launchers";
  const parent = (await directoryAt(root, area, true))!;
  const relative = publishedPath(bundle);
  let target = await directoryAt(root, relative);
  if (!target) {
    const staging = await mkdtemp(join(parent, ".stage-"));
    try {
      for (const [name, bytes] of files) await writeNew(join(staging, name), bytes);
      await syncDirectory(staging);
      target = join(parent, bundle);
      await rename(staging, target);
      await syncDirectory(parent);
    } finally { await rm(staging, {recursive:true, force:true}); }
  }
  if ((await readdir(target)).length !== files.size) throw Error("已有启动器目录包含未知文件");
  for (const [name, bytes] of files)
    if (!(await ordinaryFile(join(target, name))).equals(bytes)) throw Error("已暂存的启动器文件不匹配：" + name);
}

function launcherEntries(bundle: string) {
  const base = "../" + publishedPath(bundle) + "/";
  return new Map([
    [supervisor, Buffer.from(entryHeader + 'export * from "' + base + supervisor + '";\n')],
    [child, Buffer.from(entryHeader + 'import { runHostLauncherBridge } from "' + base +
      'host-launcher-bridge.ts";\nawait runHostLauncherBridge();\n')],
  ]);
}

function coldEntry(original: Buffer) {
  if (!matchesStock("index.ts", original)) throw Error("原启动入口与正式 v0.1.1 不一致。");
  const source = original.toString("utf8"), from = 'await import("./host-supervisor.ts")';
  if (source.split(from).length !== 2) throw Error("无法识别原启动入口。");
  return Buffer.from(source.replace(from, 'await import("../' + publishedPath(launcherBundleDigest) + '/' + supervisor + '")'));
}

// Bare slotted managers import this small helper from the installation root. It starts
// taking effect on the next standard launcher start. Preserve the previous exact bytes
// outside automatically retired transaction backups. Old roots can lack instance-directory.ts.
export async function migrateSlottedBackup(root: string, core: string) {
  const path = join(core, backupModule), before = await ordinaryFile(path);
  if (!backupRevisions.has(hash(before))) {
    const text = before.toString("utf8");
    if (/(?<!\r)\n/.test(text) || !backupRevisions.has(hash(Buffer.from(text.replaceAll("\r\n", "\n"))))) return;
  }
  const files = await readLauncherBundle(sourceDir);
  const bundle = "rollback-" + launcherBundleDigest;
  await publishBundle(root, new Map([
    [backupModule, files.get(backupModule)!], ["instance-directory.ts", files.get("instance-directory.ts")!],
    [backupModule + ".original", before],
  ]), bundle);
  const forward = Buffer.from(entryHeader + 'export * from "../' + publishedPath(bundle) + '/' + backupModule + '";\n');
  await replaceEntry(path, before, forward);
  await syncDirectory(core);
}

async function replaceEntry(path: string, before: Buffer, after: Buffer) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeNew(temporary, after);
    if (!(await ordinaryFile(path)).equals(before)) throw Error("启动器在更新期间被修改：" + path);
    await rename(temporary, path);
  } catch (error: any) {
    if (["EPERM", "EACCES", "EBUSY"].includes(error.code))
      throw Error("无法替换启动文件 " + path + "，请检查文件占用及写入权限后重试。", {cause:error});
    throw error;
  } finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
}

// Called only after every required plugin passed the LAST gated health probe. The old
// supervisor persists handover before this probe, and cannot commit until it gets our reply.
export async function migrateStockLauncher(root: string) {
  if (!process.connected || process.argv[4] !== "trial" || !process.argv[1] ||
      resolve(process.argv[2]) !== root || resolve(process.argv[3]) !== dirname(sourceDir)) return;
  const worker = resolve(process.argv[1]), rootWorker = join(root, "core", child);
  if (worker !== rootWorker && worker !== join(root, publishedPath(previousLauncher), child)) return;
  const state = await readHostUpdateState(root);
  if (state.phase !== "handover" || !state.pending || !state.preflightOnly) return;
  const versionDir = await directoryAt(root, ".whalelife-updates/releases/" + state.pending);
  if (!versionDir || dirname(sourceDir) !== versionDir || await realpath(sourceDir) !== sourceDir)
    throw Error("启动器迁移需要从本实例已校验的发行目录启动");
  const packageBytes = await ordinaryFile(join(root, "package.json"));
  const pkg = JSON.parse(packageBytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (pkg.name !== "whalelife") return;
  const record = JSON.parse((await ordinaryFile(join(versionDir, ".whalelife-release.json"))).toString("utf8"));
  if (record.version !== state.pending || !/^[a-f0-9]{64}$/.test(record.digest)) throw Error("发行包校验记录不匹配");
  const core = (await directoryAt(root, "core"))!;
  const entries = launcherEntries(launcherBundleDigest), priorEntries = launcherEntries(previousLauncher);
  if (state.backupSlot && worker === rootWorker) {
    await migrateSlottedBackup(root, core);
    return;
  }
  if (pkg.version !== "0.1.1") return;
  const original = new Map<string, Buffer>(), before = new Map<string, Buffer>();
  const installed = new Set<string>();
  const migratingPinnedManager = worker !== rootWorker;
  for (const name of Object.keys(stock)) {
    let bytes = await ordinaryFile(join(core, name));
    before.set(name, bytes);
    if (migratingPinnedManager && name === "index.ts" && !matchesStock(name, bytes)) {
      const prior = await directoryAt(root, publishedPath(launcherBundleDigest));
      if (!prior) return; // A custom standard entry remains under its maintainer's control.
      const saved = await ordinaryFile(join(prior, name + ".original"));
      if (!coldEntry(saved).equals(bytes)) return;
      bytes = saved;
    }
    const currentEntry = entries.get(name)?.equals(bytes);
    if (currentEntry || priorEntries.get(name)?.equals(bytes)) {
      const prior = await directoryAt(root, publishedPath(currentEntry ? launcherBundleDigest : previousLauncher));
      if (!prior) throw Error("缺少已迁移启动器的备份");
      bytes = await ordinaryFile(join(prior, name + ".original"));
      if (currentEntry) installed.add(name);
    }
    if (!matchesStock(name, bytes)) throw Error("原启动器与正式 v0.1.1 不一致，已保留现有文件：" + name);
    if (name === supervisor || name === child || name === "index.ts") original.set(name, bytes);
  }
  const files = await readLauncherBundle(sourceDir);
  for (const [name, bytes] of original) files.set(name + ".original", bytes);
  await publishBundle(root, files);

  if (migratingPinnedManager) {
    // The resident previous-generation manager fingerprints both root forwarders before
    // every subsequent update. Preserve them and use the new manager only on a cold start.
    const index = "index.ts", after = coldEntry(original.get(index)!);
    if (!before.get(index)!.equals(after)) {
      await replaceEntry(join(core, index), before.get(index)!, after);
      await syncDirectory(core);
    }
    return;
  }

  // Cold starts now use the complete new manager and its paired child from the same
  // immutable directory. Only the already-running old parent uses the second entry.
  if (!installed.has(supervisor))
    await replaceEntry(join(core, supervisor), before.get(supervisor)!, entries.get(supervisor)!);
  try {
    await syncDirectory(core);
    if (!installed.has(child))
      await replaceEntry(join(core, child), before.get(child)!, entries.get(child)!);
  } catch (error) {
    if (!installed.has(supervisor))
      await replaceEntry(join(core, supervisor), entries.get(supervisor)!, before.get(supervisor)!);
    await syncDirectory(core);
    throw error;
  }
  await syncDirectory(core);
}
