/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Diagnostics } from "./diagnostics.ts";
import { Logger } from "./logger.ts";
import { Memory } from "./memory.ts";
import { MemoryAdmin } from "./memory-admin.ts";
import { LLM } from "./llm.ts";
import { Tools } from "./tools.ts";
import { RegisteredToolOrder } from "./tool-order.ts";
import { approval } from "./permission.ts";
import { Runtime } from "./runtime.ts";
import { recoverPendingPluginReplacements } from "./official-package-files.ts";
import { recoverUpdateDependencies } from "./package-update-journal.ts";
import { Sessions } from "./session.ts";
import { Channels } from "./channels.ts";
import { startWeb } from "./web.ts";
import { ModelConfig, resolveModel } from "./model-config.ts";
import { PersonaFiles } from "./persona-config.ts";
import { MemoryEngine } from "./memory-engine.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { pluginServices } from "./plugin-services.ts";
import { ExecutionArchive, registerExecutionTools } from "./execution-archive.ts";
import type { HostUpdates } from "./host-updates.ts";
import { migrateStockLauncher } from "./host-launcher-migration.ts";

// Only a gated trial can persist the launcher, after all previously running plugins pass.
class TrialRuntime extends Runtime {
  override async checkInstalledPlugins(ids: string[]) {
    await super.checkInstalledPlugins(ids);
    await migrateStockLauncher(this.root);
  }
}

export async function boot(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  hostUpdates?: HostUpdates,
  hostStarting?: () => boolean,
) {
  // Older installation-root workers call boot() even for a reversible trial.
  if (process.send && hostStarting && process.argv[4] === "trial")
    throw Error("安装根目录的启动器需要手动升级后才能安全更新本体。请退出 WhaleLife，保留实例资料，更新根目录的程序文件后重启。");
  return initialize(root, hostUpdates, hostStarting, false);
}

export function prepareHostTrial(root: string, hostUpdates?: HostUpdates) {
  return initialize(root, hostUpdates, () => true, true);
}

async function initialize(
  root: string,
  hostUpdates: HostUpdates | undefined,
  hostStarting: (() => boolean) | undefined,
  trial: boolean,
) {
  const config = JSON.parse(
    (await readFile(resolve(root, "config/config.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  const logger = new Logger(
    resolve(root, "logs"),
    config.log,
    config.providers.map((p: any) => p.api_key),
  );
  logger.info("WhaleLife 启动");
  logger.info("配置加载与校验", {
    providers: config.providers.map((p: any) => p.id),
  });
  const diagnostics = new Diagnostics(root, { ...config.diagnostics,
    excluded_directories: [resolve(root, config.memory.root), resolve(root, "logs")],
  }, logger, () => config.providers.map((p: any) => p.api_key).filter(Boolean));
  await diagnostics.initialize();
  diagnostics.event("coverage", {
    supported: ["core_session_chat", "core_tools", "memory_diary", "legacy_memory_maintenance", "plugin_llm_chat", "model_config_http"],
    unverified: ["plugin_direct_http_after_models_connection", "provider_internal_usage", "provider_billing"],
    note: "只记录主干实际观察的请求和用量；插件自行使用 SDK/HTTP 的调用不在覆盖范围，不推断缺失用量或任务关系。",
  });
  const modelConfig = new ModelConfig(root, config, logger);
  modelConfig.diagnostics = diagnostics;
  const memory = new Memory(resolve(root, config.memory.root), logger);
  await memory.init();
  const memoryEngine = new MemoryEngine(memory);
  (memory as any).engine = memoryEngine;
  await memoryEngine.recoverSummaries();
  for (const [id, p] of Object.entries<any>(config.personas)) {
    const file = resolve(root, p.file);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(
        file,
        `# ${p.name}\n你是鲸鲸，温柔、真诚、清醒的本地伙伴。用自然的中文交流。记忆以共享事实和会话记录为准；不编造经历或用户资料。\n`,
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    logger.info("人格就绪", { id });
  }
  const llm = new LLM(logger, config.providers, (id) =>
      resolveModel(config, id),
    ),
    tools = new Tools(logger, config.permissions?.tools);
  const executionArchive = new ExecutionArchive(resolve(root, "logs/executions"), logger);
  tools.executionArchive = executionArchive;
  llm.diagnostics = diagnostics;
  tools.diagnostics = diagnostics;
  const toolOrder = await RegisteredToolOrder.open(resolve(root, "config/tool-order.json"), logger);
  const RuntimeClass = trial ? TrialRuntime : Runtime;
  const runtime = new RuntimeClass(root, logger, config.plugin_runtime);
  // Recovery consumes plugin journals outside the host snapshot. Only the active host may do it.
  if (!trial) {
    const recovered = await recoverPendingPluginReplacements(root).catch(error => {
      logger.warn("无法检查插件更新备份", {error});
      return [];
    });
    for (const result of recovered) {
      if (result.status === "pending") {
        logger.warn("插件更新备份需要检查", result);
        if (/^plugins\/[a-z][a-z0-9-]*(?:\/sub\/[a-z][a-z0-9-]*)*$/.test(result.directory))
          runtime.packageRecoveryBlocks.set(result.directory.slice(8).replaceAll("/sub/", "/"), result.message);
      } else logger.info("已处理上次中断的插件更新", result);
    }
    await recoverUpdateDependencies(runtime);
  }
  const services: any = {
    hostUpdates,
    hostStarting,
    diagnostics,
    logger,
    memory,
    memoryEngine,
    llm,
    tools,
    toolOrder,
    executionArchive,
    approval,
    modelConfig,
    personaFiles: new PersonaFiles(root, config, logger),
  };
  const sessions = new Sessions(root, config, services);
  services.sessions = sessions;
  services.channels = new Channels(memory, sessions, config);
  memory.onChange = (name, payload) => runtime.events.emit(name, payload);
  const extensionServices = pluginServices(config, modelConfig, sessions, memory);
  for (const [name, service] of Object.entries(extensionServices)) await runtime.builtin(name, service);
  for (const id of ["logger", "memory", "llm", "tools", "approval", "channels"])
    await runtime.builtin(id, services[id]);
  await runtime.builtin("permission", { approval });
  await runtime.builtin("facts", {}, (ctx) =>
    registerMemoryTools(ctx.tools, memoryEngine),
  );
  await runtime.builtin("execution_archive", {}, (ctx) => registerExecutionTools(ctx.tools, executionArchive));
  memoryEngine.maintenance = (id) =>
    sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  memoryEngine.inputEditGuard = (id) => {
    if (sessions.memoryMaintenance || sessions.blockedSessions.has(id) ||
        sessions.locks.has(id) || sessions.channelOperations.has(id)) throw Error("会话正在处理，请结束后排除历史输入");
    sessions.locks.add(id);
    return () => { sessions.locks.delete(id); };
  };
  tools.observe = async (event) => {
    runtime.events.emit("tool/called", { id: event.id, name: event.name, source: event.source,
      origin: event.origin, session: event.session?.id, ok: event.ok, result: event.result,
      ...(event.transient ? { transient: true } : {}) });
    if (
      !event.session?.id ||
      (event.transient && event.result === null) ||
      ["recall_memory", "remember_fact", "edit_facts"].includes(event.name)
    )
      return;
    await memoryEngine.experience(event.session.id, event.source, {
      event_id: event.id,
      origin: event.origin,
      outcome: event.ok ? "succeeded" : "failed",
      text: `工具 ${event.name} ${event.ok ? "调用完成" : "调用失败"}：${String(JSON.stringify(event.result)).slice(0, 350)}`,
    }, { toolTrace: true });
  };
  services.memoryAdmin = new MemoryAdmin(memory, sessions, logger);
  await runtime.builtin("chat", sessions);
  const web = await startWeb(config, services, runtime);
  services.web = web;
  await runtime.builtin("web", web);
  await runtime.bus.start();
  if (!trial) {
    await runtime.scan();
    await toolOrder.remember(tools.entries.keys());
    runtime.events.emit("whalelife/ready", { at: new Date().toISOString() });
    logger.info("核心就绪");
  }
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    // Publish the promise before a synchronous log/shutdown listener can re-enter close().
    closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    void (async () => {
      logger.info("WhaleLife 关闭");
      await runtime.finishManagement();
      runtime.events.emit("whalelife/shutdown", { at: new Date().toISOString() });
      // Let shutdown listeners receive the notification before their subscriptions are removed.
      await new Promise<void>((r) => setImmediate(r));
      sessions.beginClose();
      services.channels.beginClose();
      runtime.beginClose();
      await Promise.all([web.close(), sessions.close(), services.channels.close(), runtime.bus.stop()]);
      await runtime.events.drain();
      await memory.queue;
      await diagnostics.close();
    })().then(resolveClose, rejectClose);
    return closing;
  };
  return { config, ...services, runtime, close, pendingPackageCommit: () => runtime.pendingPackageCommit };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { runHostSupervisor } = await import("./host-supervisor.ts");
  try { process.exitCode = await runHostSupervisor(resolve(dirname(fileURLToPath(import.meta.url)), "..")); }
  catch (error) {
    const { writeLogOutput } = await import("./log-output.ts");
    writeLogOutput("WhaleLife 启动失败：" + (error instanceof Error ? error.message : String(error)), "stderr");
    process.exitCode = 1;
  }
}
