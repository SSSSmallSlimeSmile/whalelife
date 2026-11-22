/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { prepareHostBackup, restoreHostBackup, retireHostBackup, retireStockHostBackup, collectRetiredHostBackups } from "../core/host-update-backup.ts";

test("cleanup retains an active trial and a backup without verified ownership", async () => {
  const root = await temporaryDirectory("whale-backup-retirement-");
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/config.json"),JSON.stringify({memory:{root:"memory"},personas:{}}));
  const current = "backup-" + randomUUID();
  await prepareHostBackup(root);
  await prepareHostBackup(root,current);
  const area = join(root,".whalelife-updates");
  await writeFile(join(area,"backup/owner"),"unidentified");
  await assert.rejects(retireHostBackup(root),/归属不明/);
  await collectRetiredHostBackups(root);
  assert.ok(await readFile(join(area,current,"items.json")));
  assert.ok(await readFile(join(area,"backup/items.json")));
  await retireHostBackup(root,current);
  await assert.rejects(restoreHostBackup(root,current),/退役/);
  assert.equal(await collectRetiredHostBackups(root),false);
  await assert.rejects(stat(join(area,current)),{code:"ENOENT"});
  assert.ok(await readFile(join(area,"backup/items.json")));
});

test("a Windows file lock can outlive rollback and the next transaction", {skip:process.platform !== "win32"}, async t => {
  const root = await temporaryDirectory("whale-locked-backup-");
  const area = join(root,".whalelife-updates");
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/config.json"),JSON.stringify({memory:{root:"memory"},personas:{}}));
  await writeFile(join(root,"data"),"before failed trial");
  await prepareHostBackup(root);
  await writeFile(join(root,"data"),"trial change");
  await restoreHostBackup(root);
  const items = JSON.parse(await readFile(join(area,"backup/items.json"),"utf8"));
  const index = items.findIndex((item: {path:string}) => item.path === "data");
  const locked = join(area,"backup/displaced",String(index));
  const holder = spawn("powershell.exe", ["-NoProfile","-NonInteractive","-Command",
    "$h=[IO.File]::Open($env:WHALE_TEST_LOCK,'Open','Read','None');try{[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null}finally{$h.Dispose()}"],
    {env:{...process.env,WHALE_TEST_LOCK:locked},stdio:["pipe","pipe","pipe"],windowsHide:true});
  const exited = once(holder,"exit");
  t.after(async () => { holder.stdin.end(); await exited; });
  await Promise.race([
    once(holder.stdout,"data").then(([data]) => assert.match(String(data),/locked/)),
    exited.then(([code]) => { throw Error("文件占用测试进程提前退出 " + code); }),
  ]);
  await retireHostBackup(root);
  assert.equal(await collectRetiredHostBackups(root),true);
  assert.equal(await readFile(join(root,"data"),"utf8"),"before failed trial");
  const next = "backup-" + randomUUID();
  await writeFile(join(root,"data"),"current user data");
  await prepareHostBackup(root,next);
  assert.equal(await collectRetiredHostBackups(root),true);
  assert.ok(await readFile(join(area,next,"items.json")));
  await writeFile(join(root,"data"),"another failed trial");
  await restoreHostBackup(root,next);
  assert.equal(await readFile(join(root,"data"),"utf8"),"current user data");
  holder.stdin.end();
  await exited;
  assert.equal(await collectRetiredHostBackups(root),false);
  await assert.rejects(stat(join(area,"backup")),{code:"ENOENT"});
  assert.ok(await readFile(join(area,next,"items.json")));
});

test("stock ownership survives partial cleanup but never authorizes a replacement directory", async () => {
  const root = await temporaryDirectory("whale-stock-retirement-");
  const area = join(root,".whalelife-updates"), base = join(area,"backup");
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/config.json"),JSON.stringify({memory:{root:"memory"},personas:{}}));
  await prepareHostBackup(root);
  await retireStockHostBackup(root);
  // Original v0.1.1 recursively removes owner before a locked descendant.
  await unlink(join(base,"owner"));
  await collectRetiredHostBackups(root);
  await assert.rejects(stat(base),{code:"ENOENT"});
  await prepareHostBackup(root);
  await retireStockHostBackup(root);
  await rename(base,join(area,"completed-old"));
  await mkdir(base);
  await writeFile(join(base,"unknown"),"do not remove");
  await collectRetiredHostBackups(root);
  assert.equal(await readFile(join(base,"unknown"),"utf8"),"do not remove");
  assert.ok(await stat(join(area,"completed-old/owner")));
});

test("an exclusively locked stock owner is rechecked before deleting anything", {skip:process.platform !== "win32"}, async t => {
  const root = await temporaryDirectory("whale-stock-owner-lock-");
  const base = join(root,".whalelife-updates/backup"), owner = join(base,"owner");
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/config.json"),JSON.stringify({memory:{root:"memory"},personas:{}}));
  await prepareHostBackup(root);
  const holder = spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",
    "$h=[IO.File]::Open($env:WHALE_TEST_OWNER,'Open','Read','None');try{[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null}finally{$h.Dispose()}"],
    {env:{...process.env,WHALE_TEST_OWNER:owner},stdio:["pipe","pipe","pipe"],windowsHide:true});
  const exited = once(holder,"exit");
  t.after(async () => { holder.stdin.end(); await exited; });
  await Promise.race([once(holder.stdout,"data").then(([data])=>assert.match(String(data),/locked/)),
    exited.then(()=>{ throw Error("占用进程意外退出"); })]);
  await retireStockHostBackup(root);
  assert.equal(await collectRetiredHostBackups(root),true);
  assert.ok(await stat(join(base,"items.json")));
  holder.stdin.end(); await exited;
  // A queued check is only a request to re-read owner, never proof of ownership itself.
  await writeFile(owner,"unknown");
  await collectRetiredHostBackups(root);
  assert.ok(await stat(join(base,"items.json")));
  await writeFile(owner,"whalelife.host-backup/1");
  await retireStockHostBackup(root);
  await collectRetiredHostBackups(root);
  await assert.rejects(stat(base),{code:"ENOENT"});
});
