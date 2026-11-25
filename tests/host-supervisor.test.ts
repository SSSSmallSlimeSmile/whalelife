/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { holdHostLock, hostReleaseDirectory, readHostUpdateState, runHostSupervisor } from "../core/host-supervisor.ts";
import { checkHostTrialEntry } from "../core/host-launcher-check.ts";
import { prepareHostBackup } from "../core/host-update-backup.ts";

// Run a real supervised child with the same IPC/bootstrap as production. Its small boot fixture
// simulates a release with an incompatible plugin or a write during startup, without real accounts.
async function program(dir: string, version: string, body: string) {
  await mkdir(join(dir, "core"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({version, type:"module"}));
  await writeFile(join(dir, "core", "host-updates.ts"), "export class HostUpdates { constructor(root, version, activate) { this.activate = activate } }");
  await writeFile(join(dir, "core", "index.ts"), `
    import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    export async function boot(root, updates, starting) {
      const image = join(root, 'plugins/gallery/data/image.png'), ready = () => process.exit(0);
      let plugins = ['gallery'];
      ${body}
      return {runtime:{
        list:()=>plugins.map(id=>({id,status:'active'})),
        checkInstalledPlugins(ids) {
          for (const id of ids) if (!plugins.includes(id)) throw Error("插件 " + id + " 预检失败");
        },
      }, logger:{error(){}}, close(){}};
    }
    export const prepareHostTrial = boot;`);
}
const old = `
  if (existsSync(join(root, 'asked'))) setTimeout(ready, 250);
  else setTimeout(() => {
    writeFileSync(join(root, 'asked'), 'yes');
    updates.activate('0.2.0').catch(() => process.exit(1));
  }, 300);
`;
async function fixture() {
  const root = await temporaryDirectory("whale-host-supervisor-");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({memory:{root:"memory"},personas:{}}));
  await mkdir(join(root, "plugins/gallery/data"), {recursive:true});
  await writeFile(join(root, "plugins/gallery/data/image.png"), Buffer.from([137,80,78,71,1,2,3]));
  await program(root, "0.1.0", old);
  return { root, target: hostReleaseDirectory(root, "0.2.0"), image: join(root, "plugins/gallery/data/image.png") };
}
test("supervisor commits a healthy release and preserves the original instance directory", async () => {
  const {root,target,image} = await fixture(), bytes = await readFile(image);
  await program(target, "0.2.0", "setTimeout(ready, 950);");
  assert.equal(await runHostSupervisor(root), 0);
  const state = await readHostUpdateState(root);
  assert.equal(state.active, "0.2.0");
  assert.equal(state.lastResult?.status, "updated");
  assert.equal(state.pending, null);
  assert.deepEqual(await readFile(image), bytes);
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readHostUpdateState(root), state);
});
test("loss of a formerly running plugin restores data touched by trial and restarts the previous program", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); plugins = [];");
  assert.equal(await runHostSupervisor(root), 0);
  const state = await readHostUpdateState(root);
  assert.equal(state.active, null);
  assert.equal(state.lastResult?.status, "rolled-back");
  assert.match(state.lastResult!.message, /gallery/);
  assert.deepEqual(await readFile(image), original);
});
test("a blocked rollback retains both causes and reports the original trial failure after recovery", async () => {
  const { root, target } = await fixture();
  await program(target, "0.2.0", `
    const dir = join(root, '.whalelife-updates');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    writeFileSync(join(dir, state.backupSlot, 'owner'), 'invalid fixture marker');
    plugins = [];
  `);
  await assert.rejects(runHostSupervisor(root), /gallery.*恢复升级前资料失败.*备份目录归属不明/);
  const failed = await readHostUpdateState(root);
  assert.equal(failed.pending, "0.2.0");
  assert.match(failed.rollbackFailure!.trigger, /gallery/);
  assert.match(failed.rollbackFailure!.detail, /备份目录归属不明/);
  await writeFile(join(root, ".whalelife-updates", failed.backupSlot!, "owner"), "whalelife.host-backup/1");
  assert.equal(await runHostSupervisor(root), 0);
  const restored = await readHostUpdateState(root);
  assert.equal(restored.pending, null);
  assert.equal(restored.rollbackFailure, undefined);
  assert.equal(restored.lastResult?.status, "rolled-back");
  assert.equal(restored.lastResult?.message, failed.rollbackFailure!.trigger);
});
test("after rollback the old program starts before its restored backup is retired", async () => {
  const {root,target} = await fixture();
  await program(root,"0.1.0", `
    if (existsSync(join(root,'asked'))) {
      const dir = join(root,'.whalelife-updates');
      const state = JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
      const slot = join(dir,state.backupSlot);
      writeFileSync(join(root,'restored-before-cleanup'),JSON.stringify([state.lastResult.status,existsSync(join(slot,'owner')),existsSync(join(slot,'retired'))]));
      setTimeout(ready,250);
    } else setTimeout(() => { writeFileSync(join(root,'asked'),'yes'); updates.activate('0.2.0').catch(() => process.exit(1)); },300);
  `);
  await program(target,"0.2.0","throw Error('bad candidate');");
  assert.equal(await runHostSupervisor(root),0);
  assert.deepEqual(JSON.parse(await readFile(join(root,"restored-before-cleanup"),"utf8")),["rolled-back",true,false]);
});

test("a candidate that exits right after its first ready report triggers rollback", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); setTimeout(() => process.exit(1), 80);");
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readHostUpdateState(root)).lastResult?.status, "rolled-back");
});
test("a hung trial is terminated and rolled back within the health deadline", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); await new Promise(() => {});");
  assert.equal(await runHostSupervisor(root, {healthTimeoutMs:800}), 0);
  assert.deepEqual(await readFile(image), original);
  assert.match((await readHostUpdateState(root)).lastResult!.message, /限定时间/);
});
test("failure to write the update journal rejects that request and keeps the running application", async () => {
  const {root,target} = await fixture();
  await program(target, "0.2.0", "");
  await program(root, "0.1.0", `
    setTimeout(async () => {
      mkdirSync(join(root,'.whalelife-updates/state.json'), {recursive:true});
      try { await updates.activate('0.2.0'); process.exit(2); }
      catch (error) { writeFileSync(join(root, 'rejected'), error.message); ready(); }
    },300);
  `);
  assert.equal(await runHostSupervisor(root), 0);
  assert.match(await readFile(join(root,"rejected"),"utf8"), /无法准备本体更新/);
});
test("interrupted trial recovers its saved image before bringing back the old application", async () => {
  const {root,image} = await fixture(), original = await readFile(image);
  await writeFile(join(root, "asked"), "yes");
  await prepareHostBackup(root);
  await writeFile(join(root, ".whalelife-updates/state.json"), JSON.stringify({active:null,pending:"0.2.0",phase:"trial",preflightOnly:true,lastResult:null}));
  await writeFile(image, "trial changed");
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readHostUpdateState(root)).lastResult?.status, "rolled-back");
});
test("killing the manager while the final handover response is outstanding restores the previous release and image", async t => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", `
    writeFileSync(image, 'trial changed');
    const send = process.send.bind(process);
    process.send = (packet,...rest) => {
      if (packet.type === 'host-confirmed' && JSON.parse(readFileSync(join(root,'.whalelife-updates/state.json'),'utf8')).phase === 'handover') {
        writeFileSync(join(root,'waiting-for-handover'), String(starting()));
        return true; // Simulate an IPC reply still in flight; the worker remains responsive to parent disconnect.
      }
      return send(packet,...rest);
    };
  `);
  const entry = join(root,"manager.mjs");
  await writeFile(entry, `import {runHostSupervisor} from ${JSON.stringify(new URL("../core/host-supervisor.ts", import.meta.url).href)}; process.exitCode=await runHostSupervisor(process.argv[2]);`);
  const manager = fork(entry,[root],{execArgv:[],stdio:["ignore","ignore","ignore","ipc"]});
  const exited = once(manager,"exit");
  t.after(async () => { if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGKILL"); await exited; });
  let gated = "";
  const until = Date.now() + 15_000;
  while (Date.now() < until && !gated) {
    gated = await readFile(join(root,"waiting-for-handover"),"utf8").catch(() => "");
    if (!gated) await wait(30);
  }
  assert.equal(gated, "true");
  const interrupted = await readHostUpdateState(root);
  assert.deepEqual([interrupted.active, interrupted.pending, interrupted.phase], [null,"0.2.0","handover"]);
  manager.kill("SIGKILL");
  await exited;
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  const recovered = await readHostUpdateState(root);
  assert.deepEqual([recovered.active,recovered.lastResult?.status], [null,"rolled-back"]);
});
for (const phase of ["trial", "handover"]) test(`legacy ${phase} keeps both images for inspection when plugins might have executed`, async () => {
  const {root,image} = await fixture();
  await prepareHostBackup(root);
  const interrupted = {active:null,pending:"0.2.0",phase,lastResult:null};
  await writeFile(join(root, ".whalelife-updates/state.json"), JSON.stringify(interrupted));
  await writeFile(image, "external receipt already recorded");
  await assert.rejects(runHostSupervisor(root), /旧启动器.*插件可能已执行/);
  assert.deepEqual(await readHostUpdateState(root), interrupted);
  assert.equal(await readFile(image, "utf8"), "external receipt already recorded");
  assert.ok(await readFile(join(root, ".whalelife-updates/backup/items.json"), "utf8"));
});
test("an interrupted delivery keeps the selected program, fresh data and backup when it cannot restart", async () => {
  const {root,target,image} = await fixture();
  await writeFile(join(root, "asked"), "yes");
  await prepareHostBackup(root);
  await program(target,"0.2.0","throw Error('partial delivery failed to boot');");
  await writeFile(join(root, ".whalelife-updates/state.json"), JSON.stringify({
    active:"0.2.0",pending:null,lastResult:null,delivery:{previous:null,plugins:["gallery"]},
  }));
  await writeFile(image, "newly accepted write");
  await assert.rejects(runHostSupervisor(root), /partial delivery failed to boot/);
  assert.equal(await readFile(image, "utf8"), "newly accepted write");
  assert.equal((await readHostUpdateState(root)).active, "0.2.0");
  assert.ok(await readFile(join(root, ".whalelife-updates/backup/items.json"), "utf8"));
});
test("a second supervisor never consumes or resets the first supervisor's pending journal", async () => {
  const {root} = await fixture();
  const unlock = await holdHostLock(root,"manager");
  try { await assert.rejects(runHostSupervisor(root), /仍在运行/); }
  finally { await unlock(); }
});
test("an older worker calling the live entry for a trial is refused before core startup", async () => {
  const root = await temporaryDirectory("whale-old-host-entry-");
  const entry = join(root, "old-worker.mjs");
  await writeFile(entry, `
    import { boot } from ${JSON.stringify(new URL("../core/index.ts", import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    try { await boot(process.argv[2], undefined, () => true); process.exit(2); }
    catch (error) { writeFileSync(join(process.argv[2], "diagnosis"), error.message); process.exit(0); }
  `);
  const worker = fork(entry, [root, root, "trial"], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  assert.equal((await once(worker, "exit"))[0], 0);
  assert.match(await readFile(join(root, "diagnosis"), "utf8"), /根目录的启动器需要手动升级/);
  await assert.rejects(stat(join(root, "logs")), { code: "ENOENT" });
});
test("a failure writing the authoritative takeover transaction never starts the candidate's plugins", {
  skip: process.platform !== "win32",
}, async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", `
    if (process.argv[4] === 'trial') {
      writeFileSync(image, 'reversible core startup');
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(root, '.whalelife-updates/state.sqlite'));
      db.exec("CREATE TRIGGER fail_selection BEFORE UPDATE ON host_state WHEN json_extract(NEW.state, '$.active') = '0.2.0' BEGIN SELECT RAISE(ABORT, 'takeover write failure'); END");
      db.close();
    } else {
      writeFileSync(join(root, 'candidate-live'), 'ran');
      setTimeout(ready, 250);
    }
  `);
  assert.equal(await runHostSupervisor(root), 0);
  const state = await readHostUpdateState(root);
  assert.equal(state.active, null);
  assert.match(state.lastResult!.message, /takeover write failure/);
  assert.deepEqual(await readFile(image), original);
  await assert.rejects(stat(join(root, "candidate-live")), { code: "ENOENT" });
});
test("interrupting the first Windows journal migration leaves the original JSON usable for retry", {
  skip: process.platform !== "win32",
}, async t => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "setTimeout(ready, 950);");
  const legacy = { active: null, pending: null, lastResult: null };
  const directory = join(root, ".whalelife-updates");
  await writeFile(join(directory, "state.json"), JSON.stringify(legacy));
  const entry = join(root, "interrupted-migration.mjs");
  await writeFile(entry, `
    import { DatabaseSync } from 'node:sqlite';
    import { runHostSupervisor } from ${JSON.stringify(new URL("../core/host-supervisor.ts", import.meta.url).href)};
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.startsWith('INSERT INTO host_state')) process.exit(76);
      return prepare.call(this, sql);
    };
    process.exitCode = await runHostSupervisor(process.argv[2]);`);
  const manager = fork(entry, [root], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(manager, "exit");
  t.after(async () => { if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGKILL"); await exited; });
  assert.equal((await exited)[0], 76);
  await (await holdHostLock(root, "worker", 30_000))();
  assert.deepEqual(await readHostUpdateState(root), legacy);
  await assert.rejects(stat(join(directory, "state.sqlite")), { code: "ENOENT" });
  assert.deepEqual(await readFile(image), original);
  await rename(join(root, "asked"), join(root, "first-request"));
  assert.equal(await runHostSupervisor(root), 0);
  assert.equal((await readHostUpdateState(root)).active, "0.2.0");
});
test("successive durable selections survive an older JSON mirror, leftover backup and journal read errors", {
  skip: process.platform !== "win32",
}, async () => {
  const {root,target,image} = await fixture();
  const directory = join(root, ".whalelife-updates");
  const journal = join(directory, "state.sqlite");
  await readHostUpdateState(root);
  await assert.rejects(stat(journal), { code: "ENOENT" });
  await program(target, "0.2.0", `
    if (process.argv[4] === 'active') setTimeout(() => updates.activate('0.3.0'), 300);
  `);
  await program(hostReleaseDirectory(root, "0.3.0"), "0.3.0", `
    if (process.argv[4] === 'active') {
      writeFileSync(image, 'newest user data');
      // Prevent automatic cleanup of this snapshot. It must never be read as rollback authority.
      const dir = join(root, '.whalelife-updates');
      if (!existsSync(join(root, 'protected-snapshot'))) {
        const {backupSlot} = JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
        writeFileSync(join(dir,backupSlot,'owner'), 'unknown backup owner');
        writeFileSync(join(root, 'protected-snapshot'), backupSlot);
      }
      setTimeout(ready, 250);
    }
  `);
  assert.equal(await runHostSupervisor(root), 0);
  const newest = await readHostUpdateState(root);
  assert.equal(newest.active, "0.3.0");
  const stale = {active:"0.2.0",pending:"0.3.0",phase:"handover",preflightOnly:true,lastResult:null,windowsJournal:true};
  await writeFile(join(directory, "state.json"), JSON.stringify(stale));
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readHostUpdateState(root), newest);
  assert.equal(await readFile(image, "utf8"), "newest user data");
  await rename(journal, journal + ".saved");
  await assert.rejects(runHostSupervisor(root), /缺少本体更新事务数据库/);
  await writeFile(journal, "damaged journal");
  await assert.rejects(runHostSupervisor(root), /database/i);
  assert.equal(await readFile(image, "utf8"), "newest user data");
  assert.ok(await readFile(join(directory, newest.backupSlot!, "items.json"), "utf8"));
});

test("linking a trial entry checks its exports and dependencies without running candidate code", async () => {
  const {root,target} = await fixture();
  await program(target,"0.2.0","");
  const index = join(target, "core/index.ts");
  const marker = join(root, "candidate-module-evaluated");
  const sideEffect = "import {writeFileSync} from 'node:fs';writeFileSync(" + JSON.stringify(marker) + ",'ran');";
  await writeFile(join(target, "core/effect.ts"), sideEffect);
  await writeFile(index, "import './effect.ts';" + sideEffect + "export function boot(){}; export {boot as prepareHostTrial};");
  await checkHostTrialEntry(target);
  await assert.rejects(stat(marker), {code:"ENOENT"});
  await writeFile(index, "export function boot(){}; import './effect.ts';");
  await assert.rejects(checkHostTrialEntry(target), /预检入口/);
  await assert.rejects(stat(marker), {code:"ENOENT"});
});

test("an on-disk launcher change is refused while the same old worker continues serving", async () => {
  const {root,target} = await fixture();
  const core = join(root, "launcher-core");
  await cp(new URL("../core",import.meta.url), core, {recursive:true});
  await program(target, "0.2.0", "");
  await program(root, "0.1.0", `
    setTimeout(async () => {
      const path=join(root,"launcher-core","host-child.ts");
      writeFileSync(path,readFileSync(path,"utf8")+"\\n// replaced during service\\n");
      try { await updates.activate("0.2.0"); process.exit(2); }
      catch(error) {
        writeFileSync(join(root,"rejection"),JSON.stringify({message:error.message,serving:!starting()}));
        ready();
      }
    },300);
  `);
  const manager = await import(pathToFileURL(join(core,"host-supervisor.ts")).href);
  assert.equal(await manager.runHostSupervisor(root),0);
  const result = JSON.parse(await readFile(join(root,"rejection"),"utf8"));
  assert.match(result.message,/启动程序在运行期间已改变/);
  assert.equal(result.serving,true);
  assert.deepEqual(await readHostUpdateState(root),{active:null,pending:null,lastResult:null});
});

for (const failure of ["legacy-worker", "no-trial-entry"]) test(
  `a ${failure} is reported before journaling or stopping the old application`, async () => {
    const {root,target,image} = await fixture(), original = await readFile(image);
    await program(target,"0.2.0","");
    if (failure === "no-trial-entry") await writeFile(join(target,"core/index.ts"),
      "throw Error('candidate executed'); export function boot(){};");
    await program(root, "0.1.0", `
      setTimeout(async () => {
        if (${JSON.stringify(failure)} === "legacy-worker") {
          const send = process.send.bind(process);
          process.send = (packet,...args) => {
            if (packet.type === "host-activate") delete packet.launcherProtocol;
            return send(packet,...args);
          };
        }
        try { await updates.activate("0.2.0"); process.exit(2); }
        catch(error) {
          writeFileSync(join(root,"rejection"),JSON.stringify({message:error.message,serving:!starting()}));
          ready();
        }
      },300);
    `);
    assert.equal(await runHostSupervisor(root),0);
    const result = JSON.parse(await readFile(join(root,"rejection"),"utf8"));
    assert.equal(result.serving,true);
    assert.match(result.message,failure === "legacy-worker" ? /根目录的启动器/ : /预检入口/);
    assert.deepEqual(await readFile(image),original);
    assert.deepEqual(await readHostUpdateState(root),{active:null,pending:null,lastResult:null});
  });
