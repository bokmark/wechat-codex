import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig rejects danger-full-access", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-config-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ projects: { bad: { path: dir, sandbox: "danger-full-access" } } }));
  assert.throws(() => loadConfig(configPath), /unsafe\/unknown sandbox/);
});

test("loadConfig provides a current-directory fallback", () => {
  const config = loadConfig(path.join(os.tmpdir(), "does-not-exist-wechat-codex.json"));
  assert.equal(config.projects[config.defaultProject].path, process.cwd());
});

test("loadConfig rejects relative project paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-config-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ projects: { bad: { path: "./relative" } } }));
  assert.throws(() => loadConfig(configPath), /path must be absolute/);
});

test("loadConfig enables external completion monitoring by default", () => {
  const config = loadConfig(path.join(os.tmpdir(), "does-not-exist-wechat-codex-monitor.json"));
  assert.equal(config.externalMonitor.enabled, true);
  assert.equal(config.externalMonitor.intervalMs, 15_000);
  assert.equal(config.externalMonitor.maxThreads, 50);
});
