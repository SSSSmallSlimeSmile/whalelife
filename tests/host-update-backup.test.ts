import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { prepareHostBackup, restoreHostBackup, discardHostBackup } from "../core/host-update-backup.ts";

test("试运行写坏资料后按原路径恢复，重复恢复及清理可安全重试", async () => {
  const root = await temporaryDirectory("whale-host-backup-");
  for (const name of ["config", "plugins/gallery/data", "custom/history", "profiles"])
    await mkdir(join(root, name), {recursive: true});
  const config = JSON.stringify({memory: {root: "custom/history"}, personas: {test: {file: "profiles/test.md"}}});
  const before = new Map([["config/config.json", config], ["plugins/gallery/data/image.png", "image bytes"],
    ["custom/history/diary", "old diary"], ["profiles/test.md", "test persona"]]);
  for (const [name, value] of before) await writeFile(join(root, name), value);
  await prepareHostBackup(root);
  for (const name of before.keys()) await writeFile(join(root, name), "incomplete migration");
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data/partial"), "bad");
  // Simulate a process stop between displacing the install directory and restoring its snapshot.
  const items = JSON.parse(await readFile(join(root, ".whalelife-updates/backup/items.json"), "utf8"));
  const index = items.findIndex((item: {path:string}) => item.path === "data");
  await rename(join(root, "data"), join(root, ".whalelife-updates/backup/displaced", String(index)));
  await restoreHostBackup(root);
  await restoreHostBackup(root);
  for (const [name, expected] of before) assert.equal(await readFile(join(root, name), "utf8"), expected);
  await assert.rejects(readFile(join(root, "data/partial")), {code: "ENOENT"});
  await discardHostBackup(root);
  await discardHostBackup(root);
});

test("配置引用实例外资料时在切换前失败并原样保留", async () => {
  const root = await temporaryDirectory("whale-host-external-");
  await mkdir(join(root, "config"));
  const config = JSON.stringify({memory:{root:"../other-instance"},personas:{}});
  await writeFile(join(root, "config/config.json"), config);
  await assert.rejects(prepareHostBackup(root), /实例外/);
  assert.equal(await readFile(join(root, "config/config.json"), "utf8"), config);
});

test("损坏的快照不能被误判成已完成资料恢复", async () => {
  const root = await temporaryDirectory("whale-host-incomplete-backup-");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({memory: {root: "memory"}, personas: {}}));
  await writeFile(join(root, "data"), "original");
  await prepareHostBackup(root);
  const backup = join(root, ".whalelife-updates/backup");
  const items = JSON.parse(await readFile(join(backup, "items.json"), "utf8"));
  const index = items.findIndex((item: {path:string}) => item.path === "data");
  await unlink(join(backup, "saved", String(index)));
  await writeFile(join(root, "data"), "incomplete");
  await assert.rejects(restoreHostBackup(root), /原始备份或恢复记录缺失/);
  assert.equal(await readFile(join(root, "data"), "utf8"), "incomplete");
});

test("插件服务占用目录时核对全部快照后原地回滚；有差异时保留两侧并可重试", {skip:process.platform !== "win32"}, async t => {
  const root = await temporaryDirectory("whale-rollback-live-plugins-");
  const plugins = join(root, "plugins"), service = join(plugins, "example");
  for (const path of ["config", "backups", "plugins/example", "plugins/empty"])
    await mkdir(join(root,path), {recursive:true});
  const config = JSON.stringify({memory:{root:"memory"},personas:{}});
  await writeFile(join(root,"config/config.json"), config);
  await writeFile(join(root,"backups/record"), "before");
  const payload = Buffer.alloc(600_000, 13), sample = join(service,"image.bin");
  await writeFile(sample, payload);
  await prepareHostBackup(root);
  const snapshot = join(root,".whalelife-updates/backup");
  const items = JSON.parse(await readFile(join(snapshot,"items.json"),"utf8"));
  const index = String(items.findIndex((item: {path:string}) => item.path === "plugins"));
  const original = (await lstat(plugins,{bigint:true})).ino;
  // Windows holds the working directory for the lifetime of this independent service.
  const holder = spawn(process.execPath,["-e","process.stdin.resume();console.log('ready')"], {
    cwd:service, stdio:["pipe","pipe","pipe"], windowsHide:true,
  });
  const exited = once(holder,"exit");
  t.after(async () => { holder.stdin.end(); await exited; });
  await Promise.race([once(holder.stdout,"data"), exited.then(() => { throw Error("目录占用进程提前退出"); })]);
  await assert.rejects(rename(plugins, join(root,"moved")), (e: NodeJS.ErrnoException) => ["EBUSY","EPERM","EACCES"].includes(e.code ?? ""));

  // A same-length mismatch after the first two 256 KiB blocks must not be treated as restored.
  const different = Buffer.from(payload);
  different[different.length - 1] ^= 1;
  await writeFile(sample, different);
  await writeFile(join(root,"config/config.json"), "trial");
  await writeFile(join(root,"backups/record"), "trial");
  await assert.rejects(restoreHostBackup(root), /保留当前目录和快照.*image\.bin/);
  assert.deepEqual(await readFile(sample), different);
  assert.deepEqual(await readFile(join(snapshot,"saved",index,"example/image.bin")), payload);
  assert.equal(await readFile(join(root,"config/config.json"),"utf8"), config);
  assert.equal(await readFile(join(root,"backups/record"),"utf8"), "trial");

  await writeFile(sample, payload);
  const empty = join(plugins,"empty");
  await rmdir(empty);
  await symlink(join(root,"backups"),empty,"junction");
  await assert.rejects(restoreHostBackup(root), /与更新前的快照不一致/);
  await unlink(empty);
  await mkdir(empty);
  await restoreHostBackup(root);
  await restoreHostBackup(root);
  assert.equal((await lstat(plugins,{bigint:true})).ino,original);
  assert.deepEqual(await readFile(sample),payload);
  assert.equal(await readFile(join(root,"backups/record"),"utf8"),"before");
  assert.equal(holder.exitCode,null);
  await assert.rejects(lstat(join(snapshot,"displaced",index)), {code:"ENOENT"});
  assert.ok((await lstat(join(snapshot,"saved",index))).isDirectory());
});

test("锁文件无法读取时保留插件和快照，解锁后可继续恢复", {skip:process.platform !== "win32"}, async t => {
  const root = await temporaryDirectory("whale-rollback-exclusive-");
  const service = join(root,"plugins/example"), data = join(service,"database");
  await mkdir(service,{recursive:true});
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/config.json"),JSON.stringify({memory:{root:"memory"},personas:{}}));
  await writeFile(data,"before");
  await prepareHostBackup(root);
  const holder = spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",
    "$f=[IO.File]::Open('database','Open','Read','None');try{[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}"],
    {cwd:service,stdio:["pipe","pipe","pipe"],windowsHide:true});
  const exited = once(holder,"exit");
  t.after(async () => { holder.stdin.end(); await exited; });
  await Promise.race([once(holder.stdout,"data").then(([data]) => assert.match(String(data),/locked/)), exited.then(() => { throw Error("文件占用进程提前退出"); })]);
  await assert.rejects(restoreHostBackup(root), /保留当前目录和快照.*database/);
  assert.equal(holder.exitCode,null);
  holder.stdin.end();
  await exited;
  await restoreHostBackup(root);
  assert.equal(await readFile(data,"utf8"),"before");
});
