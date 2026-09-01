import { markInboxRead, markInboxSent, recordInbox, unreadInbox } from "./inbox.js";
import { attachmentCandidates, mergeAttachmentCandidates, resolveAttachments } from "./attachments.js";

const HELP = `微信 Codex 使用指引

1. 新建任务
直接发送要求，例如：帮我检查登录功能并补测试。

2. 继续微信任务
任务完成后直接回复即可继续；也可以发送：
#2 继续完善错误处理

3. 继续 Desktop/CLI 任务
先发送 /recent，找到 C1 等编号；再发送 /use C1。导入后直接回复即可继续安全分支。

4. 查看任务和消息
/tasks       查看微信任务
/active      查看运行中或尚未收尾的任务
/unread      查看未读完成消息
/unread M1   查看消息并标记已读
/read all    全部标记已读

任务完成时，本轮新增的图片会作为图片发送，其他新增文件会作为附件发送。

5. 管理当前任务
/new [项目]  准备新任务
/use 编号    切换任务（支持 2 或 C1）
/status      查看当前状态
/cancel      停止当前运行
/approve A1  允许待审批操作
/deny A1     拒绝待审批操作

随时发送 help、/help 或“帮助”可以再次查看本指引。`;

const MAX_MESSAGE_LENGTH = 1800;

function now() { return new Date().toISOString(); }

function turnStatus(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "running";
}

function extractText(message) {
  const pieces = [];
  for (const item of message.item_list || []) {
    const value = item?.text_item?.text ?? (item?.type === 3 ? item?.voice_item?.text : "");
    if (value) pieces.push(value);
  }
  return pieces.join("\n").trim();
}

export class TaskController {
  constructor({ config, credentials, store, codex, sendText, sendMedia, logger }) {
    this.config = config;
    this.credentials = credentials;
    this.store = store;
    this.codex = codex;
    this.sendText = sendText;
    this.sendMedia = sendMedia;
    this.logger = logger;
    this.loadedThreads = new Set();
    this.pendingApprovals = new Map();
    this.onNotification = this.#onNotification.bind(this);
    this.onServerRequest = this.#onServerRequest.bind(this);
  }

  start() {
    this.codex.on("notification", this.onNotification);
    this.codex.on("serverRequest", this.onServerRequest);
  }

  stop() {
    this.codex.off("notification", this.onNotification);
    this.codex.off("serverRequest", this.onServerRequest);
  }

  async reconcileRunningJobs() {
    const running = Object.values(this.store.read().jobs).filter((job) => job.status === "running");
    if (!running.length) return;
    const threads = await this.codex.listAllThreads({
      archived: false,
      cwd: Object.values(this.config.projects).map((project) => project.path),
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    });
    const statusById = new Map(threads.map((thread) => [thread.id, thread.status?.type]));
    this.store.update((state) => {
      for (const job of running) {
        if (statusById.get(job.threadId) === "active") continue;
        const saved = state.jobs[String(job.id)];
        saved.status = "interrupted";
        saved.error = "桥接器进程已重启，原运行回合不再活跃";
        saved.updatedAt = now();
      }
    });
  }

  async handleIncoming(message) {
    const userId = message.from_user_id;
    if (!userId) return;
    if (this.config.security.ownerOnly && userId !== this.credentials.userId) {
      this.logger?.warn("Ignored message from a non-owner WeChat user");
      return;
    }
    const messageId = String(message.message_id ?? `${userId}:${message.seq ?? "unknown"}`);
    const accepted = this.store.update((state) => {
      if (state.processedMessageIds.includes(messageId)) return false;
      state.processedMessageIds.push(messageId);
      state.processedMessageIds = state.processedMessageIds.slice(-1000);
      if (message.context_token) state.contextTokens[userId] = message.context_token;
      state.sessions[userId] ||= { activeJobId: null, projectKey: this.config.defaultProject };
      return true;
    });
    if (!accepted) return;

    const text = extractText(message);
    if (!text) {
      await this.#send(userId, "目前只支持文字或带文字转写的语音消息。", message.context_token);
      return;
    }
    try {
      await this.#route(userId, text, message.context_token);
    } catch (error) {
      this.logger?.error("Message handling failed", error);
      await this.#send(userId, `操作失败：${error.message}`, message.context_token);
    }
  }

  async #route(userId, text, contextToken) {
    const direct = text.match(/^#(\d+)\s+([\s\S]+)/);
    if (direct) return this.#sendPrompt(userId, direct[2].trim(), Number(direct[1]), contextToken);
    const [command, ...rest] = text.trim().split(/\s+/);
    const argument = rest.join(" ").trim();
    switch (command.toLowerCase()) {
      case "help": case "/help": case "帮助": case "/帮助": return this.#send(userId, HELP, contextToken);
      case "/new": case "/新建": return this.#newSession(userId, argument, contextToken);
      case "/tasks": case "/任务": return this.#listTasks(userId, contextToken);
      case "/active": case "/运行中": return this.#listActive(userId, contextToken);
      case "/recent": case "/最近": return this.#listRecentCodexThreads(userId, contextToken);
      case "/unread": case "/未读": return this.#listUnread(userId, argument, contextToken);
      case "/read": case "/已读": return this.#markRead(userId, argument, contextToken);
      case "/use": case "/切换": return this.#useTask(userId, argument, contextToken);
      case "/status": case "/状态": return this.#status(userId, argument, contextToken);
      case "/cancel": case "/停止": return this.#cancel(userId, argument, contextToken);
      case "/approve": case "/允许": return this.#resolveApproval(userId, argument, true, contextToken);
      case "/deny": case "/拒绝": return this.#resolveApproval(userId, argument, false, contextToken);
      default: return this.#sendPrompt(userId, text, null, contextToken);
    }
  }

  async #newSession(userId, projectKey, contextToken) {
    const chosen = projectKey || this.store.read().sessions[userId]?.projectKey || this.config.defaultProject;
    if (!this.config.projects[chosen]) {
      return this.#send(userId, `未知项目：${chosen}\n可用项目：${Object.keys(this.config.projects).join("、")}`, contextToken);
    }
    this.store.update((state) => { state.sessions[userId] = { activeJobId: null, projectKey: chosen }; });
    await this.#send(userId, `已准备新任务（项目：${chosen}）。直接发送你的要求即可。`, contextToken);
  }

  async #sendPrompt(userId, prompt, requestedJobId, contextToken) {
    let snapshot = this.store.read();
    const session = snapshot.sessions[userId] || { activeJobId: null, projectKey: this.config.defaultProject };
    let job = requestedJobId ? snapshot.jobs[String(requestedJobId)] : snapshot.jobs[String(session.activeJobId)];
    if (job && job.userId !== userId) throw new Error("该任务不属于当前微信用户");
    if (!job) {
      const projectKey = session.projectKey || this.config.defaultProject;
      const project = this.config.projects[projectKey];
      const response = await this.codex.startThread(project);
      const threadId = response.thread.id;
      this.loadedThreads.add(threadId);
      let id;
      this.store.update((state) => {
        id = state.nextJobId++;
        state.jobs[String(id)] = {
          id, userId, projectKey, threadId, turnId: null, status: "ready",
          title: prompt.replace(/\s+/g, " ").slice(0, 42), lastPrompt: "", finalResponse: "", error: "",
          attachmentCandidates: [],
          createdAt: now(), updatedAt: now(),
        };
        state.sessions[userId] = { activeJobId: id, projectKey };
      });
      job = this.store.read().jobs[String(id)];
    }

    const project = this.config.projects[job.projectKey];
    if (job.status === "running" && job.turnId) {
      await this.codex.steerTurn(job.threadId, job.turnId, prompt);
      this.store.update((state) => {
        state.jobs[String(job.id)].lastPrompt = prompt;
        state.jobs[String(job.id)].updatedAt = now();
        state.sessions[userId].activeJobId = job.id;
      });
      if (this.config.wechat.sendAcknowledgement) await this.#send(userId, `已追加到任务 #${job.id}。`, contextToken);
      return;
    }

    if (!this.loadedThreads.has(job.threadId)) {
      await this.codex.resumeThread(job.threadId, project);
      this.loadedThreads.add(job.threadId);
    }
    const response = await this.codex.startTurn(job.threadId, prompt, project);
    this.store.update((state) => {
      const saved = state.jobs[String(job.id)];
      saved.turnId = response.turn.id;
      saved.status = "running";
      saved.lastPrompt = prompt;
      saved.finalResponse = "";
      saved.error = "";
      saved.attachmentCandidates = [];
      saved.updatedAt = now();
      state.sessions[userId].activeJobId = job.id;
    });
    if (this.config.wechat.sendAcknowledgement) await this.#send(userId, `任务 #${job.id} 已开始。`, contextToken);
  }

  async #listTasks(userId, contextToken) {
    const jobs = Object.values(this.store.read().jobs).filter((job) => job.userId === userId).sort((a, b) => b.id - a.id).slice(0, 10);
    if (!jobs.length) return this.#send(userId, "还没有任务。直接发一条要求即可创建。", contextToken);
    const active = this.store.read().sessions[userId]?.activeJobId;
    const lines = jobs.map((job) => `${job.id === active ? "→" : " "} #${job.id} [${job.status}] ${job.title}`);
    await this.#send(userId, lines.join("\n"), contextToken);
  }

  async #listActive(userId, contextToken) {
    await this.reconcileRunningJobs();
    const state = this.store.read();
    const jobs = Object.values(state.jobs)
      .filter((job) => job.userId === userId && job.status === "running")
      .sort((a, b) => b.id - a.id);
    const active = state.sessions[userId]?.activeJobId;
    const bridgeLines = jobs.map((job) => `${job.id === active ? "→" : " "} #${job.id} ${job.title}${job.sourceThreadId ? "（Desktop 分支）" : ""}`);
    const freshnessMs = Math.max(60_000, (this.config.externalMonitor?.intervalMs || 15_000) * 3);
    const external = Object.entries(state.externalMonitor?.threads || {})
      .filter(([, item]) => item.pendingTurn && Date.now() - Date.parse(item.lastCheckedAt) <= freshnessMs)
      .map(([threadId, item]) => ({ threadId, ...item }))
      .sort((a, b) => Date.parse(b.lastCheckedAt) - Date.parse(a.lastCheckedAt));
    const sections = [];
    if (bridgeLines.length) sections.push(`确认正在运行（微信桥接器）：\n${bridgeLines.join("\n")}`);
    if (external.length) {
      const lines = external.map((item) => `• [${item.source}] ${item.title}\n  项目：${item.projectKey}｜回合：${item.turnId?.slice(0, 8) || "未知"}`);
      sections.push(`Desktop/CLI 尚未收尾（可能运行中或异常退出）：\n${lines.join("\n")}`);
    }
    if (!sections.length) return this.#send(userId, "当前没有检测到正在运行或尚未收尾的任务。", contextToken);
    await this.#send(userId, sections.join("\n\n"), contextToken);
  }

  async #listUnread(userId, selector, contextToken) {
    const items = unreadInbox(this.store.read(), userId);
    if (selector) {
      const id = Number(selector.replace(/^M/i, ""));
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return this.#send(userId, `找不到未读消息 ${selector.toUpperCase()}。`, contextToken);
      await this.#send(userId, `M${id}\n${item.body}`, contextToken);
      this.store.update((state) => { markInboxRead(state, userId, id); });
      return;
    }
    if (!items.length) return this.#send(userId, "没有未读的 Codex 完成消息。", contextToken);
    const lines = items.slice(0, 20).map((item) => `M${item.id} [${item.status}] ${item.projectKey}：${item.title}`);
    const more = items.length > 20 ? `\n还有 ${items.length - 20} 条未显示。` : "";
    await this.#send(userId, `未读消息 ${items.length} 条：\n${lines.join("\n")}${more}\n\n发送 /unread M1 查看并标记已读，或 /read all 全部标记。`, contextToken);
  }

  async #markRead(userId, selector, contextToken) {
    const normalized = selector.toLowerCase();
    const target = normalized === "all" || normalized === "全部" ? "all" : Number(normalized.replace(/^m/, ""));
    if (target !== "all" && !Number.isInteger(target)) return this.#send(userId, "用法：/read M1 或 /read all", contextToken);
    let count;
    this.store.update((state) => { count = markInboxRead(state, userId, target); });
    await this.#send(userId, count ? `已将 ${count} 条消息标记为已读。` : "没有匹配的未读消息。", contextToken);
  }

  #projectForCwd(cwd) {
    return Object.entries(this.config.projects).find(([, project]) => project.path === cwd)?.[0] || null;
  }

  async #discoverCodexThreads() {
    const knownThreadIds = new Set(Object.values(this.store.read().jobs).map((job) => job.threadId));
    const threads = await this.codex.listAllThreads({
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      cwd: Object.values(this.config.projects).map((project) => project.path),
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    });
    const external = threads.filter((thread) => !thread.ephemeral && !knownThreadIds.has(thread.id) && this.#projectForCwd(thread.cwd));
    this.store.update((state) => {
      state.externalThreads ||= {};
      state.nextExternalId ||= 1;
      for (const thread of external) {
        const existing = state.externalThreads[thread.id];
        state.externalThreads[thread.id] = {
          alias: existing?.alias || `C${state.nextExternalId++}`,
          threadId: thread.id,
          projectKey: this.#projectForCwd(thread.cwd),
          title: (thread.name || thread.preview || "未命名任务").replace(/\s+/g, " ").slice(0, 60),
          cwd: thread.cwd,
          source: thread.source,
          runtimeStatus: thread.status?.type || "unknown",
          activeFlags: thread.status?.activeFlags || [],
          updatedAt: thread.updatedAt,
          lastSeenAt: now(),
        };
      }
    });
    const saved = this.store.read().externalThreads;
    return external.map((thread) => saved[thread.id]);
  }

  async #listRecentCodexThreads(userId, contextToken) {
    const threads = (await this.#discoverCodexThreads()).slice(0, 10);
    if (!threads.length) {
      return this.#send(userId, "配置项目下没有其他 Codex Desktop/CLI 任务。", contextToken);
    }
    const lines = threads.map((thread) => `${thread.alias} [${thread.source}] ${thread.title}\n   项目：${thread.projectKey}`);
    await this.#send(userId, `最近的 Codex 任务：\n${lines.join("\n")}\n\n回复 /use C1 可创建安全的微信分支；Desktop 原任务不会被改动。`, contextToken);
  }

  async #useTask(userId, value, contextToken) {
    if (/^C\d+$/i.test(value)) return this.#importExternalTask(userId, value.toUpperCase(), contextToken);
    const id = Number(value);
    const job = this.store.read().jobs[String(id)];
    if (!job || job.userId !== userId) return this.#send(userId, "找不到这个任务。", contextToken);
    this.store.update((state) => {
      state.sessions[userId] = { activeJobId: id, projectKey: job.projectKey };
    });
    await this.#send(userId, `已切换到任务 #${id}：${job.title}\n状态：${job.status}`, contextToken);
  }

  async #importExternalTask(userId, alias, contextToken) {
    let state = this.store.read();
    let external = Object.values(state.externalThreads || {}).find((thread) => thread.alias === alias);
    if (!external) {
      await this.#discoverCodexThreads();
      state = this.store.read();
      external = Object.values(state.externalThreads || {}).find((thread) => thread.alias === alias);
    }
    if (!external) return this.#send(userId, `找不到 ${alias}，请先发送 /recent 刷新任务列表。`, contextToken);
    const project = this.config.projects[external.projectKey];
    if (!project || project.path !== external.cwd) return this.#send(userId, `${alias} 不在允许控制的项目范围内。`, contextToken);

    const existing = Object.values(state.jobs).find((job) => job.userId === userId && job.sourceThreadId === external.threadId);
    if (existing) {
      this.store.update((draft) => { draft.sessions[userId] = { activeJobId: existing.id, projectKey: existing.projectKey }; });
      return this.#send(userId, `${alias} 已经导入为任务 #${existing.id}，现已切换。`, contextToken);
    }

    const current = await this.codex.readThread(external.threadId, false);
    if (current.thread.cwd !== project.path) return this.#send(userId, `${alias} 的项目路径已经变化，已拒绝导入。`, contextToken);
    const forked = await this.codex.forkThread(external.threadId, project);
    this.loadedThreads.add(forked.thread.id);
    let id;
    this.store.update((draft) => {
      id = draft.nextJobId++;
      draft.jobs[String(id)] = {
        id, userId, projectKey: external.projectKey, threadId: forked.thread.id,
        sourceThreadId: external.threadId, externalAlias: alias,
        turnId: null, status: "ready", title: external.title,
        lastPrompt: "", finalResponse: "", error: "", attachmentCandidates: [], createdAt: now(), updatedAt: now(),
      };
      draft.sessions[userId] = { activeJobId: id, projectKey: external.projectKey };
    });
    await this.#send(userId, `${alias} 已安全导入为微信任务 #${id}。\n这是原 Desktop/CLI 对话的分支，不会干扰原任务；现在直接回复即可继续。`, contextToken);
  }

  async #status(userId, value, contextToken) {
    if (/^C\d+$/i.test(value)) {
      const external = Object.values(this.store.read().externalThreads || {}).find((thread) => thread.alias === value.toUpperCase());
      if (!external) return this.#send(userId, "找不到这个 Codex 任务，请先发送 /recent。", contextToken);
      return this.#send(userId, `${external.alias}：${external.title}\n项目：${external.projectKey}\n来源：${external.source}\n独立 App Server 状态：${external.runtimeStatus}\n最近更新：${new Date(external.updatedAt * 1000).toISOString()}`, contextToken);
    }
    const state = this.store.read();
    const id = Number(value || state.sessions[userId]?.activeJobId);
    const job = state.jobs[String(id)];
    if (!job || job.userId !== userId) return this.#send(userId, "当前没有可查看的任务。", contextToken);
    const body = [`任务 #${id}：${job.title}`, `项目：${job.projectKey}`, `状态：${job.status}`, `最后更新：${job.updatedAt}`];
    if (job.error) body.push(`错误：${job.error}`);
    await this.#send(userId, body.join("\n"), contextToken);
  }

  async #cancel(userId, value, contextToken) {
    const state = this.store.read();
    const id = Number(value || state.sessions[userId]?.activeJobId);
    const job = state.jobs[String(id)];
    if (!job || job.userId !== userId) return this.#send(userId, "当前没有可停止的任务。", contextToken);
    if (job.status !== "running" || !job.turnId) return this.#send(userId, `任务 #${id} 当前不是运行状态。`, contextToken);
    await this.codex.interruptTurn(job.threadId, job.turnId);
    await this.#send(userId, `已请求停止任务 #${id}。`, contextToken);
  }

  async #resolveApproval(userId, approvalId, accept, contextToken) {
    const key = approvalId.toUpperCase();
    const approval = this.pendingApprovals.get(key);
    if (!approval || approval.userId !== userId) return this.#send(userId, `找不到待审批项 ${key || "（空）"}。`, contextToken);
    this.codex.respond(approval.rpcId, { decision: accept ? "accept" : "decline" });
    this.pendingApprovals.delete(key);
    await this.#send(userId, `${key} 已${accept ? "允许" : "拒绝"}。`, contextToken);
  }

  #jobByThread(threadId) {
    return Object.values(this.store.read().jobs).find((job) => job.threadId === threadId);
  }

  async #onNotification(method, params) {
    try {
      if (method === "thread/status/changed") {
        const job = this.#jobByThread(params.threadId);
        if (job && params.status?.type === "systemError") {
          this.store.update((state) => {
            state.jobs[String(job.id)].status = "failed";
            state.jobs[String(job.id)].error = "Codex thread entered systemError";
            state.jobs[String(job.id)].updatedAt = now();
          });
        }
      }
      if (method === "item/completed" && params.item?.type === "agentMessage" && params.item.phase !== "commentary") {
        const job = this.#jobByThread(params.threadId);
        if (job) this.store.update((state) => {
          state.jobs[String(job.id)].finalResponse = params.item.text || "";
          state.jobs[String(job.id)].updatedAt = now();
        });
      }
      if (method === "item/completed" && ["fileChange", "imageGeneration"].includes(params.item?.type)) {
        const job = this.#jobByThread(params.threadId);
        if (job && (!job.turnId || !params.turnId || params.turnId === job.turnId)) {
          const candidates = attachmentCandidates([params.item]);
          if (candidates.length) this.store.update((state) => {
            const saved = state.jobs[String(job.id)];
            saved.attachmentCandidates = mergeAttachmentCandidates(saved.attachmentCandidates || [], candidates);
            saved.updatedAt = now();
          });
        }
      }
      if (method !== "turn/completed") return;
      const job = this.#jobByThread(params.threadId);
      if (!job || (job.turnId && params.turn?.id !== job.turnId)) return;
      const status = turnStatus(params.turn?.status);
      const savedJob = this.store.read().jobs[String(job.id)] || job;
      let finalResponse = savedJob.finalResponse || "";
      const candidates = mergeAttachmentCandidates(
        savedJob.attachmentCandidates || [],
        attachmentCandidates(params.turn?.items || []),
      );
      for (const item of params.turn?.items || []) {
        if (item.type === "agentMessage" && item.phase !== "commentary") finalResponse = item.text || finalResponse;
      }
      const error = params.turn?.error?.message || params.turn?.error || "";
      this.store.update((state) => {
        const saved = state.jobs[String(job.id)];
        saved.status = status;
        saved.finalResponse = finalResponse;
        saved.error = typeof error === "string" ? error : JSON.stringify(error);
        saved.attachmentCandidates = [];
        saved.updatedAt = now();
      });
      const prefix = status === "completed" ? `任务 #${job.id} 已完成` : status === "interrupted" ? `任务 #${job.id} 已停止` : `任务 #${job.id} 失败`;
      const details = finalResponse || (error ? `错误：${typeof error === "string" ? error : JSON.stringify(error)}` : "没有返回文字结果。");
      const body = `${prefix}\n\n${details}`;
      const inboxKey = `bridge:${job.threadId}:${params.turn?.id}`;
      this.store.update((state) => {
        recordInbox(state, {
          key: inboxKey, userId: job.userId, source: "wechat", threadId: job.threadId,
          turnId: params.turn?.id, jobId: job.id, status, title: job.title,
          projectKey: job.projectKey, body: body.slice(0, 6000),
        });
      });
      await this.#send(job.userId, body);
      this.store.update((state) => { markInboxSent(state, inboxKey); });
      if (status === "completed") await this.#sendAttachments(job.userId, job.projectKey, candidates);
    } catch (error) {
      this.logger?.error("Codex notification handling failed", error);
    }
  }

  async #onServerRequest(request) {
    try {
      const supported = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
      if (!supported.has(request.method)) {
        this.codex.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
        return;
      }
      const job = this.#jobByThread(request.params?.threadId);
      if (!job) {
        this.codex.respond(request.id, { decision: "decline" });
        return;
      }
      let approvalId;
      this.store.update((state) => { approvalId = `A${state.nextApprovalId++}`; });
      this.pendingApprovals.set(approvalId, { rpcId: request.id, userId: job.userId, jobId: job.id });
      const reason = request.params?.reason || request.params?.command || request.params?.changes?.join("\n") || request.method;
      await this.#send(job.userId, `任务 #${job.id} 请求审批 ${approvalId}\n${String(reason).slice(0, 1200)}\n\n回复 /approve ${approvalId} 或 /deny ${approvalId}`);
    } catch (error) {
      this.logger?.error("Approval handling failed", error);
      this.codex.respond(request.id, { decision: "decline" });
    }
  }

  async #send(userId, text, contextToken) {
    const token = contextToken || this.store.read().contextTokens[userId] || "";
    const chunks = [];
    let remaining = String(text);
    while (remaining.length > MAX_MESSAGE_LENGTH) {
      let split = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (split < MAX_MESSAGE_LENGTH / 2) split = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, split));
      remaining = remaining.slice(split).replace(/^\n/, "");
    }
    if (remaining) chunks.push(remaining);
    for (const chunk of chunks) await this.sendText(userId, chunk, token);
  }

  async #sendAttachments(userId, projectKey, candidates) {
    const options = this.config.wechat?.attachments;
    if (!this.sendMedia || options?.enabled === false || !candidates.length) return;
    const project = this.config.projects[projectKey];
    if (!project) return;
    let resolved;
    try {
      resolved = await resolveAttachments(candidates, project.path, options);
    } catch (error) {
      this.logger?.warn("任务附件检查失败", error.message);
      await this.#send(userId, `附件未发送：${error.message}`);
      return;
    }
    const token = this.store.read().contextTokens[userId] || "";
    const failed = [];
    for (const attachment of resolved.attachments) {
      try {
        await this.sendMedia(userId, attachment.path, token, attachment.kind);
      } catch (error) {
        this.logger?.warn(`附件发送失败：${attachment.name}`, error.message);
        failed.push({ path: attachment.name, reason: error.message });
      }
    }
    const omitted = [...resolved.skipped, ...failed];
    if (omitted.length) {
      const lines = omitted.slice(0, 10).map((item) => `• ${String(item.path).split(/[\\/]/).at(-1)}：${item.reason}`);
      await this.#send(userId, `以下附件未发送：\n${lines.join("\n")}`);
    }
  }
}

export { extractText };
