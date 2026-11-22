/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { launcherUpgradeNeeded } from "./host-launcher-check.ts";
import { directoryAt } from "./official-package-files.ts";
import { latestHostRelease, stageHostRelease, type HostRelease } from "./host-release.ts";
import { hostReleaseDirectory, readHostUpdateState } from "./host-supervisor.ts";

type Result = { status: "updated" | "rolled-back" | "failed"; version: string; message: string; at: string };
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
const conflict = (message: string) => Object.assign(Error(message), { status: 409 });
const marker = ".whalelife-release.json";

export class HostUpdates {
  root: string;
  current: string;
  private activate?: (version: string) => void | Promise<void>;
  private request: typeof fetch;
  private launcherReady: () => boolean;
  private release?: HostRelease | null;
  private checking?: Promise<void>;
  private phase: "idle" | "preparing" | "restarting" = "idle";
  private error?: string;
  private failed?: Result;

  constructor(root: string, current: string, activate?: (version: string) => void | Promise<void>, request = fetch,
    launcherReady: () => boolean = () => false) {
    this.root = root;
    this.current = current;
    this.activate = activate;
    this.request = request;
    this.launcherReady = launcherReady;
  }

  async check() {
    if (this.phase === "idle") {
      this.checking ??= latestHostRelease(this.current, this.request).then(release => {
        this.release = release;
        this.error = undefined;
      }).catch((error: unknown) => {
        this.release = undefined;
        this.error = "检查官方发行版本失败：" + errorMessage(error);
      }).finally(() => { this.checking = undefined; });
      await this.checking;
    }
    return this.view();
  }

  async view() {
    const stored = this.activate ? await readHostUpdateState(this.root) : undefined;
    const lastResult = this.failed ?? stored?.lastResult ?? undefined;
    const supported = !!this.activate && this.launcherReady();
    return { current: this.current, latest: this.release ? { version: this.release.version, url: this.release.url } : null,
      checked: this.release !== undefined, phase: this.phase, supported, lastResult,
      error: this.error ?? (this.release && this.activate && !supported ? launcherUpgradeNeeded : undefined) };
  }

  async apply(input: {version?: unknown; confirmed?: unknown} | null) {
    if (!this.activate) throw conflict("当前启动方式不支持自动重启，请用标准启动入口运行 WhaleLife。");
    if (!this.launcherReady()) throw conflict(launcherUpgradeNeeded);
    if (this.phase !== "idle") throw conflict("本体更新正在进行。");
    const release = this.release;
    if (!release || input?.confirmed !== true || input.version !== release.version)
      throw conflict("请重新检查本体版本，并确认要安装的版本。");
    this.phase = "preparing";
    this.failed = undefined;
    this.error = undefined;
    void this.prepare(release).catch((error: unknown) => {
      this.failed = { status: "failed", version: release.version, message: errorMessage(error), at: new Date().toISOString() };
      this.phase = "idle";
      this.release = undefined;
    });
    return this.view();
  }

  private async prepare(approved: HostRelease) {
    const release = await latestHostRelease(this.current, this.request);
    if (!release || release.version !== approved.version || release.digest !== approved.digest || release.size !== approved.size)
      throw Error("确认后发行版本或摘要已变化，请重新检查并确认。");
    const parent = (await directoryAt(this.root, ".whalelife-updates/releases", true))!;
    const staged = await mkdtemp(join(parent, ".stage-"));
    const target = hostReleaseDirectory(this.root, release.version);
    try {
      await stageHostRelease(release, staged, this.request);
      await writeFile(join(staged, marker), JSON.stringify({version: release.version, digest: release.digest}), {flag: "wx"});
      let previous: string | undefined;
      const existing = await lstat(target).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error("新版暂存路径已被占用。");
        const record = JSON.parse(await readFile(join(target, marker), "utf8"));
        const state = await readHostUpdateState(this.root);
        if (record.version !== release.version || state.active === release.version || state.pending)
          throw Error("既有程序目录正在使用或归属不明。");
        previous = join(parent, ".previous-" + randomUUID());
        await rename(target, previous);
      }
      try { await rename(staged, target); }
      catch (error) { if (previous) await rename(previous, target); throw error; }
      if (previous) await rm(previous, { recursive: true, force: true });
      this.phase = "restarting";
      await this.activate!(release.version);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
}
