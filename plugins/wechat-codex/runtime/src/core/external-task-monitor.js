import { markInboxSent, recordInbox } from "./inbox.js";

const MAX_MESSAGE_LENGTH = 1800;
const MAX_NOTIFIED_TURNS = 2000;

const sleep = (ms, signal) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

function terminal(turn, notifyInterrupted) {
  if (!turn || turn.completedAt == null) return false;
  if (turn.status === "completed" || turn.status === "failed") return true;
  return notifyInterrupted && turn.status === "interrupted";
}

function finalAgentText(turn) {
  let text = "";
  for (const item of turn?.items || []) {
    if (item.type === "agentMessage" && item.phase !== "commentary" && item.text) text = item.text;
  }
  return text;
}

function taskTitle(thread) {
  return (thread.name || thread.preview || "未命名任务").replace(/\s+/g, " ").slice(0, 80);
}

function statusLabel(status) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "interrupted") return "已停止";
  return status;
}

export class ExternalTaskMonitor {
  constructor({ config, credentials, store, codex, sendText, logger }) {
    this.config = config;
    this.credentials = credentials;
    this.store = store;
    this.codex = codex;
    this.sendText = sendText;
    this.logger = logger;
  }

  async initialize() {
    if (!this.config.externalMonitor.enabled) return;
    const monitor = this.#monitorState();
    if (monitor.initialized) return;
    const threads = await this.#listExternalThreads();
    for (const thread of threads) await this.#inspect(thread, true);
    this.store.update((state) => { this.#ensureState(state).initialized = true; });
    this.logger?.info(`Desktop/CLI 完成监控基线已建立（${threads.length} 个任务）`);
  }

  async run(signal) {
    if (!this.config.externalMonitor.enabled) return;
    while (!signal?.aborted && !this.#monitorState().initialized) {
      try {
        await this.initialize();
      } catch (error) {
        this.logger?.warn("Desktop/CLI 完成监控初始化失败，将自动重试", error.message);
        await sleep(this.config.externalMonitor.intervalMs, signal);
      }
    }
    while (!signal?.aborted) {
      try {
        await this.scanOnce();
      } catch (error) {
        if (!signal?.aborted) this.logger?.warn("Desktop/CLI 完成监控失败，将自动重试", error.message);
      }
      await sleep(this.config.externalMonitor.intervalMs, signal);
    }
  }

  async scanOnce() {
    await this.#flushPending();
    const threads = await this.#listExternalThreads();
    const state = this.#monitorState();
    for (const thread of threads) {
      const previous = state.threads[thread.id];
      if (previous && previous.updatedAt === thread.updatedAt && !previous.pendingTurn) continue;
      await this.#inspect(thread, false);
    }
    await this.#flushPending();
  }

  async #listExternalThreads() {
    const bridgeThreadIds = new Set(Object.values(this.store.read().jobs).map((job) => job.threadId));
    const threads = await this.codex.listAllThreads({
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      cwd: Object.values(this.config.projects).map((project) => project.path),
      sourceKinds: ["cli", "vscode", "exec", "unknown"],
    }, this.config.externalMonitor.maxThreads);
    return threads.filter((thread) => !thread.ephemeral && !bridgeThreadIds.has(thread.id) && this.#projectForCwd(thread.cwd));
  }

  async #inspect(thread, baseline) {
    let response;
    try {
      response = await this.codex.listThreadTurns(thread.id, { limit: 1, sortDirection: "desc", itemsView: "full" });
    } catch (error) {
      this.logger?.debug(`无法读取外部任务 ${thread.id} 的回合`, error.message);
      return;
    }
    const turn = response.data?.[0];
    const isTerminal = terminal(turn, this.config.externalMonitor.notifyInterrupted);
    const alreadyNotified = turn && this.#monitorState().notifiedTurnIds.includes(turn.id);
    this.store.update((state) => {
      const monitor = this.#ensureState(state);
      monitor.threads[thread.id] = {
        turnId: turn?.id || null,
        status: turn?.status || null,
        completedAt: turn?.completedAt ?? null,
        updatedAt: thread.updatedAt,
        pendingTurn: Boolean(turn && turn.completedAt == null),
        title: taskTitle(thread),
        projectKey: this.#projectForCwd(thread.cwd),
        source: thread.source,
        lastCheckedAt: new Date().toISOString(),
      };
      if (baseline && isTerminal && !monitor.notifiedTurnIds.includes(turn.id)) {
        monitor.notifiedTurnIds.push(turn.id);
        monitor.notifiedTurnIds = monitor.notifiedTurnIds.slice(-MAX_NOTIFIED_TURNS);
      }
    });
    if (!baseline && isTerminal && !alreadyNotified) this.#queueNotification(thread, turn);
  }

  #queueNotification(thread, turn) {
    const key = `${thread.id}:${turn.id}`;
    const projectKey = this.#projectForCwd(thread.cwd);
    const finalText = finalAgentText(turn);
    const error = turn.error?.message || "";
    const details = finalText || (error ? `错误：${error}` : "没有文字结果，可在 Codex 中打开任务查看详情。");
    const text = `Codex ${thread.source === "exec" ? "CLI" : "Desktop/CLI"} 任务${statusLabel(turn.status)}\n\n项目：${projectKey}\n任务：${taskTitle(thread)}\n状态：${turn.status}\n\n${details}`;
    this.store.update((state) => {
      const monitor = this.#ensureState(state);
      if (monitor.pendingNotifications.some((item) => item.key === key) || monitor.notifiedTurnIds.includes(turn.id)) return;
      monitor.pendingNotifications.push({ key, threadId: thread.id, turnId: turn.id, text, createdAt: new Date().toISOString() });
      recordInbox(state, {
        key,
        userId: this.credentials.userId,
        source: thread.source === "exec" ? "cli" : "desktop",
        threadId: thread.id,
        turnId: turn.id,
        status: turn.status,
        title: taskTitle(thread),
        projectKey,
        body: text.slice(0, 6000),
      });
    });
  }

  async #flushPending() {
    const userId = this.credentials.userId;
    const snapshot = this.store.read();
    const token = snapshot.contextTokens[userId];
    if (!token) return;
    for (const item of this.#monitorState().pendingNotifications) {
      try {
        await this.#send(userId, item.text, token);
        this.store.update((state) => {
          const monitor = this.#ensureState(state);
          monitor.pendingNotifications = monitor.pendingNotifications.filter((pending) => pending.key !== item.key);
          if (!monitor.notifiedTurnIds.includes(item.turnId)) monitor.notifiedTurnIds.push(item.turnId);
          monitor.notifiedTurnIds = monitor.notifiedTurnIds.slice(-MAX_NOTIFIED_TURNS);
          markInboxSent(state, item.key);
        });
      } catch (error) {
        this.logger?.warn("外部任务完成消息发送失败，将稍后重试", error.message);
        break;
      }
    }
  }

  async #send(userId, text, token) {
    let remaining = String(text);
    while (remaining) {
      let split = Math.min(MAX_MESSAGE_LENGTH, remaining.length);
      if (remaining.length > MAX_MESSAGE_LENGTH) {
        const newline = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
        if (newline >= MAX_MESSAGE_LENGTH / 2) split = newline;
      }
      await this.sendText(userId, remaining.slice(0, split), token);
      remaining = remaining.slice(split).replace(/^\n/, "");
    }
  }

  #projectForCwd(cwd) {
    return Object.entries(this.config.projects).find(([, project]) => project.path === cwd)?.[0] || null;
  }

  #monitorState() { return this.#ensureState(this.store.read()); }

  #ensureState(state) {
    state.externalMonitor ||= {};
    state.externalMonitor.initialized ??= false;
    state.externalMonitor.threads ||= {};
    state.externalMonitor.notifiedTurnIds ||= [];
    state.externalMonitor.pendingNotifications ||= [];
    return state.externalMonitor;
  }
}

export { finalAgentText, terminal };
