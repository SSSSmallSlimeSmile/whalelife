/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { checkHostTrialEntry, launcherFingerprint, launcherProtocol, launcherUpgradeNeeded } from "./host-launcher-check.ts";
import { directoryAt } from "./instance-directory.ts";
import { collectRetiredHostBackups, prepareHostBackup, restoreHostBackup, retireHostBackup, validHostBackupSlot } from "./host-update-backup.ts";
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";

const base = ".whalelife-updates";
const validVersion = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(v);
export const hostUpdateDirectory = (root: string) => join(root, base);
export function hostReleaseDirectory(root: string, version: string) {
  if (!validVersion(version)) throw Error("本体版本号无效");
  return join(hostUpdateDirectory(root), "releases", version);
}
type Outcome = "updated" | "rolled-back" | "failed";
export interface HostUpdateState {
  active: string | null;
  pending: string | null;
  phase?: "preparing" | "trial" | "handover";
  backupSlot?: string;
  // Older trials booted real plugins and may already have delivered external work.
  preflightOnly?: true;
  rollbackFailure?: { trigger: string; detail: string };
  delivery?: { previous: string | null; plugins: string[] };
  lastResult: { status: Outcome; version: string; message: string; at: string } | null;
}
function parseState(raw: string): HostUpdateState {
  const s = JSON.parse(raw);
  if (s?.windowsJournal === true) throw Error("缺少本体更新事务数据库，请保留现有资料与快照，核对 state.sqlite 后重启。");
  if (!s || !(s.active === null || validVersion(s.active)) ||
    !(s.pending === null || (validVersion(s.pending) && ["preparing", "trial", "handover"].includes(s.phase))) ||
    (s.backupSlot !== undefined && !validHostBackupSlot(s.backupSlot)) ||
    (s.rollbackFailure !== undefined && (!s.pending || typeof s.rollbackFailure?.trigger !== "string" ||
      typeof s.rollbackFailure?.detail !== "string")) ||
    (s.delivery !== undefined && !(s.pending === null && validVersion(s.active) && s.delivery &&
      (s.delivery.previous === null || validVersion(s.delivery.previous)) &&
      Array.isArray(s.delivery.plugins) && s.delivery.plugins.every((id: unknown) => typeof id === "string"))) ||
    !(s.lastResult === null || (s.lastResult && validVersion(s.lastResult.version) &&
      ["updated", "failed", "rolled-back"].includes(s.lastResult.status) &&
      typeof s.lastResult.message === "string" && typeof s.lastResult.at === "string")))
    throw Error("本体更新状态无效，请检查状态文件");
  return s;
}
async function readJSON(dir: string) {
  const path = join(dir, "state.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw Error("本体状态文件异常");
    return parseState(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return { active: null, pending: null, lastResult: null };
    throw error;
  }
}
// Windows does not provide POSIX directory fsync for a replaced JSON file. Keep
// the decision in a FULL-sync SQLite transaction and mirror it for older programs.
async function windowsJournal(dir: string, create: boolean) {
  const path = join(dir, "state.sqlite");
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!stat && (!create || process.platform !== "win32")) return;
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw Error("本体更新事务数据库无效");
  const { DatabaseSync } = await import("node:sqlite");
  if (!stat) {
    const initial = await readJSON(dir);
    const tmp = join(dir, "state-" + randomUUID() + ".sqlite.tmp");
    try {
      const first = new DatabaseSync(tmp);
      try {
        first.exec("PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE; CREATE TABLE host_state (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)");
        first.prepare("INSERT INTO host_state VALUES (1, ?)").run(JSON.stringify(initial));
        first.exec("COMMIT");
      } finally { first.close(); }
      // Publish only a complete database. A crash before this rename leaves the old
      // JSON authoritative and a later launch can start the migration again.
      await rename(tmp, path);
    } finally { await unlink(tmp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA");
    return db;
  } catch (error) { db.close(); throw error; }
}
export async function readHostUpdateState(root: string): Promise<HostUpdateState> {
  const dir = await directoryAt(root, base);
  if (!dir) return { active: null, pending: null, lastResult: null };
  const db = await windowsJournal(dir, false);
  if (!db) return readJSON(dir);
  try {
    const record = db.prepare("SELECT state FROM host_state WHERE id=1").get();
    if (typeof record?.state !== "string") throw Error("本体更新事务记录缺失，请保留现场并核对 state.sqlite");
    return parseState(record.state);
  } finally { db.close(); }
}
async function save(root: string, state: HostUpdateState) {
  const dir = (await directoryAt(root, base, true))!;
  const tmp = join(dir, "state-" + randomUUID() + ".tmp");
  const db = await windowsJournal(dir, true);
  try {
    if (db) {
      db.exec("BEGIN IMMEDIATE");
      if (db.prepare("UPDATE host_state SET state=? WHERE id=1").run(JSON.stringify(state)).changes !== 1)
        throw Error("本体更新事务记录缺失");
    }
    const out = await open(tmp, "wx", 0o600);
    try { await out.writeFile(JSON.stringify(db ? { ...state, windowsJournal: true } : state)); await out.sync(); }
    finally { await out.close(); }
    await rename(tmp, join(dir, "state.json"));
    if (db) db.exec("COMMIT");
    else {
      const folder = await open(dir, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    }
  } finally {
    db?.close(); // Also rolls back an incomplete transaction if the JSON mirror failed.
    await unlink(tmp).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
}

// Kernel-owned locks disappear with the owner even if it crashes. No PID is used to signal or kill a process.
export async function holdHostLock(root: string, role: "manager" | "worker" | "takeover", waitMs = 0) {
  // macOS and other Unix hosts lack Linux's abstract socket namespace. A SQLite exclusive
  // transaction is process-owned too, without leaving a stale bound socket path after a crash.
  if (process.platform !== "win32" && process.platform !== "linux") {
    const directory = (await directoryAt(root, base + "/locks", true))!;
    const path = join(directory, role + ".sqlite");
    const file = await open(path, "ax", 0o600).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    if (file) await file.close();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("本体实例锁文件无效");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(waitMs))}; BEGIN EXCLUSIVE`);
      return async () => db.close();
    } catch (error: any) {
      db.close();
      if (error.errcode === 5) throw Object.assign(Error("此 WhaleLife 实例仍在运行或关闭中，请稍后再启动"), {code:"WHALELIFE_INSTANCE_LOCKED"});
      throw error;
    }
  }
  let canonical = await realpath(root);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const key = createHash("sha256").update(canonical + "\0" + role).digest("hex");
  const endpoint = { path: process.platform === "win32" ? "\\\\.\\pipe\\whalelife-" + key : "\0wl-" + key };
  const limit = Date.now() + waitMs;
  for (;;) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(endpoint, done); });
      return () => new Promise<void>(done => server.close(() => done()));
    } catch (error: any) {
      if (error.code !== "EADDRINUSE") throw error;
      if (Date.now() >= limit) throw Object.assign(Error("此 WhaleLife 实例仍在运行或关闭中，请稍后再启动"), {code:"WHALELIFE_INSTANCE_LOCKED"});
      await delay(200);
    }
  }
}

type Health = { version: string; plugins: string[]; error?: string };
type Activation = { version: string; plugins: string[]; launcherProtocol?: string };
const childEntry = fileURLToPath(new URL("./host-child.ts", import.meta.url));
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function launch(root: string, program: string, trial: boolean) {
  const child = fork(childEntry, [root, program, trial ? "trial" : "active"], {
    cwd: root, execArgv: [], stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
  });
  const ready = deferred<Health | null>();
  let activation = deferred<Activation | null>();
  const exited = deferred<number>();
  let failure = "";
  let ended = false;
  let probe: { id: string; resolve: (health: Health | null) => void } | undefined;
  child.on("message", (packet: any) => {
    if (packet?.type === "host-boot-error") { failure = String(packet.error).slice(0, 400); return; }
    if (!validVersion(packet?.version) || !Array.isArray(packet.plugins) || !packet.plugins.every((x: unknown) => typeof x === "string")) return;
    if (packet.type === "host-ready") ready.resolve(packet);
    if (packet.type === "host-confirmed" && probe && packet.id === probe.id) probe.resolve(packet);
    if (packet.type === "host-activate") activation.resolve(packet);
  });
  const end = (code: number) => { ended = true; ready.resolve(null); activation.resolve(null); probe?.resolve(null); exited.resolve(code); };
  child.on("error", error => { failure = error.message; if (!child.pid) end(1); });
  child.once("exit", code => end(code ?? 1));
  const send = (type: string, error?: string) => { if (child.connected) child.send({ type, error }, () => {}); };
  return {
    ready: ready.promise, next: async () => {
      if (ended) return null;
      const request = await activation.promise;
      activation = deferred<Activation | null>();
      return request;
    },
    reject: (message: string) => send("host-activation-error", message),
    exit: exited.promise,
    health: async (serve: boolean, required: string[] = []) => {
      if (ended || !child.connected) return null;
      const reply = deferred<Health | null>();
      probe = { id: randomUUID(), resolve: reply.resolve };
      const timer = setTimeout(() => reply.resolve(null), 10_000);
      try {
        child.send({ type: serve ? "host-serving" : "host-probe", id: probe.id, required, launcherProtocol }, error => { if (error) reply.resolve(null); });
        return await reply.promise;
      } finally { clearTimeout(timer); probe = undefined; }
    },
    stop: () => send("host-stop"),
    terminateTrial: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
    error: () => failure || "子进程在完成启动检查前退出",
  };
}

const result = (status: Outcome, version: string, message: string) => ({ status, version, message, at: new Date().toISOString() });
async function recover(root: string, state: HostUpdateState, message: string) {
  if (!state.pending) return state;
  const trigger = state.rollbackFailure?.trigger ?? message;
  if (state.phase === "trial" || state.phase === "handover") {
    if (state.preflightOnly !== true) throw Error("旧启动器的更新中断，插件可能已执行外部操作。请先复制整个实例目录，核对现有插件投递记录及 .whalelife-updates/backup；确认要保留的程序和资料后再恢复启动。现场、旧快照和 state.json 均已保留。");
    try {
      await restoreHostBackup(root, state.backupSlot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = { trigger: trigger.slice(0, 2048), detail: detail.slice(0, 2048) };
      // Keep the pending selection and snapshot intact. A later retry can report the
      // original trial failure even after a second failure while restoring files.
      try { await save(root, { ...state, rollbackFailure: failure }); }
      catch (journalError) { writeLogOutput("无法记录本体回滚失败详情：" + String(journalError), "stderr"); }
      throw Error(`本体 v${state.pending} 更新中断：${trigger}。恢复升级前资料失败：${detail}`, { cause: error });
    }
  }
  const restored: HostUpdateState = { active: state.active, pending: null, backupSlot: state.backupSlot, lastResult: result("rolled-back", state.pending, trigger) };
  await save(root, restored);
  return restored;
}

interface SupervisorOptions {
  healthTimeoutMs?: number;
  /** An original manager still owns the outer lock and delegates its active worker slot. */
  bridge?: {
    program: string;
    signal: AbortSignal;
    serving(health: Health, confirm: () => Promise<Health | null>): Promise<void>;
  };
}

// The manager always forks its own matching worker, independently of the selected program.
export async function runHostSupervisor(instanceRoot: string, options: SupervisorOptions = {}) {
  installLogOutputGuards();
  const root = await realpath(instanceRoot);
  const unlock = options.bridge ? undefined : await holdHostLock(root, "manager");
  let releaseTakeover: (() => Promise<void>) | undefined;
  let child: ReturnType<typeof launch> | undefined;
  let stopping = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanup = Promise.resolve();
  const stop = () => { stopping = true; child?.stop(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  options.bridge?.signal.addEventListener("abort", stop, {once:true});
  try {
    // If the original parent dies, a cold start may win its outer lock while the
    // delegated manager is still draining. Serialize both before journal recovery.
    releaseTakeover = await holdHostLock(root, "takeover", options.bridge ? 0 : 30_000);
    if (options.bridge?.signal.aborted) return 0;
    if (options.bridge) {
      const unexpected = await holdHostLock(root, "manager").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "WHALELIFE_INSTANCE_LOCKED") throw error;
      });
      if (unexpected) {
        await unexpected();
        throw Error("原管理器未持有此实例的启动锁，已取消接管。");
      }
    }
    // A previous parent may have been forcibly terminated while its worker is still draining.
    // Wait for that worker's kernel lock before reading a pending trial or touching its backup.
    const startupFingerprint = await launcherFingerprint(root);
    await (await holdHostLock(root, "worker", 30_000))();
    let state = await readHostUpdateState(root);
    if (stopping) return 0;
    if (options.bridge) {
      const selected = state.active === null ? root : hostReleaseDirectory(root, state.active);
      if (state.pending || state.delivery || await realpath(selected) !== await realpath(options.bridge.program))
        throw Error("原启动器选择的运行程序与已提交的本体版本不符，已保留实例资料。");
    }
    let previousPlugins: string[] = [];
    if (state.delivery) {
      // In the older protocol this selected worker may already have accepted writes.
      // Treat an outstanding acknowledgement as committed, including if its next boot fails.
      state = { active: state.active, pending: null, backupSlot: state.backupSlot, lastResult: result("updated", state.active!, "沿用上次接管选定的版本，已保留现有资料") };
      await save(root, state);
    } else {
      state = await recover(root, state, "上次更新中断");
    }
    const cleanLater = () => {
      clearTimeout(cleanupTimer);
      cleanup = cleanup.then(async () => {
        if (stopping) return;
        const pending = await collectRetiredHostBackups(root);
        if (pending && !stopping) {
          clearTimeout(cleanupTimer);
          cleanupTimer = setTimeout(cleanLater, 60_000).unref();
        }
      }).catch((e: Error) => { writeLogOutput("更新备份暂未清理：" + e.message, "stderr"); });
    };
    while (!stopping) {
      const trial = state.pending !== null;
      const version = state.pending ?? state.active;
      let reason = "";
      try {
        const program = version === null ? root : await directoryAt(root, base + "/releases/" + version);
        if (!program) throw Error("更新程序目录不存在");
        if (stopping) return 0;
        child = launch(root, program, trial);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let health: Health | null;
        try {
          health = trial ? await Promise.race([child.ready, new Promise<null>(done => {
            deadline = setTimeout(() => { reason = "新版在限定时间内未完成启动检查"; done(null); }, options.healthTimeoutMs ?? 180_000);
          })]) : await child.ready;
        } finally { clearTimeout(deadline); }
        if (!health) throw Error(reason || child.error());
        if (version !== null && health.version !== version) throw Error("启动的程序版本和确认的更新版本不同");
        if (trial) {
          // The trial runs core startup with all plugin code and user APIs gated.
          if (await Promise.race([child.exit.then(() => true), delay(500, false)])) throw Error("新版启动后立即退出");
          const checked = await child.health(false);
          if (!checked || checked.version !== version) throw Error("新版未通过启动后的健康检查");
          if (checked.error) throw Error(checked.error);
          if (stopping) throw Error("更新在启动检查期间中断");
          state = { ...state, phase: "handover" };
          await save(root, state);
          // Keep public traffic gated during the final readiness round trip. Interruption here
          // leaves the previous active version and its complete rollback snapshot in the journal.
          const armed = await child.health(false, previousPlugins);
          if (armed?.error) throw Error(armed.error);
          if (!armed || armed.version !== version || stopping)
            throw Error("新版未能确认接管服务");
          child.stop();
          const status = await child.exit;
          child = undefined;
          if (status !== 0 || stopping) throw Error("新版预检未正常结束");
          // No worker is running. Make the selection irreversible before forking a
          // process capable of importing installed plugins or serving real requests.
          const selected: HostUpdateState = { active: version, pending: null, backupSlot: state.backupSlot, lastResult: result("updated", version!, "新版核心及原有插件文件已通过预检，已切换版本") };
          await save(root, selected);
          state = selected;
          continue;
        }
        const worker = child;
        const serving = await worker.health(true);
        if (!serving || serving.error || serving.version !== health.version) throw Error("本体启动后未响应健康检查");
        if (options.bridge) await options.bridge.serving(serving, () => worker.health(true));
        // The previous worker is already serving. Retire only the completed transaction's slot.
        if (state.lastResult) await retireHostBackup(root, state.backupSlot)
          .catch((e: Error) => writeLogOutput("更新备份已保留：" + e.message, "stderr"));
        cleanLater();
        let next: Activation | null;
        for (;;) {
          next = await child.next();
          if (!next || stopping) { if (stopping) child.stop(); return await child.exit; }
          try {
            if (next.version === health.version) throw Error("本体已运行该版本");
            if (next.launcherProtocol !== launcherProtocol) throw Error(launcherUpgradeNeeded);
            const candidate = await directoryAt(root, base + "/releases/" + next.version);
            if (!candidate) throw Error("新版暂存目录不存在。");
            await checkHostTrialEntry(candidate);
            if (await launcherFingerprint(root) !== startupFingerprint)
              throw Error("安装根目录的启动程序在运行期间已改变。请重新启动 WhaleLife 后再更新。");
            const preparing: HostUpdateState = { ...state, pending: next.version, phase: "preparing", backupSlot: "backup-" + randomUUID() };
            await save(root, preparing);
            state = preparing;
            break;
          } catch (error: any) { child.reject("无法准备本体更新：" + error.message); }
        }
        previousPlugins = next.plugins;
        child.stop();
        const status = await child.exit;
        child = undefined;
        try {
          if (status !== 0 || stopping) throw Error("原实例未正常结束，已取消切换");
          await prepareHostBackup(root, state.backupSlot);
          const testing: HostUpdateState = { ...state, phase: "trial", preflightOnly: true };
          await save(root, testing);
          state = testing;
        } catch (error: any) {
          const original: HostUpdateState = { active: state.active, pending: null, backupSlot: state.backupSlot, lastResult: result("failed", next.version, error.message) };
          await save(root, original);
          state = original;
        }
        continue;
      } catch (error: any) { reason = error.message; }
      if (child) {
        if (trial) {
          // A partially booted or wedged trial cannot own any user traffic. Its stable backup is still intact.
          child.terminateTrial();
        } else child.stop();
        await child.exit;
        child = undefined;
      }
      if (!trial) {
        if (stopping) return 0;
        throw Error(reason);
      }
      // A disk error at commit can have an uncertain result. Only the durable
      // journal may authorize restoration, even while the same manager is alive.
      state = await readHostUpdateState(root);
      if (state.pending === null && state.active === version) continue;
      if (state.pending !== version) throw Error("更新事务记录与当前预检不符，已保留现场：" + reason);
      state = await recover(root, state, reason);
    }
    return 0;
  } finally {
    stopping = true;
    clearTimeout(cleanupTimer);
    if (child) { child.stop(); await child.exit; }
    await cleanup;
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    options.bridge?.signal.removeEventListener("abort", stop);
    try { await releaseTakeover?.(); } finally { await unlock?.(); }
  }
}
