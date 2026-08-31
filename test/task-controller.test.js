import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskController } from "../src/core/task-controller.js";
import { JsonStore } from "../src/storage/json-store.js";

class FakeCodex extends EventEmitter {
  constructor() { super(); this.turns = []; this.steers = []; this.forks = []; this.externalThreads = []; }
  async startThread() { return { thread: { id: "thread-1" } }; }
  async resumeThread() {}
  async startTurn(threadId, text) { this.turns.push({ threadId, text }); return { turn: { id: "turn-1" } }; }
  async steerTurn(threadId, turnId, text) { this.steers.push({ threadId, turnId, text }); }
  async listAllThreads() { return this.externalThreads; }
  async readThread(threadId) { return { thread: this.externalThreads.find((thread) => thread.id === threadId) }; }
  async forkThread(threadId) { this.forks.push(threadId); return { thread: { id: `fork-${threadId}` } }; }
  respond() {}
}

function setup() {
  const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-controller-")));
  const codex = new FakeCodex();
  const sent = [];
  const config = {
    defaultProject: "demo",
    projects: { demo: { path: "/tmp/demo", sandbox: "workspace-write", approvalPolicy: "on-request" } },
    security: { ownerOnly: true }, wechat: { sendAcknowledgement: true },
  };
  const controller = new TaskController({ config, credentials: { userId: "owner" }, store, codex, sendText: async (...args) => sent.push(args) });
  controller.start();
  return { controller, codex, store, sent };
}

test("a first message creates a task and a running follow-up steers it", async () => {
  const { controller, codex, store } = setup();
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "build it" } }] });
  assert.equal(codex.turns.length, 1);
  assert.equal(store.read().jobs["1"].status, "running");
  await controller.handleIncoming({ message_id: 2, from_user_id: "owner", context_token: "ctx2", item_list: [{ type: 1, text_item: { text: "also test it" } }] });
  assert.deepEqual(codex.steers[0], { threadId: "thread-1", turnId: "turn-1", text: "also test it" });
});

test("turn completion is pushed back to WeChat", async () => {
  const { controller, codex, store, sent } = setup();
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "build it" } }] });
  codex.emit("notification", "item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", phase: "final_answer", text: "done" } });
  codex.emit("notification", "turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent.at(-1)[1], /任务 #1 已完成/);
  assert.match(sent.at(-1)[1], /done/);
  assert.equal(store.read().inbox.length, 1);
  assert.equal(store.read().inbox[0].readAt, null);
});

test("unread completion messages can be listed, opened, and marked read", async () => {
  const { controller, codex, store, sent } = setup();
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "build it" } }] });
  codex.emit("notification", "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "done" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  await controller.handleIncoming({ message_id: 2, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/unread" } }] });
  assert.match(sent.at(-1)[1], /M1 \[completed\]/);
  await controller.handleIncoming({ message_id: 3, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/unread M1" } }] });
  assert.match(sent.at(-1)[1], /done/);
  assert.ok(store.read().inbox[0].readAt);
  await controller.handleIncoming({ message_id: 4, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/unread" } }] });
  assert.match(sent.at(-1)[1], /没有未读/);
});

test("read all marks every completion message read", async () => {
  const { controller, store, sent } = setup();
  store.update((state) => {
    state.inbox = [
      { id: 1, key: "a", userId: "owner", status: "completed", projectKey: "demo", title: "one", body: "one", readAt: null },
      { id: 2, key: "b", userId: "owner", status: "failed", projectKey: "demo", title: "two", body: "two", readAt: null },
    ];
    state.nextInboxId = 3;
  });
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/read all" } }] });
  assert.match(sent.at(-1)[1], /2 条消息/);
  assert.ok(store.read().inbox.every((item) => item.readAt));
});

test("recent Desktop tasks are discovered and imported as safe forks", async () => {
  const { controller, codex, store, sent } = setup();
  codex.externalThreads = [{
    id: "desktop-1", name: "Fix desktop bug", preview: "", ephemeral: false,
    cwd: "/tmp/demo", source: "vscode", status: { type: "notLoaded" }, updatedAt: 100,
  }];
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/recent" } }] });
  assert.match(sent.at(-1)[1], /C1 \[vscode\] Fix desktop bug/);
  await controller.handleIncoming({ message_id: 2, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/use C1" } }] });
  assert.deepEqual(codex.forks, ["desktop-1"]);
  assert.equal(store.read().jobs["1"].sourceThreadId, "desktop-1");
  assert.equal(store.read().jobs["1"].threadId, "fork-desktop-1");
  assert.match(sent.at(-1)[1], /不会干扰原任务/);
});

test("Desktop tasks outside configured projects are hidden", async () => {
  const { controller, codex, sent } = setup();
  codex.externalThreads = [{
    id: "outside", name: "Secret", preview: "", ephemeral: false,
    cwd: "/tmp/outside", source: "vscode", status: { type: "notLoaded" }, updatedAt: 100,
  }];
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/recent" } }] });
  assert.match(sent.at(-1)[1], /没有其他/);
});

test("active command corrects stale running jobs after an app-server restart", async () => {
  const { controller, codex, store, sent } = setup();
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "build it" } }] });
  codex.externalThreads = [{
    id: "thread-1", name: "build it", preview: "", ephemeral: false,
    cwd: "/tmp/demo", source: "appServer", status: { type: "notLoaded" }, updatedAt: 100,
  }];
  await controller.handleIncoming({ message_id: 2, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/active" } }] });
  assert.equal(store.read().jobs["1"].status, "interrupted");
  assert.match(sent.at(-1)[1], /没有检测到正在运行/);
});

test("active command includes fresh unfinished Desktop or CLI turns with an uncertainty label", async () => {
  const { controller, store, sent } = setup();
  store.update((state) => {
    state.externalMonitor = {
      initialized: true,
      notifiedTurnIds: [],
      pendingNotifications: [],
      threads: {
        "desktop-1": {
          turnId: "turn-live-123", status: "interrupted", completedAt: null,
          pendingTurn: true, title: "Desktop work", projectKey: "demo", source: "vscode",
          updatedAt: 100, lastCheckedAt: new Date().toISOString(),
        },
      },
    };
  });
  await controller.handleIncoming({ message_id: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/active" } }] });
  assert.match(sent.at(-1)[1], /尚未收尾/);
  assert.match(sent.at(-1)[1], /可能运行中或异常退出/);
  assert.match(sent.at(-1)[1], /Desktop work/);
});
