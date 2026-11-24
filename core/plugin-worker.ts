/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { workerData } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginRPC } from "./plugin-rpc.ts";
import { createPluginHttpServer } from "./plugin-http-bridge.ts";

const { port, wake } = workerData;
const send = (packet: any) => port.postMessage(packet);
const fault = (error: any) => send({ type: "fatal", error: error?.message ?? String(error) });
const peer = new PluginRPC({ side: "plugin", transport: { send }, port, wake, timeout: Number(process.env.WHALE_PLUGIN_CALL_TIMEOUT_MS) || 600000, onFault: fault });
port.on("message", (message: any) => peer.receive(message));
const heartbeat = setInterval(() => send({ type: "pulse" }), 100); heartbeat.unref();
process.on("uncaughtException", fault); process.on("unhandledRejection", fault);
const cleanups = new Set<() => any>();
let http: Awaited<ReturnType<typeof createPluginHttpServer>> | undefined;
let stopping = false;
peer.bind("entry", {
  async start(kernel: any, directory: string) {
    const remote = kernel.ctx;
    const ctx = Object.create(null);
    // A callback runs in this process. Carry its diagnostic privacy across any
    // awaited work before it makes a new model RPC back to the host.
    const imageCallback = new AsyncLocalStorage<true>();
    const facades = new WeakMap<object, object>();
    const imageFacade = (name: string, service: any) => {
      if (!service || (name !== "llm" && name !== "channels")) return service;
      const cached = facades.get(service);
      if (cached) return cached;
      const chat = (options: any) => service.chat(imageCallback.getStore()
        ? { ...options, privateChannelImages: true } : options);
      const register = (adapter: any) => {
        if (typeof adapter?.describeImages !== "function") return service.register(adapter);
        const describe = adapter.describeImages.bind(adapter);
        return service.register({
          ...adapter, id: adapter.id, name: adapter.name, account: adapter.account,
          persona: adapter.persona, personaMode: adapter.personaMode, permission: adapter.permission,
          send: adapter.send.bind(adapter),
          describeImages: (...args: any[]) => imageCallback.run(true, () => describe(...args)),
        });
      };
      const facade = new Proxy(service, { get(target, key) {
        if (name === "llm" && key === "chat") return chat;
        if (name === "channels" && key === "register") return register;
        return Reflect.get(target, key);
      } });
      peer.alias(facade, service);
      facades.set(service, facade);
      return facade;
    };
    for (const key of ["apiVersion", "logger", "signal", "config", "llm", "memory", "approval", "channels", "models", "personas", "sessions"])
      Object.defineProperty(ctx, key, { enumerable: true, get: () => imageFacade(key, remote[key]) });
    const registerTool = (tool: any, mode: "register" | "registerTransient" | "registerMultimodal") => remote.tools[mode]({ ...tool, run: async (...args: any[]) => {
        try { return await tool.run(...args); }
        catch (error) {
          const safe = mode !== "register" || args[1]?.transientContext ? Error("临时工具执行异常；原始错误未记录，请核对插件回执") : error;
          if (!remote.signal.aborted) setImmediate(() => fault(safe));
          throw safe;
        }
      } });
    ctx.tools = Object.freeze({
      register: (tool: any) => registerTool(tool, "register"),
      registerTransient: (tool: any) => registerTool(tool, "registerTransient"),
      registerMultimodal: (tool: any) => registerTool(tool, "registerMultimodal"),
      list: () => remote.tools.list(),
      call: (...args: any[]) => remote.tools.call(...args),
    });
    ctx.get = (name: string, strict?: boolean) => ["web", "tools"].includes(name) ? ctx[name] : imageFacade(name, kernel.get(name, strict));
    ctx.optional = (name: string, listener: any) => {
      remote.signal.throwIfAborted();
      if (typeof listener !== "function") throw Error("可选服务需要状态回调");
      const remove = kernel.optional(name, (binding: any) => {
        if (stopping || remote.signal.aborted) return;
        if (!binding) return listener(undefined);
        if (binding.signal.aborted) return;
        return listener(Object.freeze({ service: binding.service, signal: binding.signal,
          effect(fn: any) {
            binding.signal.throwIfAborted(); remote.signal.throwIfAborted();
            const resource = fn();
            const original = typeof resource === "function" ? resource : resource?.dispose?.bind(resource);
            if (typeof original !== "function") throw Error("可选服务 effect 必须返回清理函数或可释放资源");
            let dispose: any;
            // Sending the original disposer preserves host back-references: core
            // registrations can be revoked even if this worker is unresponsive.
            try { dispose = binding.registerCleanup(original); }
            catch (error) { void Promise.resolve().then(original).catch(fault); throw error; }
            if (typeof resource === "function") return dispose;
            resource.dispose = dispose;
            return resource;
          },
        }));
      });
      let disposed = false;
      const dispose = () => { if (disposed) return; disposed = true; cleanups.delete(dispose); remove(); };
      cleanups.add(dispose);
      return dispose;
    };
    ctx.provide = (name: string, value: any) => { if (value && typeof value === "object") peer.publish(value); remote.provide(name, value); };
    ctx.on = (name: string, handler: any) => remote.on(name, handler);
    ctx.emit = (name: string, payload: any) => remote.emit(name, payload);
    ctx.effect = (fn: () => any) => {
      remote.signal.throwIfAborted();
      const result = fn(); let disposed = false;
      const original = typeof result === "function" ? result : result.dispose.bind(result);
      const cleanup = () => { if (disposed) return; disposed = true; cleanups.delete(cleanup); return original(); };
      cleanups.add(cleanup);
      if (typeof result === "function") return cleanup;
      result.dispose = cleanup;
      return result;
    };
    ctx.plugin = async (module: any) => {
      module = await module;
      let target = module.id;
      if (!target) for (const child of await readdir(join(directory, "sub"), { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const candidate = await import(pathToFileURL(join(directory, "sub", child.name, "index.ts")).href);
        if (candidate.apply === module.apply) { target = child.name; break; }
      }
      if (!target) throw Error("无法确定子插件目录，请导出 id");
      return remote.plugin({ id: target });
    };
    http = await createPluginHttpServer(remote.signal, fault, peer.timeout);
    kernel.openWeb(http.endpoint);
    ctx.web = Object.freeze(Object.fromEntries(["page", "api"].map((kind) => [kind, (path: string, handler: any, entry?: any) => {
      remote.signal.throwIfAborted(); const id = crypto.randomUUID(), local = http!.register(id, handler);
      try {
        const host = kernel.registerWeb(kind, path, id, entry);
        return () => { local(); host(); };
      } catch (error) { local(); throw error; }
    }])));
    peer.alias(ctx, remote);
    const module = await import(pathToFileURL(join(directory, "index.ts")).href);
    if (typeof module.apply !== "function") throw Error("插件缺少 apply");
    await module.apply(Object.freeze(ctx));
    peer.flush();
  },
  async stop() {
    if (stopping) return; stopping = true;
    await Promise.allSettled([...cleanups].map((fn) => Promise.resolve().then(fn)));
    await http?.close(); peer.flush();
  },
});
send({ type: "ready" });
