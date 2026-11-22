/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { holdHostLock, runHostSupervisor } from "../core/host-supervisor.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture() {
  const root = await temporaryDirectory("whale-launcher-bridge-");
  const core = join(root,"core");
  await mkdir(core);
  const entry = join(core,"host-child.ts");
  const bridge = new URL("../core/host-launcher-bridge.ts",import.meta.url);
  await writeFile(entry, `import { runHostLauncherBridge } from ${JSON.stringify(bridge.href)}; await runHostLauncherBridge();`);
  await writeFile(join(root,"package.json"),JSON.stringify({type:"module",version:"0.1.2"}));
  await writeFile(join(core,"host-updates.ts"), "export class HostUpdates {}");
  await writeFile(join(core,"index.ts"), `
    import { appendFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    export function boot(root) {
      const log = join(root,'workers.txt'), restarted = existsSync(log);
      appendFileSync(log,'boot\\n');
      if (restarted) setTimeout(() => process.emit('SIGTERM'),300);
      return {
        runtime:{list:() => [{id:'ready-plugin', status:'active'}]}, logger:{error(){}},
        async close() {
          await new Promise(resolve => setTimeout(resolve,150));
          appendFileSync(log,'closed\\n');
        }
      };
    }`);
  return {root, start:() => fork(entry,[root,root,"active"],{cwd:root,execArgv:[],stdio:["ignore","ignore","ignore","ipc"]})};
}

test("the original parent receives actual worker readiness and its disconnect drains before a cold restart", {timeout:20_000}, async t => {
  const {root,start} = await fixture();
  const releaseOriginal = await holdHostLock(root,"manager");
  const bridge = start(), exited = once(bridge,"exit");
  t.after(async () => { if (bridge.connected) bridge.disconnect(); await exited; });
  try {
    const [ready] = await once(bridge,"message");
    assert.deepEqual(ready,{type:"host-ready",version:"0.1.2",plugins:["ready-plugin"]});
    const confirmed = once(bridge,"message");
    bridge.send({type:"host-serving",id:"original-request"});
    assert.deepEqual((await confirmed)[0],{type:"host-confirmed",id:"original-request",version:"0.1.2",plugins:["ready-plugin"]});
    await assert.rejects(holdHostLock(root,"takeover"),/仍在运行/);
  } finally { await releaseOriginal(); }
  const cold = runHostSupervisor(root);
  try {
    await delay(30);
    assert.equal(await readFile(join(root,"workers.txt"),"utf8"),"boot\n");
  } finally { if (bridge.connected) bridge.disconnect(); }
  assert.equal((await exited)[0],0);
  assert.equal(await cold,0);
  assert.equal(await readFile(join(root,"workers.txt"),"utf8"),"boot\nclosed\nboot\nclosed\n");
});

test("a stop before the original parent confirms readiness also drains the real worker", {timeout:15_000}, async () => {
  const {root,start} = await fixture();
  const release = await holdHostLock(root,"manager");
  const bridge = start(), exited = once(bridge,"exit");
  try {
    assert.equal((await once(bridge,"message"))[0].type,"host-ready");
    bridge.send({type:"host-stop"});
    assert.equal((await exited)[0],0);
    assert.equal(await readFile(join(root,"workers.txt"),"utf8"),"boot\nclosed\n");
  } finally { if (bridge.connected) bridge.disconnect(); await release(); }
});

test("a forwarded worker cannot take the place of a missing original manager", {timeout:10_000}, async () => {
  const {root,start} = await fixture();
  const bridge = start(), exited = once(bridge,"exit");
  try {
    const [notice] = await once(bridge,"message");
    assert.equal(notice.type,"host-boot-error");
    assert.match(notice.error,/未持有此实例的启动锁/);
    assert.equal((await exited)[0],1);
    await assert.rejects(readFile(join(root,"workers.txt")),{code:"ENOENT"});
  } finally { if (bridge.connected) bridge.disconnect(); }
});

test("a migrated manager fingerprints the installation-root entries as well as its own worker", async () => {
  const {root} = await fixture();
  const capsule = join(root,".whalelife-updates","launchers","a".repeat(64));
  await mkdir(capsule,{recursive:true});
  await copyFile(new URL("../core/host-launcher-check.ts",import.meta.url),join(capsule,"host-launcher-check.ts"));
  for (const name of ["host-supervisor.ts","host-child.ts"]) await writeFile(join(capsule,name),name);
  await writeFile(join(root,"core/host-supervisor.ts"),"forward");
  const capsuleCheck = await import(pathToFileURL(join(capsule,"host-launcher-check.ts")).href);
  const first = await capsuleCheck.launcherFingerprint(root);
  await writeFile(join(root,"core/host-child.ts"),"changed child");
  const second = await capsuleCheck.launcherFingerprint(root);
  assert.notEqual(first,second);
  await writeFile(join(root,"core/host-supervisor.ts"),"changed manager");
  assert.notEqual(second,await capsuleCheck.launcherFingerprint(root));
});
