/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// This protocol stages and probes the new core without running plugins before committing.
export const launcherProtocol = "separate-trial-v1";
export const launcherUpgradeNeeded = "当前安装根目录的启动器不支持新版安全预检。请先更新根目录的启动程序并重新启动 WhaleLife，再检查更新。";

export async function launcherFingerprint(root?: string) {
  const files = await Promise.all(["host-supervisor.ts", "host-child.ts", "host-launcher-check.ts"].map(name =>
    readFile(new URL(name, import.meta.url))));
  const directory = dirname(fileURLToPath(import.meta.url));
  if (root && dirname(directory) === join(root, ".whalelife-updates", "launchers") && /^[a-f0-9]{64}$/.test(basename(directory))) {
    const core = join(root, "core");
    if (await realpath(core) !== core) throw Error("安装根目录的启动器路径无效。");
    for (const name of ["host-supervisor.ts", "host-child.ts"]) {
      const path = join(core, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("安装根目录的启动器入口无效。");
      files.push(await readFile(path));
    }
  }
  return files.map(bytes => createHash("sha256").update(bytes).digest("hex")).join(":");
}

const execute = promisify(execFile);
export async function checkHostTrialEntry(program: string) {
  const entry = pathToFileURL(join(program, "core", "index.ts")).href;
  // ESM links every static named import before evaluating the first dependency.
  // Exit from that first dependency so none of the candidate's modules run.
  const check = "import 'data:text/javascript,process.exit(0)'; import {boot,prepareHostTrial} from " +
    JSON.stringify(entry) + ";";
  try {
    await execute(process.execPath, ["--input-type=module", "--eval", check], {
      cwd: program, env: {SystemRoot: process.env.SystemRoot}, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw Error("新版的启动或安全预检入口无法加载。请核对已发布的本体安装包。", {cause:error});
  }
}
