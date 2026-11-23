/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import {
  mkdir,
  readFile,
  appendFile,
  writeFile,
  rename,
  readdir,
  open,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import { join, dirname, relative, resolve, sep, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "./logger.ts";
export const safeId = (id: string) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw Error("会话 ID 无效");
  return id;
};
export type SessionIndex = {
  version?: number;
  sessions: Record<string, any>;
  [key: string]: any;
};
export function parseSessionIndex(raw: string): SessionIndex {
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions)
  )
    throw Error("会话索引损坏，请从备份恢复，未覆盖现有索引");
  return value;
}
export function indexSessionMeta(index: SessionIndex, id: string) {
  const value = Object.hasOwn(index.sessions, id) ? index.sessions[id] : null;
  if (
    value !== null &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw Error("会话索引记录损坏，请从备份恢复");
  return value;
}
export async function atomic(file: string, data: string) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Windows readers can briefly hold a handle without delete sharing. Keep the
    // old file and the complete temp intact while retrying the atomic replace.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file);
        break;
      } catch (error: any) {
        if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code))
          throw error;
        await delay((attempt + 1) * 10);
      }
    }
  } finally {
    await unlink(temp).catch((error: any) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function directory(path: string) {
  const absolute = resolve(path),
    anchor = parse(absolute).root;
  let current = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Error("记忆路径不能经过链接或普通文件");
  }
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function regularTree(folder: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name),
      info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    )
      throw Error("记忆中不允许链接或特殊文件");
    if (info.isDirectory()) result.push(...(await regularTree(path)));
    else result.push(path);
  }
  return result;
}
export class Memory {
  root: string;
  logger: Logger;
  queue: Promise<any> = Promise.resolve();
  onChange?: (name: string, payload: any) => void;
  notify(name: string, payload: any) {
    try { this.onChange?.(name, payload); }
    catch (error) { this.logger.warn("记忆通知失败", { error }); }
  }
  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger;
  }
  sessionDir(id: string) {
    return join(this.root, "sessions", safeId(id));
  }
  async episodePaths(id: string) {
    const directory = join(this.sessionDir(id), "episodes");
    if (await exists(directory)) {
      const parent = await lstat(this.sessionDir(id));
      if (parent.isSymbolicLink() || !parent.isDirectory())
        throw Error("记忆目录不能为链接");
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Error("记忆目录不能为链接");
      return (await readdir(directory))
        .filter(
          (name) =>
            /^\d{4}-\d{2}\.jsonl$/.test(name) || name === "legacy.jsonl",
        )
        .sort((a, b) =>
          a === "legacy.jsonl"
            ? -1
            : b === "legacy.jsonl"
              ? 1
              : a.localeCompare(b),
        )
        .map((name) => join(directory, name));
    }
    const legacy = join(this.root, "sessions", safeId(id) + ".jsonl");
    return (await exists(legacy)) ? [legacy] : [];
  }
  async summaryPath(id: string) {
    safeId(id);
    const index = await this.sessionIndex(),
      owner = index.summaryOwners?.[id];
    if (typeof owner === "string")
      return join(this.sessionDir(owner), "summaries", id + ".md");
    return join(this.root, "summaries", id + ".md");
  }
  async init() {
    for (const dir of ["sessions", "summaries", "personas"])
      await directory(join(this.root, dir));
    try {
      await writeFile(join(this.root, "facts.md"), "# facts\n", { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      await writeFile(
        join(this.root, "index.json"),
        JSON.stringify({ version: 1, sessions: {} }, null, 2),
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    await this.migrate();
    this.logger.info("记忆就绪", { root: this.root });
  }
  // Startup/restore only, before requests can write. Every legacy source survives in a verified backup.
  async migrate() {
    const index = await this.sessionIndex();
    const legacy = (await readdir(join(this.root, "sessions"))).filter(
      (name) =>
        /^[a-zA-Z0-9_-]{1,100}\.jsonl$/.test(name) &&
        !indexSessionMeta(index, name.slice(0, -6))?.deleted,
    );
    if (legacy.length) {
      const files = await regularTree(this.root);
      const backup = join(
        dirname(resolve(this.root)),
        "backups",
        "memory-migration",
        randomUUID(),
      );
      if (resolve(backup).startsWith(resolve(this.root) + sep))
        throw Error("迁移备份不能放在记忆目录内");
      await directory(join(backup, "data"));
      const manifest: any[] = [];
      for (const file of files) {
        const path = relative(this.root, file),
          value = await readFile(file);
        const target = join(backup, "data", path);
        await directory(dirname(target));
        await writeFile(target, value, { flag: "wx" });
        const sha256 = createHash("sha256").update(value).digest("hex");
        if (
          createHash("sha256")
            .update(await readFile(target))
            .digest("hex") !== sha256
        )
          throw Error("迁移备份校验失败");
        manifest.push({
          path: path.split(sep).join("/"),
          bytes: value.length,
          sha256,
        });
      }
      await writeFile(
        join(backup, "manifest.json"),
        JSON.stringify(
          {
            version: 1,
            kind: "before-memory-v2",
            created_at: new Date().toISOString(),
            files: manifest,
          },
          null,
          2,
        ),
      );
      for (const name of legacy) {
        const id = name.slice(0, -6),
          source = join(this.root, "sessions", name);
        if (indexSessionMeta(index, id)?.deleted) continue;
        const folder = this.sessionDir(id),
          target = join(folder, "episodes", "legacy.jsonl");
        await directory(dirname(target));
        const raw = await readFile(source, "utf8");
        const rows: any[] = [];
        const lines = raw.split("\n");
        for (let n = 0; n < lines.length; n++) {
          if (!lines[n].trim()) continue;
          try {
            const row = JSON.parse(lines[n]);
            if (!row || typeof row !== "object" || Array.isArray(row))
              throw Error("无效记录");
            row.id ??=
              "legacy_" +
              createHash("sha256")
                .update(id + ":" + n + ":" + lines[n])
                .digest("hex")
                .slice(0, 32);
            rows.push(row);
          } catch {
            if (n !== lines.length - 1)
              throw Error("迁移中止：JSONL 中间行损坏，原件和备份均保留");
            this.logger.warn("迁移时忽略最后半行，原件保存在备份", { id });
          }
        }
        const content =
          rows.map((row) => JSON.stringify(row)).join("\n") +
          (rows.length ? "\n" : "");
        if (await exists(target)) {
          if ((await readFile(target, "utf8")) !== content)
            throw Error("迁移目标与旧档案不一致，未覆盖");
        } else await atomic(target, content);
        index.summaryOwners ??= {};
        const migratedSummaries = new Set<string>();
        for (const summary of [
          id,
          ...rows
            .map((row) => row.summary_id)
            .filter(
              (value) =>
                typeof value === "string" &&
                /^[a-zA-Z0-9_-]{1,100}$/.test(value),
            ),
          ...rows.flatMap((row) =>
            typeof row.persona_revision === "string"
              ? ["", ":session"].map(
                  (scope) =>
                    "p_" +
                    createHash("sha256")
                      .update(id + ":" + row.persona_revision + scope)
                      .digest("hex")
                      .slice(0, 40),
                )
              : [],
          ),
        ]) {
          const old = join(this.root, "summaries", summary + ".md");
          if (!(await exists(old))) continue;
          const dest = join(folder, "summaries", summary + ".md");
          await directory(dirname(dest));
          if (!(await exists(dest)))
            await atomic(dest, await readFile(old, "utf8"));
          index.summaryOwners = { ...index.summaryOwners, [summary]: id };
          migratedSummaries.add(old);
        }
        const meta = {
          ...indexSessionMeta(index, id),
          file: `sessions/${id}/episodes/legacy.jsonl`,
          format: 2,
        };
        index.sessions = { ...index.sessions, [id]: meta };
        await atomic(
          join(folder, "session.json"),
          JSON.stringify(meta, null, 2),
        );
        index.version = 2;
        await atomic(
          join(this.root, "index.json"),
          JSON.stringify(index, null, 2),
        );
        // Owner mapping is durable before removing legacy copies; interrupted migration can resume.
        for (const old of migratedSummaries) await unlink(old);
        await unlink(source);
      }
      this.logger.info("旧记忆迁移完成", { sessions: legacy.length, backup });
    }
    index.version = 2;
    await atomic(join(this.root, "index.json"), JSON.stringify(index, null, 2));
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async sessionIndex(): Promise<SessionIndex> {
    try {
      return parseSessionIndex(
        await readFile(join(this.root, "index.json"), "utf8"),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return { version: 1, sessions: {} };
      throw error;
    }
  }
  // Atomic index replacement makes this a snapshot read, so callers holding serial can use it too.
  async sessionMeta(id: string) {
    return indexSessionMeta(await this.sessionIndex(), safeId(id));
  }
  // Includes deletion tombstones so channel bindings cannot silently resurrect them.
  async listSessionMeta() {
    return this.serial(async () => {
      const index = await this.sessionIndex();
      return Object.fromEntries(
        Object.keys(index.sessions).map((id) => [id, indexSessionMeta(index, id)]),
      );
    });
  }
  /** One authoritative selection, committed in the same queue as deletion and restore. */
  currentSession(input: { id?: string; create?: boolean; legacyId?: string } = {}, guard: (id?: string) => void = () => {}) {
    return this.serial(async () => {
      guard();
      const index = await this.sessionIndex();
      const live = (id: string) => !!indexSessionMeta(index, safeId(id)) && !indexSessionMeta(index, id)?.deleted;
      if (input.create !== undefined && typeof input.create !== "boolean") throw Error("新建会话参数无效");
      if (input.id !== undefined && input.create) throw Error("不能同时选择和新建会话");
      let id = input.id;
      if (id !== undefined && !live(id)) throw Error("请选择存在且未删除的会话");
      if (id === undefined && !input.create) {
        if (index.current_session !== undefined && live(index.current_session)) id = index.current_session;
        // A stale browser is never allowed to replace an established server selection.
        else if (index.current_session === undefined && typeof input.legacyId === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(input.legacyId) && live(input.legacyId)) id = input.legacyId;
        else id = Object.entries(index.sessions).filter(([key]) => live(key)).reverse()
          .sort((a, b) => String(b[1].updatedAt ?? "").localeCompare(String(a[1].updatedAt ?? "")))[0]?.[0];
      }
      const created = id === undefined;
      id ??= "web_" + randomUUID().replaceAll("-", "");
      guard(id);
      if (id === index.current_session) return id;
      if (created) {
        index.sessions[id] = { createdAt: new Date().toISOString() };
        await directory(this.sessionDir(id));
      }
      guard(id);
      index.current_session = id;
      await atomic(join(this.root, "index.json"), JSON.stringify(index, null, 2));
      if (created) {
        try { await atomic(join(this.sessionDir(id), "session.json"), JSON.stringify(index.sessions[id], null, 2)); }
        catch (error) { this.logger.warn("当前会话已保存，元数据副本更新失败", { id, error }); }
      }
      return id;
    });
  }
  /** Channel route/receipt commits share the authoritative index transaction. */
  channelRoute<T>(
    key: string,
    update: (route: any, sessions: Record<string, any>) => Promise<{ route?: any; result: T }>,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error("渠道绑定键无效");
    return this.serial(async () => {
      const index = await this.sessionIndex();
      if (index.channel_routes !== undefined && (!index.channel_routes || typeof index.channel_routes !== "object" || Array.isArray(index.channel_routes)))
        throw Error("渠道回执索引损坏，请检查记忆备份");
      const changed = await update(index.channel_routes?.[key], index.sessions);
      if (changed.route === undefined) return changed.result;
      const route = changed.route, id = safeId(route.sessionId);
      const binding = { channel: route.channel, account: route.account, peer: route.peer, owner: route.owner };
      const mirrors = new Set<string>();
      for (const other of Object.keys(index.sessions)) {
        const meta = indexSessionMeta(index, other);
        if (other === id || !meta?.channel_bindings?.[key]) continue;
        const bindings = { ...meta.channel_bindings };
        delete bindings[key];
        index.sessions[other] = { ...meta, channel_bindings: bindings };
        if (!meta.deleted) mirrors.add(other);
      }
      const previous = indexSessionMeta(index, id);
      if (JSON.stringify(previous?.channel_bindings?.[key]) !== JSON.stringify(binding)) {
        if (previous?.deleted) throw Error("渠道绑定的会话已删除");
        index.sessions[id] = { ...previous, channel_bindings: { ...previous?.channel_bindings, [key]: binding } };
        mirrors.add(id);
      }
      for (const sessionId of mirrors) await directory(this.sessionDir(sessionId));
      index.channel_routes = { ...index.channel_routes, [key]: route };
      // One rename commits the route, both binding ends and all deduplication receipts.
      await atomic(join(this.root, "index.json"), JSON.stringify(index, null, 2));
      for (const sessionId of mirrors) {
        try {
          await atomic(join(this.sessionDir(sessionId), "session.json"), JSON.stringify(index.sessions[sessionId], null, 2));
        } catch (error) {
          // session.json is a projection. Never report an already committed CAS as failed.
          this.logger.warn("渠道绑定已保存，会话元数据副本更新失败", { sessionId, error });
        }
      }
      return changed.result;
    });
  }
  saveSessionMeta(id: string, patch: Record<string, unknown>, guard?: () => void) {
    safeId(id);
    return this.serial(async () => {
      guard?.();
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw Error("会话元数据无效");
      const index = await this.sessionIndex(),
        previous = indexSessionMeta(index, id);
      guard?.();
      if (previous?.deleted) throw Error("会话已删除，请新建会话");
      const meta = { ...previous, ...patch };
      index.sessions = { ...index.sessions, [id]: meta };
      await atomic(
        join(this.root, "index.json"),
        JSON.stringify(index, null, 2),
      );
      await directory(this.sessionDir(id));
      await atomic(
        join(this.sessionDir(id), "session.json"),
        JSON.stringify(meta, null, 2),
      );
      return meta;
    });
  }
  async readFacts() {
    return (await readFile(join(this.root, "facts.md"), "utf8"))
      .split(/\r?\n/)
      .filter((x) => x.trim() && !x.startsWith("#"));
  }
  writeFacts(lines: string[]) {
    return this.serial(() =>
      atomic(
        join(this.root, "facts.md"),
        "# facts\n" + lines.join("\n") + "\n",
      ),
    );
  }
  addFact(text: string) {
    return this.serial(async () => {
      text = text.replace(/[\r\n]+/g, " ").trim();
      if (!text || text.startsWith("#") || text.length > 2000)
        throw Error("事实不能为空或超过 2000 字");
      await appendFile(join(this.root, "facts.md"), text + "\n");
      this.logger.info("记忆事实追加", { file: "facts.md", count: 1 });
      return "已记下：" + text;
    });
  }
  async readSession(id: string, limit = Infinity) {
    const result: any[] = [];
    for (const file of await this.episodePaths(id)) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw Error("记忆文件不能为链接");
      const lines = (await readFile(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          result.push(JSON.parse(lines[i]));
        } catch {
          if (i !== lines.length - 1) throw Error("JSONL 中间行损坏：" + file);
          this.logger.warn("忽略 JSONL 最后半行", { file });
        }
      }
    }
    return result.slice(-limit);
  }
  /**
   * 只解析末尾 window 行。长会话翻页时不必把整份历史都 JSON.parse 一遍：
   * 读文件仍然是一次顺序读，但解析量被压到一页。
   * start 是窗口第一行在整个会话里的行号，0 表示窗口盖到了开头。
   */
  /** 行数按 (大小, 行数) 记住：会话文件只追加，下一次数新增那段就够。 */
  private lineCounts = new Map<string, { size: number; lines: number }>();
  private async countLines(file: string) {
    const info = await stat(file);
    const cached = this.lineCounts.get(file);
    if (cached && cached.size === info.size) return cached.lines;
    const from = cached && cached.size < info.size ? cached.size : 0;
    let lines = from ? cached!.lines : 0;
    const handle = await open(file, "r");
    try {
      const chunk = 1 << 16;
      const buffer = Buffer.alloc(chunk);
      let position = from;
      while (position < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(chunk, info.size - position), position);
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 10) lines += 1;
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    this.lineCounts.set(file, { size: info.size, lines });
    return lines;
  }
  /** 只把文件末尾 wanted 行读回来：翻一页不必把整份历史重新读一遍。 */
  private async tailLines(file: string, wanted: number) {
    const info = await stat(file);
    if (!info.size || wanted <= 0) return [] as string[];
    const handle = await open(file, "r");
    try {
      let span = Math.max(1 << 16, wanted * 256);
      for (;;) {
        const from = Math.max(0, info.size - span);
        const buffer = Buffer.alloc(info.size - from);
        await handle.read(buffer, 0, buffer.length, from);
        const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim());
        if (from === 0 || lines.length >= wanted) {
          // 从中间读起时第一行多半是被截断的半行，丢掉
          if (from > 0 && lines.length) lines.shift();
          return lines.slice(-wanted);
        }
        span *= 2;
      }
    } finally {
      await handle.close();
    }
  }
  /**
   * 只解析 start..end 这一段的行。翻旧页时用 until 定住终点：
   * 以前是先取文件尾巴再过滤，窗口一涨就把整份历史的 JSON 全 parse 一遍。
   */
  /**
   * 取一段行 [from, to)。贴到文件末尾时只读尾巴；否则整份读进来再切——
   * 但切完只解析这一段，翻旧页不该把几万行 JSON 全 parse 一遍。
   */
  private async segmentLines(file: string, count: number, from: number, to: number) {
    const wanted = to - from;
    if (wanted <= 0) return [] as string[];
    if (to === count) return this.tailLines(file, wanted);
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    return lines.slice(from, to);
  }
  async readSessionWindow(id: string, window: number, until?: number) {
    const paths = await this.episodePaths(id);
    for (const file of paths) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw Error("记忆文件不能为链接");
    }
    const size = Math.max(1, Math.floor(window));
    const counts: number[] = [];
    for (const file of paths) counts.push(await this.countLines(file));
    const total = counts.reduce((sum, value) => sum + value, 0);
    // until 是下一页的终点（不含）。翻旧页时只读这一截，不从文件尾巴重新取。
    const end = Number.isFinite(until) && (until as number) > 0 ? Math.min(total, Math.floor(until as number)) : total;
    const start = Math.max(0, end - size);
    const rows: any[] = [];
    if (start >= end) return { rows, start, total };
    let cursor = 0;
    for (let index = 0; index < paths.length; index += 1) {
      const till = cursor + counts[index];
      const from = Math.max(0, start - cursor);
      cursor = till;
      if (till <= start) continue;
      const base = till - counts[index];
      const sliceFrom = Math.max(start, base) - base;
      const sliceTo = Math.min(counts[index], end - base);
      if (sliceTo <= sliceFrom) continue;
      const lines = await this.segmentLines(paths[index], counts[index], sliceFrom, sliceTo);
      const first = base + sliceFrom;
      for (let i = 0; i < lines.length; i += 1) {
        const at = first + i;
        // 窗口外的行不解析：以前整份历史都要 JSON.parse 一遍
        if (at < start || at >= end) continue;
        try {
          rows.push(JSON.parse(lines[i]));
        } catch {
          if (at !== total - 1) throw Error("JSONL 中间行损坏：" + id);
          this.logger.warn("忽略 JSONL 最后半行", { file: id });
        }
      }
      if (cursor >= end) break;
    }
    return { rows, start, total };
  }
  appendEvent(line: any, options: { once?: boolean } = {}) {
    return this.serial(async () => {
      // Check under the same write queue: a previous append may have committed
      // before a later metadata write failed. Never repeat that message/event.
      if (options.once) {
        if (typeof line.id !== "string" || !line.id) throw Error("幂等记录需要固定ID");
        const previous = (await this.readSession(line.session)).find(row => row.id === line.id);
        if (previous) {
          if (previous.type !== line.type || previous.text !== line.text || previous.delivery_id !== line.delivery_id)
            throw Error("相同记忆ID的内容不一致");
          return;
        }
      }
      const file = join(
        this.sessionDir(line.session),
        "episodes",
        new Date().toISOString().slice(0, 7) + ".jsonl",
      );
      const index = await this.sessionIndex(),
        previous = indexSessionMeta(index, line.session);
      if (previous?.deleted) throw Error("会话已删除，请新建会话");
      await directory(dirname(file));
      let raw = "";
      try {
        raw = await readFile(file, "utf8");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (raw && !raw.endsWith("\n")) {
        try {
          JSON.parse(raw.slice(raw.lastIndexOf("\n") + 1));
          await appendFile(file, "\n");
        } catch {
          await atomic(file, raw.slice(0, raw.lastIndexOf("\n") + 1));
          this.logger.warn("修复 JSONL 尾部", { file });
        }
      }
      const saved = { ts: new Date().toISOString(), ...line, id: line.id || randomUUID() };
      await appendFile(file, JSON.stringify(saved) + "\n");
      index.sessions = {
        ...index.sessions,
        [line.session]: {
          ...previous,
          file: relative(this.root, file).split(sep).join("/"),
          format: 2,
          updatedAt: new Date().toISOString(),
        },
      };
      await atomic(
        join(this.root, "index.json"),
        JSON.stringify(index, null, 2),
      );
      await atomic(
        join(this.sessionDir(line.session), "session.json"),
        JSON.stringify(index.sessions[line.session], null, 2),
      );
      this.logger.info("记忆写入", { file, count: 1 });
      this.notify("memory/recorded", saved);
      if (saved.type === "message") this.notify(saved.role === "user" ? "channel/message" : "channel/reply", saved);
    });
  }
  writeSummary(id: string, md: string, sessionId?: string) {
    return this.serial(async () => {
      safeId(id);
      const index = await this.sessionIndex();
      const owner =
        sessionId ||
        index.summaryOwners?.[id] ||
        (indexSessionMeta(index, id) ? id : null);
      if (
        sessionId &&
        typeof index.summaryOwners?.[id] === "string" &&
        index.summaryOwners[id] !== sessionId
      )
        throw Error("摘要已属于其他会话，不能更改归属");
      let file = join(this.root, "summaries", id + ".md");
      if (owner) {
        if (indexSessionMeta(index, safeId(owner))?.deleted)
          throw Error("会话已删除");
        file = join(this.sessionDir(owner), "summaries", id + ".md");
        index.summaryOwners = { ...index.summaryOwners, [id]: owner };
        await atomic(
          join(this.root, "index.json"),
          JSON.stringify(index, null, 2),
        );
      }
      await directory(dirname(file));
      await atomic(file, md);
    });
  }
  async readSummary(id: string) {
    try {
      return await readFile(await this.summaryPath(id), "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return "";
      throw e;
    }
  }
  async status() {
    const files = await regularTree(join(this.root, "sessions"));
    const stats = await Promise.all(files.map((f) => stat(f)));
    return {
      files: new Set(
        files.map((file) =>
          relative(join(this.root, "sessions"), file)
            .split(sep)[0]
            .replace(/\.jsonl$/, ""),
        ),
      ).size,
      bytes: stats.reduce((n, s) => n + s.size, 0),
      updatedAt: new Date().toISOString(),
    };
  }
}
