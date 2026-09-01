import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExternalTaskMonitor } from "../src/core/external-task-monitor.js";
import { JsonStore } from "../src/storage/json-store.js";

function setup({ projectPath = "/tmp/demo" } = {}) {
  const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-monitor-")));
  store.update((state) => { state.contextTokens.owner = "ctx"; });
  const codex = {
    threads: [],
    turns: new Map(),
    async listAllThreads() { return this.threads; },
    async listThreadTurns(threadId) { return { data: this.turns.has(threadId) ? [this.turns.get(threadId)] : [] }; },
  };
  const sent = [];
  const media = [];
  const config = {
    projects: { demo: { path: projectPath } },
    wechat: { attachments: { enabled: true, maxFiles: 5, maxFileBytes: 20 * 1024 * 1024 } },
    externalMonitor: { enabled: true, intervalMs: 5_000, maxThreads: 50, notifyInterrupted: true },
  };
  const monitor = new ExternalTaskMonitor({
    config, credentials: { userId: "owner" }, store, codex,
    sendText: async (...args) => sent.push(args),
    sendMedia: async (...args) => media.push(args),
  });
  return { monitor, codex, store, sent, media };
}

function thread(updatedAt = 1) {
  return { id: "desktop-1", name: "Desktop work", preview: "", cwd: "/tmp/demo", source: "vscode", ephemeral: false, updatedAt };
}

function turn(id, status, completedAt, text = "done") {
  return { id, status, completedAt, error: null, items: [{ type: "agentMessage", phase: "final_answer", text }] };
}

test("baseline suppresses history and a later completed turn is pushed", async () => {
  const { monitor, codex, sent, store } = setup();
  codex.threads = [thread(1)];
  codex.turns.set("desktop-1", turn("old", "completed", 10, "old result"));
  await monitor.initialize();
  assert.equal(sent.length, 0);
  assert.ok(store.read().externalMonitor.notifiedTurnIds.includes("old"));

  codex.threads = [thread(2)];
  codex.turns.set("desktop-1", turn("new", "completed", 20, "new result"));
  await monitor.scanOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Desktop work/);
  assert.match(sent[0][1], /new result/);
  assert.ok(store.read().externalMonitor.notifiedTurnIds.includes("new"));
  assert.equal(store.read().inbox.length, 1);
  assert.equal(store.read().inbox[0].readAt, null);
  assert.ok(store.read().inbox[0].sentAt);
});

test("an externally active turn is polled until completed even when updatedAt is unchanged", async () => {
  const { monitor, codex, sent } = setup();
  codex.threads = [thread(1)];
  // A separate app-server can render an unfinished external turn as interrupted,
  // but completedAt remains null, which is the reliable pending signal.
  codex.turns.set("desktop-1", turn("live", "interrupted", null, ""));
  await monitor.initialize();
  codex.turns.set("desktop-1", turn("live", "completed", 30, "finished later"));
  await monitor.scanOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /finished later/);
});

test("completion waits in a durable queue until WeChat has a context token", async () => {
  const { monitor, codex, sent, store } = setup();
  store.update((state) => { delete state.contextTokens.owner; });
  await monitor.initialize();
  codex.threads = [thread(2)];
  codex.turns.set("desktop-1", turn("queued", "completed", 40));
  await monitor.scanOnce();
  assert.equal(sent.length, 0);
  assert.equal(store.read().externalMonitor.pendingNotifications.length, 1);
  assert.equal(store.read().inbox.length, 1);
  assert.equal(store.read().inbox[0].sentAt, null);

  store.update((state) => { state.contextTokens.owner = "ctx"; });
  await monitor.scanOnce();
  assert.equal(sent.length, 1);
  assert.equal(store.read().externalMonitor.pendingNotifications.length, 0);
  assert.ok(store.read().inbox[0].sentAt);
});

test("a completed Desktop task sends its newly added image", async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-monitor-project-"));
  fs.writeFileSync(path.join(projectPath, "result.png"), "image");
  const { monitor, codex, media } = setup({ projectPath });
  codex.threads = [{ ...thread(1), cwd: projectPath }];
  codex.turns.set("desktop-1", turn("old", "completed", 10, "old"));
  await monitor.initialize();

  codex.threads = [{ ...thread(2), cwd: projectPath }];
  const completed = turn("new-image", "completed", 20, "done");
  completed.items.push({
    type: "fileChange",
    status: "completed",
    changes: [{ path: "result.png", kind: { type: "add" } }],
  });
  codex.turns.set("desktop-1", completed);
  await monitor.scanOnce();

  assert.deepEqual(media.map((args) => [path.basename(args[1]), args[3]]), [["result.png", "image"]]);
});
