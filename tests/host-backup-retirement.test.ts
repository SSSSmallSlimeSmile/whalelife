/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { prepareHostBackup, restoreHostBackup, retireHostBackup, collectRetiredHostBackups } from "../core/host-update-backup.ts";

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
