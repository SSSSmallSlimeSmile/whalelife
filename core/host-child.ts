/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { holdHostLock } from "./host-supervisor.ts";
import { installProcessLifecycle } from "./process-lifecycle.ts";
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";
import { launcherProtocol, launcherUpgradeNeeded } from "./host-launcher-check.ts";
import type { boot } from "./index.ts";

// This entry is always from the original installation with the supervisor's matching IPC protocol.
async function start() {
  const [root, program, mode] = process.argv.slice(2);
  if (!process.send || !process.connected || !root || !program || !["active", "trial"].includes(mode))
    throw Error("本体工作进程必须由当前实例的主进程启动");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  let shutdown: (() => void) | undefined;
  let closing = false, serving = false, compatibleManager = false;
  let activation: { resolve(): void; reject(error: Error): void } | undefined;
  let version = "";
  const activePlugins = () => app!.runtime.list().filter((p: any) => !p.builtin && p.status === "active").map((p: any) => p.id);
  const stop = () => {
    closing = true;
    activation?.resolve();
    if (shutdown) shutdown();
    else process.exit(1); // No initialized application can drain a partial startup.
  };
  process.on("disconnect", stop);
  process.on("message", async (packet: any) => {
    if (packet?.type === "host-stop") stop();
    if ((packet?.type === "host-probe" || packet?.type === "host-serving") && !closing && app) {
      try {
        if (mode === "trial") {
          if (packet.type === "host-serving") throw Error("预检进程不能接管服务");
          await app.runtime.checkInstalledPlugins(packet.required);
        } else if (packet.type === "host-serving") {
          compatibleManager = packet.launcherProtocol === launcherProtocol;
          serving = true;
        }
        if (!closing) process.send?.({ type: "host-confirmed", id: packet.id, version, plugins: activePlugins() });
      } catch (error: any) {
        if (!closing) process.send?.({ type: "host-confirmed", id: packet.id, version, plugins: [], error: error.message });
      }
    }
    if (packet?.type === "host-activation-error") {
      activation?.reject(Error(String(packet.error)));
      activation = undefined;
    }
  });
  // A crash releases this kernel lock after the worker has actually exited.
  const unlock = await holdHostLock(root, "worker");
  process.once("exit", () => { void unlock().catch(() => {}); });
  const manifest = JSON.parse(await readFile(join(program, "package.json"), "utf8"));
  version = manifest.version;
  const load = (file: string) => import(pathToFileURL(join(program, "core", file)).href);
  const candidate = await load("index.ts");
  const { HostUpdates } = await load("host-updates.ts");
  const updates = new HostUpdates(root, manifest.version, (version: string) => {
    if (!serving || closing || !app || !process.connected) throw Error("本体正在启动或关闭，请稍后确认更新");
    if (!compatibleManager) throw Error(launcherUpgradeNeeded);
    if (activation) throw Error("本体更新正在进行");
    return new Promise<void>((resolve, reject) => {
      activation = { resolve, reject };
      process.send!({ type: "host-activate", version, plugins: activePlugins(), launcherProtocol }, error => {
        if (error) { activation = undefined; reject(error); }
      });
    });
  }, undefined, () => compatibleManager);
  if (mode === "trial") {
    if (typeof candidate.prepareHostTrial !== "function") throw Error("新版程序缺少安全预检入口，已取消更新");
    app = await candidate.prepareHostTrial(root, updates, () => true);
  } else app = await candidate.boot(root, updates, () => !serving);
  shutdown = installProcessLifecycle(app!);
  process.send!({ type: "host-ready", version: manifest.version, plugins: activePlugins() });
}
installLogOutputGuards();
try { await start(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeLogOutput("WhaleLife 启动失败：" + message, "stderr");
  if (process.connected) process.send?.({ type: "host-boot-error", error: message }, () => process.exit(1));
  else process.exit(1);
}
