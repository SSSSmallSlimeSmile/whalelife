/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { runHostSupervisor } from "./host-supervisor.ts";
import { retireStockHostBackup } from "./host-update-backup.ts";
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";

function send(packet: object) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(Error("原启动器已断开"));
    process.send(packet, error => error ? reject(error) : resolve());
  });
}

// Only the already-running original parent forks the root's forwarded child.
// Fresh launches use the stable manager and fork its colocated worker directly.
export async function runHostLauncherBridge() {
  installLogOutputGuards();
  try {
    const [root, program, mode] = process.argv.slice(2);
    if (!root || !program || !process.connected || !process.send ||
        await realpath(process.cwd()) !== await realpath(root) ||
        await realpath(process.argv[1]) !== join(await realpath(root), "core", "host-child.ts"))
      throw Error("启动器接管需要原实例的工作进程入口");
    if (mode === "trial") {
      await import("./host-child.ts");
      return;
    }
    if (mode !== "active") throw Error("未知的启动器接管模式");

    const controller = new AbortController();
    let receiveServing!: (id: string | null) => void;
    const servingRequest = new Promise<string | null>(resolve => { receiveServing = resolve; });
    let announced = false;
    const stop = () => { controller.abort(); receiveServing(null); };
    const message = (packet: any) => {
      if (packet?.type === "host-stop") stop();
      if (packet?.type === "host-serving" && announced && typeof packet.id === "string")
        receiveServing(packet.id);
    };
    process.on("message", message);
    process.once("disconnect", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!process.connected) stop();
    try {
      process.exitCode = await runHostSupervisor(root, {bridge:{
        program, signal:controller.signal,
        async serving(health, confirm) {
          if (announced || controller.signal.aborted) return;
          announced = true;
          // The original parent immediately performs its legacy recursive cleanup
          // after the first serving acknowledgement. Transfer the fixed backup first.
          await retireStockHostBackup(root).catch((error: Error) =>
            writeLogOutput("旧版更新备份的回收登记暂未完成：" + error.message, "stderr"));
          if (controller.signal.aborted) return;
          await send({ type:"host-ready", version:health.version, plugins:health.plugins });
          const timeout = setTimeout(() => receiveServing(null), 10_000);
          const id = await servingRequest;
          clearTimeout(timeout);
          if (controller.signal.aborted) return;
          if (!id) throw Error("原启动器没有确认工作进程就绪");
          const actual = await confirm();
          if (controller.signal.aborted) return;
          if (!actual || actual.error || actual.version !== health.version)
            throw Error("新启动器的工作进程没有确认接管");
          await send({ type:"host-confirmed", id, version:actual.version, plugins:actual.plugins });
        },
      }});
    } finally {
      process.off("message", message);
      process.off("disconnect", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (process.connected) process.disconnect?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeLogOutput("启动器接管失败：" + detail, "stderr");
    await send({type:"host-boot-error", error:detail}).catch(() => {});
    if (process.connected) process.disconnect?.();
    process.exitCode = 1;
  }
}
