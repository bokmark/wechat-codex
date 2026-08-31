import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexAppServerClient extends EventEmitter {
  constructor({ codexPath = "codex", logger, spawnFn = spawn } = {}) {
    super();
    this.codexPath = codexPath;
    this.logger = logger;
    this.spawnFn = spawnFn;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    if (this.process) return;
    const child = this.spawnFn(this.codexPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (data) => this.logger?.debug(`codex: ${String(data).trimEnd()}`));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      this.process = null;
      this.#failAll(new Error(`codex app-server exited (${code ?? signal})`));
      this.emit("exit", { code, signal });
    });
    await this.request("initialize", {
      clientInfo: { name: "wechat-codex", title: "WeChat Codex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch {
      this.logger?.warn("Ignored non-JSON Codex output", line.slice(0, 300));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      message.error ? pending.reject(new Error(message.error.message || JSON.stringify(message.error))) : pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
    } else if (message.method) {
      this.emit("notification", message.method, message.params || {});
      this.emit(message.method, message.params || {});
    }
  }

  #write(message) {
    if (!this.process?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.#write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }

  startThread(project) {
    return this.request("thread/start", {
      cwd: project.path, sandbox: project.sandbox, approvalPolicy: project.approvalPolicy, approvalsReviewer: "user",
    });
  }

  resumeThread(threadId, project) {
    return this.request("thread/resume", {
      threadId, cwd: project.path, sandbox: project.sandbox, approvalPolicy: project.approvalPolicy, approvalsReviewer: "user",
    });
  }

  listThreads(params = {}) { return this.request("thread/list", params); }

  async listAllThreads(params = {}, maxThreads = 500) {
    const data = [];
    let cursor = null;
    do {
      const response = await this.listThreads({ ...params, cursor, limit: Math.min(100, maxThreads - data.length) });
      data.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor && data.length < maxThreads);
    return data;
  }

  readThread(threadId, includeTurns = false) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  listThreadTurns(threadId, { limit = 1, sortDirection = "desc", itemsView = "full" } = {}) {
    return this.request("thread/turns/list", { threadId, limit, sortDirection, itemsView });
  }

  forkThread(threadId, project) {
    return this.request("thread/fork", {
      threadId,
      cwd: project.path,
      sandbox: project.sandbox,
      approvalPolicy: project.approvalPolicy,
      approvalsReviewer: "user",
    });
  }

  startTurn(threadId, text, project) {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: project.path,
      approvalPolicy: project.approvalPolicy,
    });
  }

  steerTurn(threadId, turnId, text) {
    return this.request("turn/steer", {
      threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }],
    });
  }

  interruptTurn(threadId, turnId) { return this.request("turn/interrupt", { threadId, turnId }); }

  #failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async stop() {
    if (!this.process) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.process = null;
  }
}
