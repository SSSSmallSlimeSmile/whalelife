/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";

type Packet = Record<string, any>;
type Transport = { send(message: Packet): void };
type Pending = { resolve(value: any): void; reject(reason: any): void; timer?: NodeJS.Timeout; boxed?: boolean };
const reference = Symbol("plugin-rpc-reference");
const forwarded = new WeakMap<Function, { peer: PluginRPC; id: string }>();
const mirroredSources = new WeakMap<object, { peer: PluginRPC; id: string }>();
type Remote = { id: string; generation: number; kind: string; value: WeakRef<object> };
const symbols = new Map<string, symbol>([["iterator", Symbol.iterator], ["asyncIterator", Symbol.asyncIterator], ["dispose", Symbol.dispose], ["asyncDispose", Symbol.asyncDispose]]);
const keyWire = (key: PropertyKey) => typeof key === "symbol" ? { symbol: [...symbols].find(([, value]) => value === key)?.[0] ?? Symbol.keyFor(key) } : String(key);
const keyValue = (key: any): PropertyKey => typeof key === "object" ? symbols.get(key.symbol) ?? Symbol.for(key.symbol) : key;
const messageOf = (error: any) => error?.message ?? String(error);

/** Internal transport only. Core APIs remain ordinary typed values and methods. */
export class PluginRPC {
  private sequence = 0;
  private objects = new Map<string, any>();
  private ids = new WeakMap<object, string>();
  private remotes = new Map<string, Remote>();
  private remoteIds = new WeakMap<object, Packet>();
  private pending = new Map<string, Pending>();
  private syncResults = new Map<string, { ok: boolean; value: any }>();
  private signals = new Map<string, WeakRef<AbortSignal>>();
  private signalControllers = new WeakMap<AbortSignal, AbortController>();
  private signalCleanup = new Map<string, () => void>();
  private generations = new Map<string, number>();
  private promises = new Set<string>();
  // A callee may compose an incoming signal with AbortSignal.any and no longer
  // retain the proxy itself. Keep call inputs live until its async work settles.
  private callInputs = new Map<string, unknown>();
  private finalizer = new FinalizationRegistry<Remote>((remote) => this.releaseRemote(remote));
  private methods = new WeakMap<object, Map<PropertyKey, { original: Function; bound: Function }>>();
  private boundOriginal = new WeakMap<Function, Function>();
  private mirrors = new WeakSet<object>();
  private published = new Set<object>();
  private ended?: Error;
  readonly side: "host" | "plugin";
  readonly transport: Transport;
  readonly onFault: (error: Error) => void;
  readonly timeout: number;
  readonly port?: MessagePort;
  readonly wake?: Int32Array;
  private lastPulse = 0;
  // A sync call can pump unrelated callbacks from the port. Dispatch them in
  // the same context as an independent port event, not the waiting callback.
  private readonly dispatchIncoming = AsyncLocalStorage.bind((packet: Packet) => this.receive(packet));
  constructor(options: { side: "host" | "plugin"; transport: Transport; onFault(error: Error): void; timeout: number; port?: MessagePort; wake?: Int32Array }) {
    Object.assign(this, options);
    this.side = options.side; this.transport = options.transport; this.onFault = options.onFault; this.timeout = options.timeout;
  }
  expose(value: any) { return { [reference]: value }; }
  bind(id: string, value: any) { this.objects.set(id, value); if (value && ["object", "function"].includes(typeof value)) this.ids.set(value, id); }
  alias(value: object, remote: object) { const wire = this.remoteIds.get(remote); if (!wire) throw Error("Unknown RPC alias"); this.remoteIds.set(value, wire); }
  publish(value: object) { this.published.add(value); this.markMirror(value); }
  private markMirror(value: any, seen = new Set<object>()) {
    if (!value || typeof value !== "object" || this.remoteIds.has(value) || seen.has(value) || value instanceof AbortSignal) return;
    if (value instanceof Promise || value instanceof Error || value instanceof Date || value instanceof Uint8Array) return;
    seen.add(value); this.mirrors.add(value);
    for (const item of Object.values(value)) this.markMirror(item, seen);
  }
  private cached(id: string) { return this.remotes.get(id)?.value.deref(); }
  private retainRemote(wire: Packet, value: object) {
    let remote = this.remotes.get(wire.id);
    if (remote?.value.deref() !== value) {
      if (remote) this.finalizer.unregister(remote);
      remote = { id: wire.id, generation: wire.generation ?? 0, kind: wire.kind, value: new WeakRef(value) };
      this.remotes.set(wire.id, remote); this.finalizer.register(value, remote, remote);
    } else remote.generation = wire.generation ?? remote.generation;
    this.remoteIds.set(value, wire);
    return value;
  }
  private releaseRemote(remote: Remote) {
    if (this.remotes.get(remote.id) !== remote || remote.value.deref()) return;
    this.remotes.delete(remote.id); this.signals.delete(remote.id);
    if (!this.ended) {
      try { this.send({ type: "release", id: remote.id, generation: remote.generation }); }
      catch { /* Transport shutdown owns the fault and releases every remaining reference. */ }
    }
  }
  private forgetRemote(id: string) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.finalizer.unregister(remote); this.remotes.delete(id);
    const value = remote.value.deref(); if (value) this.remoteIds.delete(value);
  }
  private release(id: string) {
    const value = this.objects.get(id);
    if (value && (typeof value === "object" || typeof value === "function")) this.ids.delete(value);
    this.objects.delete(id); this.generations.delete(id); this.promises.delete(id);
    this.signalCleanup.get(id)?.(); this.signalCleanup.delete(id);
  }
  private lease(id: string) {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation); return generation;
  }
  private method(owner: object, key: PropertyKey, original: Function) {
    let methods = this.methods.get(owner); if (!methods) { methods = new Map(); this.methods.set(owner, methods); }
    let method = methods.get(key);
    if (!method || method.original !== original) {
      const bound = original.bind(owner), remote = forwarded.get(original);
      if (remote) forwarded.set(bound, remote);
      this.boundOriginal.set(bound, original);
      method = { original, bound }; methods.set(key, method);
    }
    return method.bound;
  }
  private publicKeys(value: object) {
    const keys = new Set(Object.keys(value));
    if (!Array.isArray(value)) for (let at = Object.getPrototypeOf(value); at && at !== Object.prototype; at = Object.getPrototypeOf(at))
      for (const key of Object.getOwnPropertyNames(at)) {
        if (key === "constructor") continue;
        const descriptor = Object.getOwnPropertyDescriptor(at, key)!;
        if (typeof descriptor.value === "function" || descriptor.get) keys.add(key);
      }
    return [...keys].filter((key) => !["__proto__", "constructor", "prototype"].includes(key));
  }
  flush() {
    if (this.ended || !this.published.size) return;
    this.send({ type: "mirrors", values: [...this.published].map((value) => { this.markMirror(value); return this.encode(value); }) });
  }
  private id(value: object) {
    let id = this.ids.get(value);
    if (!id) { id = `${this.side}:${++this.sequence}`; this.ids.set(value, id); this.objects.set(id, value); }
    return id;
  }
  private send(message: Packet) {
    if (this.ended) throw this.ended;
    this.transport.send(message);
  }
  encode(value: any, seen = new Set<object>()): any {
    if (value === null || !["object", "function"].includes(typeof value)) return { kind: "scalar", value };
    const back = this.remoteIds.get(value); if (back) return back;
    if (reference in value) return this.ref(value[reference]);
    if (value instanceof Error) return { kind: "error", name: value.name, message: value.message, code: (value as any).code };
    if (value instanceof AbortSignal) {
      const known = this.ids.has(value), id = this.id(value);
      if (!known) {
        const abort = () => { if (!this.ended) this.send({ type: "abort", id, reason: this.encode(value.reason) }); };
        value.addEventListener("abort", abort, { once: true }); this.signalCleanup.set(id, () => value.removeEventListener("abort", abort));
      }
      return { kind: "signal", side: this.side, id, generation: this.lease(id), aborted: value.aborted, reason: this.encode(value.reason) };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { kind: "bytes", value: Buffer.from(value) };
    if (value instanceof Date) return { kind: "date", value: value.toISOString() };
    if (typeof value === "function") return this.ref(value);
    if (value instanceof Promise) {
      const id = this.id(value);
      this.promises.add(id);
      // Every wire occurrence gets a settlement, including a cached promise
      // republished while the previous settlement acknowledgement is in flight.
      void value.then((result) => this.settle(id, true, result), (error) => this.settle(id, false, error));
      return { kind: "promise", side: this.side, id };
    }
    const custom = !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value));
    if (custom && this.side === "host") return this.ref(value);
    if (custom) this.markMirror(value);
    const mirrored = this.mirrors.has(value), id = mirrored ? this.id(value) : undefined;
    if (seen.has(value)) { if (id) return { kind: "mirror-link", id }; throw Error("RPC data contains a cycle"); }
    seen.add(value);
    const keys = custom ? this.publicKeys(value) : Object.keys(value);
    const entries = keys.map((key) => {
      const item = value[key];
      return [key, this.encode(typeof item === "function" && !Array.isArray(value) ? this.method(value, key, item) : item, seen)];
    });
    seen.delete(value);
    return { kind: Array.isArray(value) ? "array" : "data", id, side: id ? this.side : undefined, generation: id ? this.lease(id) : undefined,
      length: Array.isArray(value) ? value.length : undefined, entries };
  }
  private ref(value: any, label?: string): Packet {
    if (value === null || !["object", "function"].includes(typeof value)) return this.encode(value);
    const back = this.remoteIds.get(value); if (back) return back;
    const id = this.id(value);
    return { kind: "reference", side: this.side, id, generation: this.lease(id), callable: typeof value === "function", label };
  }
  decode(wire: any): any {
    // Decoding an already-known AbortSignal can synchronously invoke a listener
    // that calls back through RPC. Register every promise in this packet first,
    // and retain its value until decoding finishes even if a nested wait receives
    // its settlement and removes the normal remote-reference cache entry.
    const promises = new Map<string, Promise<any>>(), created = new Map<string, Pending>();
    const prepare = (value: any) => {
      if (!value || (value.side === this.side && value.id)) return;
      if (value.kind === "promise" && !promises.has(value.id)) {
        let promise = this.cached(value.id) as Promise<any> | undefined;
        if (!promise) {
          promise = this.waiting(value.id);
          created.set(value.id, this.pending.get(value.id)!);
          this.retainRemote(value, promise);
        }
        promises.set(value.id, promise);
      } else if (value.kind === "array" || value.kind === "data") {
        for (const [, item] of value.entries) prepare(item);
      } else if (value.kind === "signal") prepare(value.reason);
    };
    try {
      prepare(wire);
      return this.decodePrepared(wire, promises);
    } catch (error) {
      // A malformed packet must not leave newly registered promises timing out
      // later and faulting an unrelated call. Existing shared waits stay intact.
      for (const [id, pending] of created) if (this.pending.get(id) === pending) {
        clearTimeout(pending.timer); this.pending.delete(id); this.forgetRemote(id); pending.reject(error);
      }
      throw error;
    }
  }
  private decodePrepared(wire: any, promises: Map<string, Promise<any>>): any {
    if (!wire) throw Error("Invalid plugin RPC value");
    if (wire.side === this.side && wire.id) {
      if (!this.objects.has(wire.id)) throw Error("Expired plugin RPC reference");
      return this.objects.get(wire.id);
    }
    if (wire.kind === "scalar") return wire.value;
    if (wire.kind === "error") { const error = Error(wire.message); error.name = wire.name || "Error"; if (wire.code) (error as any).code = wire.code; return error; }
    if (wire.kind === "bytes") return Buffer.from(wire.value);
    if (wire.kind === "date") return new Date(wire.value);
    if (wire.kind === "mirror-link") return this.cached(wire.id);
    if (wire.kind === "array" || wire.kind === "data") {
      const value: any = (wire.id && this.cached(wire.id)) || (wire.kind === "array" ? [] : {});
      if (wire.id) {
        this.retainRemote(wire, value);
        mirroredSources.set(value, { peer: this, id: wire.id });
      }
      const keys = new Set(wire.entries.map(([key]: any) => key));
      for (const key of Object.keys(value)) if (!keys.has(key)) delete value[key];
      for (const [key, item] of wire.entries) Object.defineProperty(value, key, { value: this.decodePrepared(item, promises), configurable: true, writable: true, enumerable: true });
      if (wire.kind === "array") value.length = wire.length;
      return value;
    }
    if (wire.kind === "signal") {
      const existing = this.signals.get(wire.id)?.deref();
      const controller = existing ? this.signalControllers.get(existing)! : new AbortController();
      if (!existing) { this.signals.set(wire.id, new WeakRef(controller.signal)); this.signalControllers.set(controller.signal, controller); }
      this.retainRemote(wire, controller.signal);
      if (wire.aborted) controller.abort(this.decodePrepared(wire.reason, promises));
      return controller.signal;
    }
    if (wire.kind === "promise") return promises.get(wire.id);
    if (wire.kind === "reference") {
      const existing = this.cached(wire.id); if (existing) { this.retainRemote(wire, existing); return existing; }
      let proxy: any;
      if (this.side === "host") {
        if (!wire.callable) throw Error("Plugin services must expose data and callable methods, not opaque implementation objects");
        proxy = (...args: any[]) => this.request("apply", wire.id, { args: this.encode(args) });
        forwarded.set(proxy, { peer: this, id: wire.id });
      } else {
        const target: any = wire.callable ? (..._args: any[]) => {} : {};
        proxy = new Proxy(target, {
          get: (_target, key) => {
            if (key === "then") return undefined;
            if (key === Symbol.toStringTag) return "PluginService";
            if (["__proto__", "constructor", "prototype"].includes(String(key))) return undefined;
            return this.sync("get", wire.id, { key: keyWire(key) });
          },
          set: (_target, key, value) => !!this.sync("set", wire.id, { key: keyWire(key), value: this.encode(value) }),
          has: (_target, key) => !!this.sync("has", wire.id, { key: keyWire(key) }),
          ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...this.sync("keys", wire.id, {})])],
          getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(target, key) ?? { enumerable: true, configurable: true },
          apply: (_target, _thisArg, args) => {
            if (wire.label === "provide" && args[1] && typeof args[1] === "object") this.publish(args[1]);
            return this.sync("apply", wire.id, { args: this.encode(args) });
          },
        });
      }
      this.retainRemote(wire, proxy); return proxy;
    }
    throw Error("Unsupported plugin RPC value");
  }
  private settle(id: string, ok: boolean, value: any) {
    if (this.ended) return;
    try { this.flush(); this.send({ type: "settled", id, ok, value: this.encode(value) }); }
    catch (error) { if (!this.ended) this.send({ type: "settled", id, ok: false, value: this.encode(Error(messageOf(error))) }); }
  }
  private waiting(id: string, boxed = false) {
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { const error = Error("插件调用超时，已切割该插件"); this.pending.delete(id); reject(error); this.onFault(error); }, this.timeout);
      timer.unref(); this.pending.set(id, { resolve, reject, timer, boxed });
    });
    // Callback producers may ignore returned promises, e.g. onChunk. Keep failures owned.
    void promise.catch(() => {}); return promise;
  }
  request(operation: string, target: string, fields: Packet): Promise<any> {
    const promise = this.initial(operation, target, fields).then((box) => box.value);
    void promise.catch(() => {}); return promise;
  }
  private initial(operation: string, target: string, fields: Packet): Promise<{ value: any }> {
    if (this.ended) return Promise.reject(this.ended);
    const id = `${this.side}:call:${++this.sequence}`, promise = this.waiting(id, true);
    try { this.send({ type: "request", id, operation, target, ...fields }); }
    catch (error) {
      const pending = this.pending.get(id); clearTimeout(pending?.timer); this.pending.delete(id); pending?.reject(error);
    }
    return promise;
  }
  call(target: string, method: string, args: any[] = []) { return this.request("method", target, { key: method, args: this.encode(args) }); }
  private sync(operation: string, target: string, fields: Packet) {
    if (this.ended) throw this.ended;
    const id = `${this.side}:sync:${++this.sequence}`, until = Date.now() + this.timeout;
    this.send({ type: "request", id, sync: true, operation, target, ...fields });
    while (!this.syncResults.has(id)) {
      if (this.ended) throw this.ended;
      const item = receiveMessageOnPort(this.port!);
      if (item) { this.dispatchIncoming(item.message); continue; }
      if (Date.now() >= until) { const error = Error("插件接口等待超时"); this.onFault(error); throw error; }
      if (Date.now() - this.lastPulse > 100) { this.lastPulse = Date.now(); this.send({ type: "pulse" }); }
      const count = Atomics.load(this.wake!, 0); Atomics.wait(this.wake!, 0, count, 10);
    }
    const reply = this.syncResults.get(id)!; this.syncResults.delete(id);
    if (!reply.ok) throw reply.value; return reply.value;
  }
  receive(message: Packet) {
    if (this.ended) return;
    if (message.type === "mirrors") { for (const value of message.values) this.decode(value); return; }
    if (message.type === "release") {
      if (this.generations.get(message.id) === message.generation) this.release(message.id);
      return;
    }
    if (message.type === "promise-ack") { if (this.promises.has(message.id)) this.release(message.id); return; }
    if (message.type === "abort") {
      const signal = this.signals.get(message.id)?.deref();
      if (signal) this.signalControllers.get(signal)?.abort(this.decode(message.reason));
      return;
    }
    if (message.type === "reply" || message.type === "settled") {
      if (message.sync) {
        // A nested synchronous call may pump this reply before its caller resumes.
        // Decode now so a following settlement already has a registered waiter.
        try {
          const value = this.decode(message.value);
          if (!this.ended) this.syncResults.set(message.id, { ok: message.ok, value });
        } catch (error) {
          if (!this.ended) this.syncResults.set(message.id, { ok: false, value: error });
        }
        return;
      }
      const pending = this.pending.get(message.id);
      try {
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.id);
          const value = this.decode(message.value);
          message.ok ? pending.resolve(pending.boxed ? { value } : value) : pending.reject(value);
        }
      } catch (error) { pending?.reject(error); }
      finally {
        if (message.type === "settled") { this.forgetRemote(message.id); this.send({ type: "promise-ack", id: message.id }); }
      }
      return;
    }
    if (message.type !== "request") return;
    try {
      const object = this.objects.get(message.target);
      if (!object) throw Error("插件接口引用已失效");
      const key = message.key === undefined ? undefined : keyValue(message.key);
      const properties = typeof object === "function" ? this.boundOriginal.get(object) ?? object : object;
      if (["__proto__", "constructor", "prototype"].includes(String(key))) throw Error("插件不能访问对象内部原型");
      const source = mirroredSources.get(properties);
      if (source && ["get", "set", "has", "keys"].includes(message.operation)) {
        const fields = { key: message.key, ...(message.operation === "set" ? { value: source.peer.encode(this.decode(message.value)) } : {}) };
        this.forward(message, source.peer, message.operation, source.id, fields);
        return;
      }
      let result: any, inputs: unknown;
      if (message.operation === "get") {
        result = Reflect.get(properties, key!);
        if (typeof result === "function") {
          this.send({ type: "reply", id: message.id, sync: message.sync, ok: true, value: this.ref(this.method(properties, key!, result), String(key)) }); return;
        }
        if (result && typeof result === "object" && !(result instanceof AbortSignal) && this.side === "host") result = this.expose(result);
      } else if (message.operation === "set") result = Reflect.set(properties, key!, this.decode(message.value));
      else if (message.operation === "has") result = Reflect.has(properties, key!);
      else if (message.operation === "keys") result = this.side === "plugin" ? this.publicKeys(properties) : Object.keys(properties);
      else if (message.operation === "apply") {
        const args = this.decode(message.args), remote = forwarded.get(object);
        inputs = args;
        if (remote) {
          this.forward(message, remote.peer, "apply", remote.id, { args: remote.peer.encode(args) });
          return;
        }
        result = object(...args);
      }
      else if (message.operation === "method") {
        const args = this.decode(message.args); inputs = args;
        result = object[key!](...args);
      }
      else throw Error("未知插件接口操作");
      if (result instanceof Promise && inputs !== undefined) {
        this.callInputs.set(message.id, inputs);
        const release = () => { this.callInputs.delete(message.id); };
        void result.then(release, release);
      }
      this.flush(); this.send({ type: "reply", id: message.id, sync: message.sync, ok: true, value: this.encode(result) });
    } catch (error) {
      this.send({ type: "reply", id: message.id, sync: message.sync, ok: false, value: this.encode(Error(messageOf(error))) });
    }
  }
  private forward(message: Packet, peer: PluginRPC, operation: string, id: string, fields: Packet) {
    void peer.initial(operation, id, fields).then((box) => {
      if (this.ended) return;
      const value = operation === "get" && box.value && typeof box.value === "object" && mirroredSources.has(box.value)
        ? this.expose(box.value) : box.value;
      this.send({ type: "reply", id: message.id, sync: message.sync, ok: true, value: this.encode(value) });
    }, (error) => {
      if (!this.ended) this.send({ type: "reply", id: message.id, sync: message.sync, ok: false, value: this.encode(error) });
    }).catch((error) => { if (!this.ended) this.onFault(error instanceof Error ? error : Error(messageOf(error))); });
  }
  close(error = Error("插件已停用")) {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const signal of this.signals.values()) { const value = signal.deref(); if (value) this.signalControllers.get(value)?.abort(error); }
    for (const cleanup of this.signalCleanup.values()) cleanup();
    for (const remote of this.remotes.values()) this.finalizer.unregister(remote);
    this.objects.clear(); this.remotes.clear(); this.signals.clear(); this.published.clear();
    this.signalCleanup.clear(); this.generations.clear(); this.promises.clear(); this.syncResults.clear(); this.callInputs.clear();
  }
}
